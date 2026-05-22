// Phase 1 — webapp login preflight + demo-as-recovery branch.
//
// Pins the webapp side of the account-name-first login decision tree:
//   - resolveAccount() GETs /api/account/resolve/<username> and returns
//     the parsed AccountResolution (wire-mirror of
//     packages/control-plane/src/accountResolve.ts).
//   - The endpoint is 200-ALWAYS, so a miss is `kind:"unknown"`, never a
//     404; a non-2xx is a genuine transport failure and throws.
//   - classifyResolution() routes demo → activate, unknown → state,
//     single/multi → the existing credentialed recovery flow.
//   - activateDemoAccount() attaches a FRESH device and opens the
//     sandbox with NO passkey / popup / passphrase (demo crypto is a
//     no-op; the username is the capability).
//
// See docs/login-and-account-redesign.md ("The unified login decision
// tree", the demo branch) + Phase 1.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadLib() {
  const path = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "accountResolve.js",
  );
  return import(pathToFileURL(path).href);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function demoResolution(username = "demo-alice") {
  return {
    username,
    exists: true,
    kind: "demo",
    recovery: { present: false, hasFetchGate: false },
    totpEnrolled: false,
    trustedDeviceCount: 0,
    demoServer: {
      fqdn: `home.${username}.flagship.services`,
      status: "up",
      ttlIdleMinutes: 30,
    },
    graceModel: "instant",
  };
}

function singleResolution(username = "harry", withRecovery = true) {
  return {
    username,
    exists: true,
    kind: "single",
    recovery: withRecovery
      ? { present: true, hasFetchGate: true, credentialId: "abc123" }
      : { present: false, hasFetchGate: false },
    totpEnrolled: false,
    trustedDeviceCount: 1,
    graceModel: "7d",
  };
}

function multiResolution(username = "hilton") {
  return {
    username,
    exists: true,
    kind: "multi",
    recovery: { present: true, hasFetchGate: true, credentialId: "def456" },
    totpEnrolled: true,
    trustedDeviceCount: 3,
    graceModel: "24h-totp",
  };
}

function unknownResolution(username = "nope") {
  return {
    username,
    exists: false,
    kind: "unknown",
    recovery: { present: false, hasFetchGate: false },
    totpEnrolled: false,
    trustedDeviceCount: 0,
    graceModel: "none",
  };
}

describe("webapp resolveAccount — login preflight wire", () => {
  it("GETs /api/account/resolve/<username> and parses a demo resolution", async () => {
    const { resolveAccount } = await loadLib();
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, demoResolution("demo-alice")));
    const r = await resolveAccount("demo-alice", { fetch: fakeFetch as any });
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe("https://flagshipserver.com/api/account/resolve/demo-alice");
    expect(init.method).toBe("GET");
    expect(r.kind).toBe("demo");
    expect(r.demoServer?.fqdn).toBe("home.demo-alice.flagship.services");
    expect(r.graceModel).toBe("instant");
  });

  it("url-encodes the username segment", async () => {
    const { resolveAccount } = await loadLib();
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, unknownResolution("a b")));
    await resolveAccount("a b", { fetch: fakeFetch as any });
    expect(fakeFetch.mock.calls[0]![0]).toBe(
      "https://flagshipserver.com/api/account/resolve/a%20b",
    );
  });

  it("parses an unknown (miss) as a 200 STATE, not an error", async () => {
    const { resolveAccount } = await loadLib();
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, unknownResolution("ghost")));
    const r = await resolveAccount("ghost", { fetch: fakeFetch as any });
    expect(r.kind).toBe("unknown");
    expect(r.exists).toBe(false);
  });

  it("parses single (with/without recovery) + multi resolutions", async () => {
    const { resolveAccount } = await loadLib();
    const single = await resolveAccount("harry", {
      fetch: vi.fn().mockResolvedValue(jsonResponse(200, singleResolution("harry", true))) as any,
    });
    expect(single.kind).toBe("single");
    expect(single.recovery.present).toBe(true);
    expect(single.graceModel).toBe("7d");

    const noRec = await resolveAccount("harry", {
      fetch: vi.fn().mockResolvedValue(jsonResponse(200, singleResolution("harry", false))) as any,
    });
    expect(noRec.recovery.present).toBe(false);

    const multi = await resolveAccount("hilton", {
      fetch: vi.fn().mockResolvedValue(jsonResponse(200, multiResolution("hilton"))) as any,
    });
    expect(multi.kind).toBe("multi");
    expect(multi.totpEnrolled).toBe(true);
    expect(multi.graceModel).toBe("24h-totp");
  });

  it("throws on a 5xx (genuine transport failure — NOT a missing account)", async () => {
    const { resolveAccount } = await loadLib();
    const fakeFetch = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    await expect(resolveAccount("x", { fetch: fakeFetch as any })).rejects.toThrow(/503/);
  });

  it("throws a rate-limit error on 429 (surfacing retry-after)", async () => {
    const { resolveAccount } = await loadLib();
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response("slow down", { status: 429, headers: { "retry-after": "12" } }),
    );
    await expect(resolveAccount("x", { fetch: fakeFetch as any })).rejects.toThrow(/12s/);
  });

  it("honours a custom baseUrl", async () => {
    const { resolveAccount } = await loadLib();
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, demoResolution()));
    await resolveAccount("demo-alice", { fetch: fakeFetch as any, baseUrl: "https://staging.example" });
    expect(fakeFetch.mock.calls[0]![0]).toBe(
      "https://staging.example/api/account/resolve/demo-alice",
    );
  });
});

