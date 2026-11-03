import { describe, expect, it } from "vitest";
import {
  ed,
  signVoiciShorten,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleVoiciShorten,
  mintShortLink,
  resolveVoiciPath,
} from "../src/voici.js";

const USER = "alice";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function seed(s: InMemoryStorage, irk: Keypair) {
  await s.usernames.put({
    username: USER,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: 1,
  });
}

describe("mintShortLink (internal)", () => {
  it("returns a 6-char code, a digit first, by default (D2, D3)", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, now: () => 1000 },
      { username: USER, targetUrl: "https://example.com/page" },
    );
    expect("error" in r).toBe(false);
    if ("code" in r) {
      expect(r.code).toMatch(/^[0-9][a-z0-9]{5}$/);
      expect(r.shortUrl).toBe(`https://voi.ci/${r.code}`);
    }
  });

  it("rejects non-https targets (no javascript: smuggling)", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      { username: USER, targetUrl: "javascript:alert(1)" },
    );
    expect("error" in r).toBe(true);
  });

  it("rejects malformed usernames", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      { username: "BAD..NAME", targetUrl: "https://example.com/" },
    );
    expect("error" in r).toBe(true);
  });

  it("respects deps.shortHost when formatting the returned URL", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, shortHost: "staging.voi.ci" },
      { username: USER, targetUrl: "https://example.com/" },
    );
    if ("code" in r) {
      expect(r.shortUrl).toBe(`https://staging.voi.ci/${r.code}`);
    }
  });

  it("respects deps.codeLength", async () => {
    const s = new InMemoryStorage();
    const r = await mintShortLink(
      { usernames: s.usernames, voiciLinks: s.voiciLinks, codeLength: 8 },
      { username: USER, targetUrl: "https://example.com/" },
    );
    if ("code" in r) {
      expect(r.code).toMatch(/^[0-9][a-z0-9]{7}$/);
    }
  });
});

describe("resolveVoiciPath for codes", () => {
  const resolve = (s: InMemoryStorage, path: string, extra: object = {}) =>
    resolveVoiciPath({ names: s.names, pages: s.voici, now: () => 1000, ...extra }, path);

  it("302s with the target URL on a hit", async () => {
    const s = new InMemoryStorage();
    await s.voiciLinks.insert({ code: "1bc123", username: USER, targetUrl: "https://example.com/landing", createdAt: 1 });
    expect(await resolve(s, "/1bc123")).toEqual({ kind: "link", target: "https://example.com/landing" });
  });

  it("sends an app's link to the box that runs the app now, and a one-off link where it was minted", async () => {
    const s = new InMemoryStorage();
    await s.voiciLinks.insert({ code: "4pp123", username: USER, serviceId: "alice--family", targetUrl: "https://family.home.alice.flagship.services", createdAt: 1 });
    await s.voiciLinks.insert({ code: "0ne123", username: USER, targetUrl: "https://example.com/x", createdAt: 1 });
    const asked: string[] = [];
    const appUrl = { resolveAppUrl: async (u: string, id: string) => (asked.push(`${u}/${id}`), "https://family.work.alice.flagship.services") };
    expect(await resolve(s, "/4pp123", appUrl)).toEqual({ kind: "link", target: "https://family.work.alice.flagship.services" });
    expect(await resolve(s, "/0ne123", appUrl)).toEqual({ kind: "link", target: "https://example.com/x" });
    expect(asked).toEqual(["alice/alice--family"]);
    expect(await resolve(s, "/4pp123", { resolveAppUrl: async () => null })).toEqual({ kind: "link", target: "https://family.home.alice.flagship.services" });
  });

  it("404s on a miss, 410s on an expired one-off (the rotated-link case)", async () => {
    const s = new InMemoryStorage();
    await s.voiciLinks.insert({ code: "5tale1", username: USER, targetUrl: "https://example.com/", createdAt: 1, expiresAt: 100 });
    expect(await resolve(s, "/n0pe42")).toEqual({ kind: "not-found" });
    expect(await resolve(s, "/5tale1")).toEqual({ kind: "gone" });
  });

  it("never reads a path with more than one segment (no path traversal)", async () => {
    const s = new InMemoryStorage();
    expect(await resolve(s, "/../../etc/passwd")).toEqual({ kind: "not-found" });
    expect(await resolve(s, "/a/b")).toEqual({ kind: "not-found" });
  });
});

describe("handleVoiciShorten (phone-signed API)", () => {
  function signedBody(args: {
    irk: Keypair;
    username?: string;
    serviceId?: string;
    targetUrl?: string;
    issuedAt?: number;
  }) {
    const issuedAt = args.issuedAt ?? Date.now();
    const targetUrl = args.targetUrl ?? "https://app.example.com/page";
    const username = args.username ?? USER;
    const sig = signVoiciShorten(
      {
        username,
        ...(args.serviceId ? { serviceId: args.serviceId } : {}),
        targetUrl,
        issuedAt,
      },
      args.irk,
    );
    return {
      request: {
        username,
        ...(args.serviceId ? { serviceId: args.serviceId } : {}),
        targetUrl,
        issuedAt,
      },
      signature: bytesToHex(sig),
    };
  }

  it("mints a code for an IRK-signed request", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk }),
    );
    expect(res.status).toBe(200);
    const b = res.body as { ok: boolean; code: string; shortUrl: string };
    expect(b.ok).toBe(true);
    expect(b.code).toMatch(/^[a-z0-9]{6}$/);
    expect(b.shortUrl).toBe(`https://voi.ci/${b.code}`);
  });

  it("403s on invalid signature", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const other = makeKey();
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk: other }),
    );
    expect(res.status).toBe(403);
  });

  it("403s on stale request", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk, issuedAt: Date.now() - 10 * 60_000 }),
    );
    expect(res.status).toBe(403);
  });

  it("400s on non-https targetUrl", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seed(s, irk);
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk, targetUrl: "http://example.com/" }),
    );
    expect(res.status).toBe(400);
  });

  it("404s on unknown username", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    const res = await handleVoiciShorten(
      { usernames: s.usernames, voiciLinks: s.voiciLinks },
      signedBody({ irk }),
    );
    expect(res.status).toBe(404);
  });
});
