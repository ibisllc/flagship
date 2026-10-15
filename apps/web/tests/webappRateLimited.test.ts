// flagshipserver.com's 429 `{ error: "rate-limited", limit, retryAfterSec,
// message }`: the webapp words it itself (lib/rateLimited.js), the same way as
// the Worker, and every screen that calls a rate-limited endpoint shows it.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rateLimitedMessage as serverMessage } from "../../com/src/rateLimit.js";

const webapp = (...p: string[]) => resolve(__dirname, "..", "public", "webapp", ...p);
const load = (...p: string[]) => import(pathToFileURL(webapp(...p)).href);

function limited(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: "rate-limited", endpoint: "username-claim", ...body }), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("rate-limited wording", () => {
  it("names who is limited on each axis", async () => {
    const { rateLimitedMessage } = await load("lib", "rateLimited.js");
    expect(rateLimitedMessage("ip", 720)).toBe("Too many tries from your network. Try again in about 12 minutes.");
    expect(rateLimitedMessage("irk", 720)).toBe("Too many tries from this account. Try again in about 12 minutes.");
    expect(rateLimitedMessage("usernameHash", 720)).toBe(
      "Too many tries for this account name. Try again in about 12 minutes.",
    );
  });

  it("rounds the wait at the minute and hour boundaries", async () => {
    const { retryAfterPhrase } = await load("lib", "rateLimited.js");
    expect(retryAfterPhrase(0)).toBe("in a minute");
    expect(retryAfterPhrase(59)).toBe("in a minute");
    expect(retryAfterPhrase(60)).toBe("in about 1 minute");
    expect(retryAfterPhrase(61)).toBe("in about 2 minutes");
    expect(retryAfterPhrase(3540)).toBe("in about 59 minutes");
    expect(retryAfterPhrase(3541)).toBe("in about 1 hour");
    expect(retryAfterPhrase(3600)).toBe("in about 1 hour");
    expect(retryAfterPhrase(5340)).toBe("in about 1 hour");
    expect(retryAfterPhrase(5400)).toBe("in about 2 hours");
    expect(retryAfterPhrase(86_400)).toBe("in about 24 hours");
  });

  it("matches the Worker's sentence word for word", async () => {
    const { rateLimitedMessage } = await load("lib", "rateLimited.js");
    for (const axis of ["ip", "irk", "usernameHash"] as const) {
      for (const sec of [1, 30, 59, 60, 61, 119, 120, 900, 3540, 3541, 3600, 5399, 5400, 7200, 86_400]) {
        expect(rateLimitedMessage(axis, sec)).toBe(serverMessage(axis, sec));
      }
    }
  });

  it("falls back to the body's message, then to a plain sentence", async () => {
    const { RateLimitedError, RATE_LIMITED_FALLBACK } = await load("lib", "rateLimited.js");
    expect(new RateLimitedError({ limit: "ip", retryAfterSec: 90, message: "ignored" }).message).toBe(
      "Too many tries from your network. Try again in about 2 minutes.",
    );
    expect(new RateLimitedError({ retryAfterSec: 90, message: "Server says wait." }).message).toBe("Server says wait.");
    expect(new RateLimitedError({ limit: "ip", message: "Server says wait." }).message).toBe("Server says wait.");
    expect(new RateLimitedError({ limit: "nope", retryAfterSec: 90 }).message).toBe(RATE_LIMITED_FALLBACK);
    expect(new RateLimitedError({}).message).toBe("Too many tries. Try again later.");
    expect(new RateLimitedError({ limit: "irk" }, "3600").message).toBe(
      "Too many tries from this account. Try again in about 1 hour.",
    );
  });

  it("recognises only the rate limiter's 429, leaving other 429s readable", async () => {
    const { rateLimitedFromResponse } = await load("lib", "rateLimited.js");
    const err = await rateLimitedFromResponse(limited({ limit: "ip", retryAfterSec: 720 }));
    expect(err).toMatchObject({
      rateLimited: true,
      status: 429,
      code: "rate-limited",
      endpoint: "username-claim",
      limit: "ip",
      retryAfterSec: 720,
      message: "Too many tries from your network. Try again in about 12 minutes.",
    });

    const usedUp = new Response(JSON.stringify({ code: "free-ai-used-up" }), { status: 429 });
    expect(await rateLimitedFromResponse(usedUp)).toBeNull();
    expect(await usedUp.json()).toEqual({ code: "free-ai-used-up" });
    const cooldown = new Response(JSON.stringify({ error: "regenerating too fast", retryAfterMs: 3000 }), { status: 429 });
    expect(await rateLimitedFromResponse(cooldown)).toBeNull();
    expect(await rateLimitedFromResponse(new Response("not json", { status: 429 }))).toBeNull();
    expect(await rateLimitedFromResponse(new Response(JSON.stringify({ error: "rate-limited" }), { status: 200 }))).toBeNull();
  });

  it("humanError shows the sentence, and a bare 429 keeps the generic copy", async () => {
    const { humanError } = await load("lib", "humanError.js");
    const { RateLimitedError } = await load("lib", "rateLimited.js");
    expect(humanError(new RateLimitedError({ limit: "usernameHash", retryAfterSec: 30 }))).toBe(
      "Too many tries for this account name. Try again in a minute.",
    );
    expect(humanError(429)).toMatch(/didn't work/i);
  });
});

describe("the .com fetch chokepoint", () => {
  it("rejects a rate-limited .com answer with the sentence and passes everything else through", async () => {
    const cf = await load("lib", "comFetch.js");
    const original = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/username/claim")) return limited({ limit: "ip", retryAfterSec: 720 });
      return new Response(JSON.stringify({ code: "free-ai-used-up" }), { status: 429 });
    }) as typeof fetch;
    cf.installComFetchGuard();
    try {
      await expect(fetch("https://flagshipserver.com/api/username/claim", { method: "POST" })).rejects.toMatchObject({
        rateLimited: true,
        message: "Too many tries from your network. Try again in about 12 minutes.",
      });
      const other = await fetch("https://flagshipserver.com/api/free-ai/token", { method: "POST" });
      expect(other.status).toBe(429);
      expect(await other.json()).toEqual({ code: "free-ai-used-up" });
      await expect(cf.comFetch("/api/username/claim", { method: "POST" })).rejects.toMatchObject({ rateLimited: true });
    } finally {
      cf.uninstallComFetchGuard();
      globalThis.fetch = original;
    }
  });
});

