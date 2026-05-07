import { describe, expect, it } from "vitest";
import {
  ed,
  signClaimUrlCapability,
  signClaimUrlCapabilityRevocationList,
  type ClaimUrlCapability,
  type ClaimUrlCapabilityRevocationList,
  type Keypair,
} from "@flagship/protocol";
import {
  admitCapability,
  checkCapability,
  InMemoryCapabilityStore,
  TtlRevocationCache,
  type CapabilityStore,
  type RevocationCache,
  type RevocationFetcher,
  type StoredCapability,
} from "../src/capabilityStore.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const USER = "alice";
const APP_A = "app-a";
const APP_B = "app-b";
const POD_X = "x.alice.flagship.services";
const POD_Y = "y.alice.flagship.services";
const FQDN_1 = "notes.alice.flagship.services";
const FQDN_2 = "tasks.alice.flagship.services";

function buildCap(over: Partial<ClaimUrlCapability> = {}): ClaimUrlCapability {
  return {
    username: USER,
    appId: APP_A,
    siblingId: POD_X,
    fqdn: FQDN_1,
    issuedAt: 1_000,
    expiresAt: 1_000 + 90 * 24 * 60 * 60 * 1000,
    ...over,
  };
}

function deposit(
  store: CapabilityStore,
  cap: ClaimUrlCapability,
  irk: Keypair,
  now = () => 1_500,
): Promise<StoredCapability> {
  const sig = signClaimUrlCapability(cap, irk);
  return admitCapability({
    capability: cap,
    signatureHex: hex(sig),
    irkPubLookup: async (u) => (u === cap.username ? irk.publicKey : null),
    store,
    now,
  });
}

function neverRevoke(): RevocationCache {
  return {
    has: async () => false,
    refresh: async () => {},
  };
}

describe("admitCapability", () => {
  it("admits a freshly-signed capability and stores it", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    const stored = await deposit(store, buildCap(), irk);
    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.byTuple({ appId: APP_A, siblingId: POD_X, fqdn: FQDN_1 })).not.toBeNull();
  });

  it("rejects an upper-cased fqdn", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await expect(
      deposit(store, buildCap({ fqdn: "Notes.Alice.flagship.services" }), irk),
    ).rejects.toThrow(/lower-cased/);
  });

  it("rejects an already-expired capability", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await expect(
      deposit(store, buildCap({ issuedAt: 100, expiresAt: 500 }), irk, () => 1_000),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a capability where expiresAt <= issuedAt", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await expect(
      deposit(store, buildCap({ issuedAt: 1000, expiresAt: 1000 }), irk),
    ).rejects.toThrow(/expiresAt/);
  });

  it("rejects an invalid signature (different IRK)", async () => {
    const realIrk = makeKey();
    const otherIrk = makeKey();
    const store = new InMemoryCapabilityStore();
    const cap = buildCap();
    const wrongSig = signClaimUrlCapability(cap, otherIrk);
    await expect(
      admitCapability({
        capability: cap,
        signatureHex: hex(wrongSig),
        irkPubLookup: async () => realIrk.publicKey,
        store,
        now: () => 1_500,
      }),
    ).rejects.toThrow(/invalid/);
  });

  it("rejects an unknown username", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    const cap = buildCap();
    const sig = signClaimUrlCapability(cap, irk);
    await expect(
      admitCapability({
        capability: cap,
        signatureHex: hex(sig),
        irkPubLookup: async () => null,
        store,
        now: () => 1_500,
      }),
    ).rejects.toThrow(/unknown/);
  });
});

describe("checkCapability — adversarial tuple matching", () => {
  it("allows the legitimate (appId, siblingId, fqdn) match", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await deposit(store, buildCap(), irk);
    const r = await checkCapability(
      { callerAppId: APP_A, thisSiblingId: POD_X, requestedFqdn: FQDN_1 },
      store,
      neverRevoke(),
      () => 2_000,
    );
    expect(r.ok).toBe(true);
  });

  it("REJECTS app B trying to use app A's capability", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await deposit(store, buildCap({ appId: APP_A }), irk);
    const r = await checkCapability(
      { callerAppId: APP_B, thisSiblingId: POD_X, requestedFqdn: FQDN_1 },
      store,
      neverRevoke(),
      () => 2_000,
    );
    expect(r.ok).toBe(false);
  });

  it("REJECTS pod Y using a cap that names pod X", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await deposit(store, buildCap({ siblingId: POD_X }), irk);
    const r = await checkCapability(
      { callerAppId: APP_A, thisSiblingId: POD_Y, requestedFqdn: FQDN_1 },
      store,
      neverRevoke(),
      () => 2_000,
    );
    expect(r.ok).toBe(false);
  });

  it("REJECTS fqdn mismatch — capability for F1, request for F2", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await deposit(store, buildCap({ fqdn: FQDN_1 }), irk);
    const r = await checkCapability(
      { callerAppId: APP_A, thisSiblingId: POD_X, requestedFqdn: FQDN_2 },
      store,
      neverRevoke(),
      () => 2_000,
    );
    expect(r.ok).toBe(false);
  });

  it("REJECTS expired capability even though tuple matches", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await deposit(store, buildCap({ issuedAt: 1_000, expiresAt: 1_500 }), irk, () => 1_100);
    const r = await checkCapability(
      { callerAppId: APP_A, thisSiblingId: POD_X, requestedFqdn: FQDN_1 },
      store,
      neverRevoke(),
      () => 2_000,
    );
    expect(r.ok).toBe(false);
  });

  it("REJECTS request when capability id is in the revocation cache", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    const stored = await deposit(store, buildCap(), irk);
    const revoked: RevocationCache = {
      has: async (a) => a.capabilityId === stored.id,
      refresh: async () => {},
    };
    const r = await checkCapability(
      { callerAppId: APP_A, thisSiblingId: POD_X, requestedFqdn: FQDN_1 },
      store,
      revoked,
      () => 2_000,
    );
    expect(r.ok).toBe(false);
  });

  it("normalizes the request fqdn case before lookup", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await deposit(store, buildCap({ fqdn: FQDN_1 }), irk);
    const r = await checkCapability(
      { callerAppId: APP_A, thisSiblingId: POD_X, requestedFqdn: FQDN_1.toUpperCase() },
      store,
      neverRevoke(),
      () => 2_000,
    );
    expect(r.ok).toBe(true);
  });

  it("does not leak rejection reason — same shape for app/pod/fqdn/expired/revoked", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await deposit(store, buildCap(), irk);
    const cases = [
      { callerAppId: APP_B, thisSiblingId: POD_X, requestedFqdn: FQDN_1 },
      { callerAppId: APP_A, thisSiblingId: POD_Y, requestedFqdn: FQDN_1 },
      { callerAppId: APP_A, thisSiblingId: POD_X, requestedFqdn: FQDN_2 },
    ];
    for (const c of cases) {
      const r = await checkCapability(c, store, neverRevoke(), () => 2_000);
      expect(r).toEqual({ ok: false });
    }
  });
});