describe("webapp isBareLoginHandle — login input rule", () => {
  it("accepts lowercase letters/digits, rejects dots/hyphens/specials/empty", async () => {
    const { isBareLoginHandle } = await loadLib();
    expect(isBareLoginHandle("alice")).toBe(true);
    expect(isBareLoginHandle("alice42")).toBe(true);
    expect(isBareLoginHandle("alice.reviewer")).toBe(false); // dot-form retired
    expect(isBareLoginHandle("demo-alice")).toBe(false);     // hyphen — not a login handle
    expect(isBareLoginHandle("Alice")).toBe(false);
    expect(isBareLoginHandle("")).toBe(false);
    expect(isBareLoginHandle(undefined as any)).toBe(false);
  });
});

describe("webapp classifyResolution — login decision tree branch", () => {
  it("routes demo → 'demo'", async () => {
    const { classifyResolution } = await loadLib();
    expect(classifyResolution(demoResolution())).toBe("demo");
  });

  it("routes unknown (or !exists) → 'unknown'", async () => {
    const { classifyResolution } = await loadLib();
    expect(classifyResolution(unknownResolution())).toBe("unknown");
    expect(classifyResolution(null)).toBe("unknown");
    expect(classifyResolution(undefined)).toBe("unknown");
    expect(classifyResolution({ ...singleResolution(), exists: false })).toBe("unknown");
  });

  it("routes single/multi → 'recover' (Phase 1 keeps the credentialed flow)", async () => {
    const { classifyResolution } = await loadLib();
    expect(classifyResolution(singleResolution())).toBe("recover");
    expect(classifyResolution(multiResolution())).toBe("recover");
  });
});

describe("webapp activateDemoAccount — demo-as-recovery activation", () => {
  it("mints a fresh device, persists the demo profile, unlocks, and opens", async () => {
    const { activateDemoAccount } = await loadLib();
    const seed = new Uint8Array(32).fill(7);
    const calls: Record<string, any> = {};
    const deps = {
      bootstrapNewIdentity: vi.fn(async (pass: string) => { calls.pass = pass; return seed; }),
      unlockSession: vi.fn(async (s: Uint8Array, u?: string) => { calls.unlock = { s, u }; }),
      addProfile: vi.fn((p: object) => { calls.profile = p; }),
      dispatchInitialView: vi.fn(async () => { calls.dispatched = true; }),
      setUsername: vi.fn((u: string) => { calls.username = u; }),
      makePassphrase: () => "fixed-demo-passphrase",
    };
    const res = demoResolution("demo-alice");
    const out = await activateDemoAccount(res, deps as any);

    // Fresh device minted (NO passkey, NO popup) under a generated pass.
    expect(deps.bootstrapNewIdentity).toHaveBeenCalledTimes(1);
    expect(calls.pass).toBe("fixed-demo-passphrase");
    // Username persisted + session unlocked under the new seed.
    expect(calls.username).toBe("demo-alice");
    expect(calls.unlock.u).toBe("demo-alice");
    expect(calls.unlock.s).toBe(seed);
    // Demo profile carries the demoServer block.
    expect(calls.profile.cloudName).toBe("demo-alice");
    expect(calls.profile.demoServer.fqdn).toBe("home.demo-alice.flagship.services");
    // Account opened.
    expect(calls.dispatched).toBe(true);
    expect(out).toEqual({ username: "demo-alice", seed });
  });

  it("works without optional collaborators (addProfile/dispatch/setUsername)", async () => {
    const { activateDemoAccount } = await loadLib();
    const seed = new Uint8Array(32).fill(3);
    const deps = {
      bootstrapNewIdentity: vi.fn(async () => seed),
      unlockSession: vi.fn(),
      makePassphrase: () => "p".repeat(16),
    };
    const out = await activateDemoAccount(demoResolution("demo-bob"), deps as any);
    expect(out.username).toBe("demo-bob");
    expect(deps.unlockSession).toHaveBeenCalledWith(seed, "demo-bob");
  });

  it("rejects a non-demo resolution (defensive — the branch must guard)", async () => {
    const { activateDemoAccount } = await loadLib();
    const deps = { bootstrapNewIdentity: vi.fn(), unlockSession: vi.fn() };
    await expect(activateDemoAccount(singleResolution() as any, deps as any))
      .rejects.toThrow(/not a demo/);
    expect(deps.bootstrapNewIdentity).not.toHaveBeenCalled();
  });

  it("generates a random local passphrase by default (not typed/shown)", async () => {
    const { activateDemoAccount } = await loadLib();
    const seen: string[] = [];
    const deps = {
      bootstrapNewIdentity: vi.fn(async (p: string) => { seen.push(p); return new Uint8Array(32); }),
      unlockSession: vi.fn(),
    };
    await activateDemoAccount(demoResolution("demo-c1"), deps as any);
    await activateDemoAccount(demoResolution("demo-c2"), deps as any);
    // Hex, long, and distinct across activations (random).
    expect(seen[0]).toMatch(/^[0-9a-f]+$/);
    expect(seen[0]!.length).toBeGreaterThanOrEqual(32);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