describe("screens show the rate-limited sentence", () => {
  const session = {
    umk: new Uint8Array(32).fill(9),
    irk: { publicKey: new Uint8Array(32).fill(2) },
    adminRootSeed: new Uint8Array(32).fill(7),
  };
  const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

  it("account creation and the username claim reject with it, not 'claim failed (429)'", async () => {
    const { openAccount, claimUsername } = await load("lib", "openAccount.js");
    const fetch = vi.fn(async () => limited({ limit: "irk", retryAfterSec: 45 }));
    const sentence = "Too many tries from this account. Try again in a minute.";
    await expect(
      claimUsername("jolly-ranger", session.irk.publicKey, async () => new Uint8Array(64), { fetch, bytesToHex: toHex }),
    ).rejects.toThrow(sentence);
    await expect(
      openAccount("jolly-ranger", {
        session,
        fetch,
        bytesToHex: toHex,
        accountDisplayName: "Johnson Family",
        deviceDisplayName: "This browser",
        signWithIrk: async () => new Uint8Array(64).fill(1),
        ensureAdminRoot: async () => "aa".repeat(32),
        deriveAccountDeviceKeyFromSeed: async () => ({ privateKey: {}, publicKey: new Uint8Array(32).fill(3) }),
        deriveAccountIdFromSeed: async () => ({ publicKey: new Uint8Array(32).fill(4) }),
        signWithAdminRoot: async () => new Uint8Array(64).fill(5),
        signWithDevice: async () => new Uint8Array(64).fill(6),
        generateDeviceId: () => "00112233445566778899aabbccddeeff",
        randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).rejects.toThrow(sentence);
  });

  it("sign-in's account lookup and the device admit reject with it", async () => {
    const { resolveAccount } = await load("lib", "accountResolve.js");
    const { postDeviceAdmit } = await load("lib", "crossDevicePairing.js");
    const { failureText } = await load("lib", "rateLimited.js");
    const fetch = async () => limited({ limit: "ip", retryAfterSec: 7200 });
    const sentence = "Too many tries from your network. Try again in about 2 hours.";
    const lookup = await resolveAccount("jolly-ranger", { fetch, baseUrl: "https://flagshipserver.com" }).catch((e: Error) => e);
    expect(lookup.message).toBe(sentence);
    expect(failureText(lookup, "Couldn't reach the directory: ")).toBe(sentence);
    expect(failureText(new Error("boom"), "Couldn't reach the directory: ")).toBe("Couldn't reach the directory: boom");
    await expect(
      postDeviceAdmit({ username: "jolly-ranger", admit: {}, admitSigHex: "", request: {}, signatureHex: "", fetch }),
    ).rejects.toThrow(sentence);
  });

  it("recovery's re-pair rejects with it instead of a network or server error", async () => {
    const { initiateRePair } = await load("lib", "loginTakeover.js");
    const fetch = async () => limited({ endpoint: "re-pair-initiate", limit: "usernameHash", retryAfterSec: 900 });
    await expect(
      initiateRePair({
        username: "jolly-ranger",
        newIrkPubHex: "11".repeat(32),
        oldIrkPubHex: "22".repeat(32),
        signHex: "33".repeat(64),
        fetch,
        baseUrl: "https://flagshipserver.com",
      }),
    ).rejects.toThrow("Too many tries for this account name. Try again in about 15 minutes.");
  });

  it("Replace device says it whether the 429 is returned or thrown by the chokepoint", async () => {
    const { runReplaceDeviceCeremony } = await load("lib", "replaceDeviceCeremony.js");
    const { RateLimitedError } = await load("lib", "rateLimited.js");
    const umk = new Uint8Array(32).fill(5);
    const sentence = "Too many tries from your network. Try again in about 5 minutes.";
    const body = { endpoint: "re-pair-initiate", limit: "ip", retryAfterSec: 300 };
    const returned = async () => limited(body);
    const thrown = async () => {
      throw new RateLimitedError(body);
    };
    for (const fetch of [returned, thrown]) {
      const err = await runReplaceDeviceCeremony(
        { username: "jolly-ranger", umk, currentVersion: 1, ifMatch: null },
        { fetch, origin: "https://flagshipserver.com" },
      ).catch((e: Error) => e);
      expect(err).toMatchObject({ rateLimited: true, message: sentence });
    }
  });

  it("the Flagship Inference entry in Settings and the AI-key step say when to try again", async () => {
    const { freeAiCardHtml } = await load("views", "settings.js");
    const { freeAiRowState } = await load("views", "build-key.js");
    const status = {
      available: false,
      ended: false,
      rateLimited: true,
      reason: null,
      message: "Too many tries from this account. Try again in about 3 minutes.",
      credits: null,
    };
    const html = freeAiCardHtml(status);
    expect(html).toContain("Too many tries from this account. Try again in about 3 minutes.");
    expect(html).not.toContain("isn't available right now");
    expect(html).toContain('id="free-ai-add-key"');
    expect(freeAiRowState(status)).toEqual({ kind: "blocked", text: status.message });
  });
});