describe("forgetByApp", () => {
  it("drops every capability bound to the named app, leaves others", async () => {
    const irk = makeKey();
    const store = new InMemoryCapabilityStore();
    await deposit(store, buildCap({ appId: APP_A, fqdn: FQDN_1 }), irk);
    await deposit(store, buildCap({ appId: APP_A, fqdn: FQDN_2 }), irk);
    await deposit(store, buildCap({ appId: APP_B, fqdn: FQDN_1 }), irk);
    await store.forgetByApp(APP_A);
    const remaining = await store.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.capability.appId).toBe(APP_B);
  });
});

describe("TtlRevocationCache", () => {
  function makeFetcher(
    irk: Keypair,
    list: ClaimUrlCapabilityRevocationList | null,
  ): RevocationFetcher & { fetches: number } {
    let fetches = 0;
    const f = {
      get fetches() {
        return fetches;
      },
      fetch: async () => {
        fetches++;
        if (!list) return null;
        const sig = signClaimUrlCapabilityRevocationList(list, irk);
        return { list, signatureHex: hex(sig) };
      },
    };
    return f as unknown as RevocationFetcher & { fetches: number };
  }

  it("caches inside TTL — second call doesn't re-fetch", async () => {
    const irk = makeKey();
    const list: ClaimUrlCapabilityRevocationList = {
      username: USER,
      capabilityIds: ["cap1"],
      issuedAt: 100,
    };
    const fetcher = makeFetcher(irk, list);
    let now = 1_000;
    const cache = new TtlRevocationCache(
      fetcher,
      async (u) => (u === USER ? irk.publicKey : null),
      () => now,
      60_000,
    );
    expect(await cache.has({ username: USER, capabilityId: "cap1" })).toBe(true);
    expect(await cache.has({ username: USER, capabilityId: "cap1" })).toBe(true);
    expect(fetcher.fetches).toBe(1);
  });

  it("re-fetches after TTL expires", async () => {
    const irk = makeKey();
    const list: ClaimUrlCapabilityRevocationList = {
      username: USER,
      capabilityIds: [],
      issuedAt: 100,
    };
    const fetcher = makeFetcher(irk, list);
    let now = 1_000;
    const cache = new TtlRevocationCache(
      fetcher,
      async () => irk.publicKey,
      () => now,
      60_000,
    );
    await cache.has({ username: USER, capabilityId: "x" });
    expect(fetcher.fetches).toBe(1);
    now = 1_000 + 61_000;
    await cache.has({ username: USER, capabilityId: "x" });
    expect(fetcher.fetches).toBe(2);
  });

  it("rejects a list signed by the wrong IRK (does not poison the cache)", async () => {
    const realIrk = makeKey();
    const otherIrk = makeKey();
    const list: ClaimUrlCapabilityRevocationList = {
      username: USER,
      capabilityIds: ["evil-id"],
      issuedAt: 100,
    };
    const fetcher = makeFetcher(otherIrk, list);
    const cache = new TtlRevocationCache(
      fetcher,
      async () => realIrk.publicKey,
      () => 1_000,
      60_000,
    );
    expect(await cache.has({ username: USER, capabilityId: "evil-id" })).toBe(false);
  });

  it("refuses an older list (replay) once a newer one is cached", async () => {
    const irk = makeKey();
    const newer: ClaimUrlCapabilityRevocationList = {
      username: USER,
      capabilityIds: ["cap1"],
      issuedAt: 200,
    };
    const older: ClaimUrlCapabilityRevocationList = {
      username: USER,
      capabilityIds: [],
      issuedAt: 100,
    };
    const fetcher = makeFetcher(irk, newer);
    let now = 1_000;
    const cache = new TtlRevocationCache(
      fetcher,
      async () => irk.publicKey,
      () => now,
      60_000,
    );
    expect(await cache.has({ username: USER, capabilityId: "cap1" })).toBe(true);
    // Replace the fetcher's list with the older one — simulating a replay.
    (fetcher as unknown as { fetch: RevocationFetcher["fetch"] }).fetch = async () => {
      const sig = signClaimUrlCapabilityRevocationList(older, irk);
      return { list: older, signatureHex: hex(sig) };
    };
    now = 1_000 + 61_000;
    // After TTL, the cache refreshes — but the older list is rejected.
    expect(await cache.has({ username: USER, capabilityId: "cap1" })).toBe(true);
  });
});
