import { describe, expect, it } from "vitest";
import {
  ed,
  signAutoUnlockLease,
  signConsumeUnlockKey,
  signDepositUnlockKey,
  signPutSealedLuksKey,
  signRevokeAutoUnlockLease,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleConsumeUnlockKey,
  handleDepositAutoUnlockLease,
  handleDepositUnlockKey,
  handleGetPendingUnlockApproval,
  handleGetSealedLuksKey,
  handleListAutoUnlockLeases,
  handlePutSealedLuksKey,
  handleRevokeAutoUnlockLease,
} from "../src/luksKeys.js";

const HOST = "home.alice.flagship.services";
const USERNAME = "alice";

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

async function setup(opts: { irk: Keypair; identity: Keypair }): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(opts.irk.publicKey),
    claimedAt: 1,
  });
  await s.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: bytesToHex(opts.identity.publicKey),
    registeredAt: 2,
  });
  return s;
}

describe("LUKS sealed key", () => {
  it("server stores sealed key with valid identity sig and gets it back", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const sealedKey = new Uint8Array(48);
    crypto.getRandomValues(sealedKey);
    const issuedAt = Date.now();
    const sig = signPutSealedLuksKey({ serverId: HOST, sealedKey, issuedAt }, identity);
    const res = await handlePutSealedLuksKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, sealedKey: bytesToHex(sealedKey), issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(200);

    const got = await handleGetSealedLuksKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
    );
    expect(got.status).toBe(200);
    expect((got.body as { sealedKey: string }).sealedKey).toBe(bytesToHex(sealedKey));
  });

  it("rejects an attacker's signature (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const attacker = makeKey();
    const storage = await setup({ irk, identity });
    const issuedAt = Date.now();
    const sealedKey = new Uint8Array(8);
    const sig = signPutSealedLuksKey({ serverId: HOST, sealedKey, issuedAt }, attacker);
    const res = await handlePutSealedLuksKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, sealedKey: bytesToHex(sealedKey), issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects mismatched host vs serverId (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const sealedKey = new Uint8Array(8);
    const issuedAt = Date.now();
    const sig = signPutSealedLuksKey({ serverId: HOST, sealedKey, issuedAt }, identity);
    const res = await handlePutSealedLuksKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      "home.bob.flagship.services",
      {
        request: { serverId: HOST, sealedKey: bytesToHex(sealedKey), issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("LUKS unlock-key flow", () => {
  it("phone deposits, server consumes once; second consume returns 404", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const unlockKey = new Uint8Array(32);
    crypto.getRandomValues(unlockKey);
    const expiresAt = Date.now() + 5 * 60_000;
    const issuedAt = Date.now();
    const depSig = signDepositUnlockKey(
      { serverId: HOST, unlockKey, expiresAt, issuedAt },
      irk,
    );
    const dep = await handleDepositUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, unlockKey: bytesToHex(unlockKey), expiresAt, issuedAt },
        signature: bytesToHex(depSig),
      },
    );
    expect(dep.status).toBe(200);

    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const consumeIssuedAt = Date.now();
    const cSig = signConsumeUnlockKey(
      { serverId: HOST, nonce, issuedAt: consumeIssuedAt },
      identity,
    );
    const res1 = await handleConsumeUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, nonce: bytesToHex(nonce), issuedAt: consumeIssuedAt },
        signature: bytesToHex(cSig),
      },
    );
    expect(res1.status).toBe(200);
    expect((res1.body as { unlockKey: string }).unlockKey).toBe(bytesToHex(unlockKey));

    // Second consume — should be 404 because the deposit was cleared.
    const nonce2 = new Uint8Array(32);
    crypto.getRandomValues(nonce2);
    const cSig2 = signConsumeUnlockKey(
      { serverId: HOST, nonce: nonce2, issuedAt: consumeIssuedAt },
      identity,
    );
    const res2 = await handleConsumeUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, nonce: bytesToHex(nonce2), issuedAt: consumeIssuedAt },
        signature: bytesToHex(cSig2),
      },
    );
    expect(res2.status).toBe(404);
  });

  it("phone deposit signed by a non-IRK key is rejected (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const attacker = makeKey();
    const storage = await setup({ irk, identity });
    const unlockKey = new Uint8Array(32);
    const expiresAt = Date.now() + 5 * 60_000;
    const issuedAt = Date.now();
    const sig = signDepositUnlockKey(
      { serverId: HOST, unlockKey, expiresAt, issuedAt },
      attacker,
    );
    const res = await handleDepositUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, unlockKey: bytesToHex(unlockKey), expiresAt, issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });

  it("expired deposit is treated as absent on consume (404)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const unlockKey = new Uint8Array(32);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 1; // 1ms — already past by the time we consume
    await storage.luksKeys.putUnlock({
      serverDomain: HOST,
      unlockKeyHex: bytesToHex(unlockKey),
      depositedAt: issuedAt,
      expiresAt,
    });
    // Wait long enough for expiration.
    await new Promise((r) => setTimeout(r, 5));
    const nonce = new Uint8Array(32);
    const consumeIssuedAt = Date.now();
    const sig = signConsumeUnlockKey(
      { serverId: HOST, nonce, issuedAt: consumeIssuedAt },
      identity,
    );
    const res = await handleConsumeUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, nonce: bytesToHex(nonce), issuedAt: consumeIssuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Auto-unlock leases (single envelope, both modes)
// ──────────────────────────────────────────────────────────────────────

function depositLease(opts: {
  storage: InMemoryStorage;
  irk: Keypair;
  identity: Keypair;
  leaseId: string;
  multiUse: boolean;
  ttlMs?: number;
  unlockKey?: Uint8Array;
  issuedAt?: number;
}) {
  const issuedAt = opts.issuedAt ?? Date.now();
  const expiresAt = issuedAt + (opts.ttlMs ?? 600_000); // default 10 min
  const unlockKey = opts.unlockKey ?? new Uint8Array(64).fill(0xa5);
  const sig = signAutoUnlockLease(
    { serverId: HOST, leaseId: opts.leaseId, expiresAt, unlockKey, multiUse: opts.multiUse, issuedAt },
    opts.irk,
  );
  return handleDepositAutoUnlockLease(
    {
      servers: opts.storage.servers,
      usernames: opts.storage.usernames,
      luksKeys: opts.storage.luksKeys,
      autoUnlockLeases: opts.storage.autoUnlockLeases,
    },
    HOST,
    {
      request: {
        serverId: HOST,
        leaseId: opts.leaseId,
        unlockKey: bytesToHex(unlockKey),
        multiUse: opts.multiUse,
        expiresAt,
        issuedAt,
      },
      signature: bytesToHex(sig),
    },
  );
}

function consume(storage: InMemoryStorage, identity: Keypair) {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const issuedAt = Date.now();
  const sig = signConsumeUnlockKey({ serverId: HOST, nonce, issuedAt }, identity);
  return handleConsumeUnlockKey(
    {
      servers: storage.servers,
      usernames: storage.usernames,
      luksKeys: storage.luksKeys,
      autoUnlockLeases: storage.autoUnlockLeases,
    },
    HOST,
    {
      request: { serverId: HOST, nonce: bytesToHex(nonce), issuedAt },
      signature: bytesToHex(sig),
    },
  );
}

describe("auto-unlock leases — deposit", () => {
  it("accepts a one-shot lease (multiUse=false) signed by the user's IRK", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await depositLease({ storage, irk, identity, leaseId: "deadbeef00112233", multiUse: false });
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it("accepts a multi-use lease signed by the user's IRK", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await depositLease({
      storage, irk, identity,
      leaseId: "feedfacecafebeef",
      multiUse: true,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a malformed body (400)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await handleDepositAutoUnlockLease(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
      },
      HOST,
      { request: { serverId: HOST }, signature: "00" },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a leaseId that doesn't match the hex-shape requirement (400)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    // 8 chars — too short.
    const res = await depositLease({ storage, irk, identity, leaseId: "abc12345", multiUse: false });
    expect(res.status).toBe(400);
  });

  it("rejects when serverId in body doesn't match the URL host (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 600_000;
    const unlockKey = new Uint8Array(64);
    const sig = signAutoUnlockLease(
      { serverId: HOST, leaseId: "0123456789abcdef", expiresAt, unlockKey, multiUse: false, issuedAt },
      irk,
    );
    const res = await handleDepositAutoUnlockLease(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
      },
      "different.flagship.services",
      {
        request: { serverId: HOST, leaseId: "0123456789abcdef", unlockKey: bytesToHex(unlockKey), multiUse: false, expiresAt, issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects an IRK signature from a different account (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const otherIrk = makeKey();
    const res = await depositLease({ storage, irk: otherIrk, identity, leaseId: "0123456789abcdef", multiUse: false });
    expect(res.status).toBe(403);
  });

  it("rejects a stale issuedAt (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await depositLease({
      storage, irk, identity, leaseId: "0123456789abcdef", multiUse: false,
      issuedAt: Date.now() - 10 * 60_000,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a lease that expires in the past (400)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await depositLease({
      storage, irk, identity, leaseId: "0123456789abcdef", multiUse: false,
      ttlMs: -1_000,
    });
    expect(res.status).toBe(400);
  });

  it("rejects when autoUnlockLeases storage isn't configured (501)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await handleDepositAutoUnlockLease(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        // no autoUnlockLeases
      },
      HOST,
      { request: {}, signature: "00" },
    );
    expect(res.status).toBe(501);
  });
});

describe("auto-unlock leases — consume picks lease before legacy deposit", () => {
  it("returns the lease's unlockKey + leaseId + multiUse on consume", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const myKey = new Uint8Array(64).fill(0xc3);
    await depositLease({ storage, irk, identity, leaseId: "11111111aaaaaaaa", multiUse: false, unlockKey: myKey });

    const res = await consume(storage, identity);
    expect(res.status).toBe(200);
    expect((res.body as { unlockKey: string }).unlockKey).toBe(bytesToHex(myKey));
    expect((res.body as { leaseId: string }).leaseId).toBe("11111111aaaaaaaa");
    expect((res.body as { multiUse: boolean }).multiUse).toBe(false);
  });

  it("multi-use lease survives multiple /consume calls until expiry", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    await depositLease({ storage, irk, identity, leaseId: "22222222bbbbbbbb", multiUse: true, ttlMs: 60_000 });
    const r1 = await consume(storage, identity);
    const r2 = await consume(storage, identity);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((r2.body as { leaseId: string }).leaseId).toBe("22222222bbbbbbbb");
  });

  it("one-shot lease is gone after the first /consume", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    await depositLease({ storage, irk, identity, leaseId: "33333333cccccccc", multiUse: false });
    const r1 = await consume(storage, identity);
    const r2 = await consume(storage, identity);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(404);
  });

  it("falls back to legacy unlock_key_deposits when no lease is present", async () => {
    // Defense in depth: an old-style DepositUnlockKey writer should
    // still work after the lease layer lands. Wire only the legacy
    // store here (skip autoUnlockLeases entirely).
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const unlockKey = new Uint8Array(32).fill(0xee);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 60_000;
    const sig = signDepositUnlockKey(
      { serverId: HOST, unlockKey, expiresAt, issuedAt },
      irk,
    );
    await handleDepositUnlockKey(
      { servers: storage.servers, usernames: storage.usernames, luksKeys: storage.luksKeys },
      HOST,
      {
        request: { serverId: HOST, unlockKey: bytesToHex(unlockKey), expiresAt, issuedAt },
        signature: bytesToHex(sig),
      },
    );
    const res = await consume(storage, identity);
    expect(res.status).toBe(200);
    expect((res.body as { unlockKey: string }).unlockKey).toBe(bytesToHex(unlockKey));
  });
});

describe("auto-unlock leases — revoke", () => {
  it("removes the lease and returns ok with removed=true", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    await depositLease({ storage, irk, identity, leaseId: "ABCDEF0123456789", multiUse: true });
    const issuedAt = Date.now();
    const sig = signRevokeAutoUnlockLease({ serverId: HOST, leaseId: "ABCDEF0123456789", issuedAt }, irk);
    const res = await handleRevokeAutoUnlockLease(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
      },
      HOST,
      "ABCDEF0123456789",
      {
        request: { serverId: HOST, leaseId: "ABCDEF0123456789", issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(200);
    expect((res.body as { removed: boolean }).removed).toBe(true);
    // Subsequent consume returns 404 (the lease is gone).
    const after = await consume(storage, identity);
    expect(after.status).toBe(404);
  });

  it("rejects when leaseId in URL doesn't match the body (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const issuedAt = Date.now();
    const sig = signRevokeAutoUnlockLease({ serverId: HOST, leaseId: "AAAAAAAAAAAAAAAA", issuedAt }, irk);
    const res = await handleRevokeAutoUnlockLease(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
      },
      HOST,
      "BBBBBBBBBBBBBBBB",
      {
        request: { serverId: HOST, leaseId: "AAAAAAAAAAAAAAAA", issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects under a different IRK (403)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    await depositLease({ storage, irk, identity, leaseId: "AAAA1111BBBB2222", multiUse: true });
    const otherIrk = makeKey();
    const issuedAt = Date.now();
    const sig = signRevokeAutoUnlockLease({ serverId: HOST, leaseId: "AAAA1111BBBB2222", issuedAt }, otherIrk);
    const res = await handleRevokeAutoUnlockLease(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
      },
      HOST,
      "AAAA1111BBBB2222",
      {
        request: { serverId: HOST, leaseId: "AAAA1111BBBB2222", issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("auto-unlock leases — list", () => {
  it("returns active leases for a server, freshest first, without unlockKeyHex", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    await depositLease({ storage, irk, identity, leaseId: "0000000000000001", multiUse: true });
    await depositLease({ storage, irk, identity, leaseId: "0000000000000002", multiUse: false });

    const res = await handleListAutoUnlockLeases(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
      },
      HOST,
    );
    expect(res.status).toBe(200);
    const body = res.body as { leases: Array<{ leaseId: string; unlockKeyHex?: string }> };
    expect(body.leases).toHaveLength(2);
    expect(body.leases[0]!.leaseId).toBeDefined();
    expect(body.leases[0]!.unlockKeyHex).toBeUndefined();
  });

  it("404s for an unknown server", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await handleListAutoUnlockLeases(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
      },
      "ghost.flagship.services",
    );
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────
// /consume push trigger + pending-approvals (#8)
// ──────────────────────────────────────────────────────────────────────

function consumeRequest(identity: Keypair, issuedAtOverride?: number) {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const issuedAt = issuedAtOverride ?? Date.now();
  const sig = signConsumeUnlockKey({ serverId: HOST, nonce, issuedAt }, identity);
  return {
    request: { serverId: HOST, nonce: bytesToHex(nonce), issuedAt },
    signature: bytesToHex(sig),
  };
}

describe("consume → push trigger (no lease, no deposit)", () => {
  it("records a pending-approval row + fires push on first poll", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const pushed: Array<{ username: string; category: string }> = [];

    const res = await handleConsumeUnlockKey(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
        pendingUnlockApprovals: storage.pendingUnlockApprovals,
        pushUserDevices: async (username, category) => {
          pushed.push({ username, category });
        },
      },
      HOST,
      consumeRequest(identity),
    );
    expect(res.status).toBe(404);

    // Pending row recorded.
    const row = await storage.pendingUnlockApprovals.get(HOST);
    expect(row).toBeDefined();
    expect(row?.serverDomain).toBe(HOST);
    expect(row?.requestId.length).toBeGreaterThanOrEqual(16);

    // Push fired with the right user + category. The async push is
    // fire-and-forget; the upsert/touch is synchronous, so we wait
    // a microtask before asserting.
    await new Promise((r) => setImmediate(r));
    expect(pushed).toEqual([{ username: USERNAME, category: "unlock-request" }]);
  });

  it("dedupes pushes within the configured window (default 60s)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const pushed: string[] = [];
    const deps = {
      servers: storage.servers,
      usernames: storage.usernames,
      luksKeys: storage.luksKeys,
      autoUnlockLeases: storage.autoUnlockLeases,
      pendingUnlockApprovals: storage.pendingUnlockApprovals,
      pushUserDevices: async (u: string) => { pushed.push(u); },
      pushDedupMs: 60_000,
    };
    await handleConsumeUnlockKey(deps, HOST, consumeRequest(identity));
    await new Promise((r) => setImmediate(r));
    await handleConsumeUnlockKey(deps, HOST, consumeRequest(identity));
    await new Promise((r) => setImmediate(r));
    await handleConsumeUnlockKey(deps, HOST, consumeRequest(identity));
    await new Promise((r) => setImmediate(r));
    expect(pushed).toHaveLength(1);
  });

  it("re-pushes after the dedup window elapses (boot stage backed off then retried)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const pushed: string[] = [];
    let clock = 1_000_000;
    const deps = {
      servers: storage.servers,
      usernames: storage.usernames,
      luksKeys: storage.luksKeys,
      autoUnlockLeases: storage.autoUnlockLeases,
      pendingUnlockApprovals: storage.pendingUnlockApprovals,
      pushUserDevices: async (u: string) => { pushed.push(u); },
      pushDedupMs: 1_000,
      now: () => clock,
    };
    await handleConsumeUnlockKey(deps, HOST, consumeRequest(identity, clock));
    await new Promise((r) => setImmediate(r));
    clock += 2_000; // past the 1s dedup window
    await handleConsumeUnlockKey(deps, HOST, consumeRequest(identity, clock));
    await new Promise((r) => setImmediate(r));
    expect(pushed).toHaveLength(2);
  });

  it("does NOT push when pushUserDevices isn't wired (graceful degrade)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await handleConsumeUnlockKey(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
        pendingUnlockApprovals: storage.pendingUnlockApprovals,
        // pushUserDevices intentionally omitted
      },
      HOST,
      consumeRequest(identity),
    );
    expect(res.status).toBe(404);
    // Pending row still recorded so the daemon's screen view can list it.
    expect(await storage.pendingUnlockApprovals.get(HOST)).toBeDefined();
  });

  it("does NOT push when a lease is present (lease wins; no boot wait)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    // Pre-deposit a lease.
    await storage.autoUnlockLeases.put({
      serverDomain: HOST,
      leaseId: "abcdef0123456789",
      unlockKeyHex: "00".repeat(32),
      multiUse: false,
      depositedAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });
    const pushed: string[] = [];
    const res = await handleConsumeUnlockKey(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
        pendingUnlockApprovals: storage.pendingUnlockApprovals,
        pushUserDevices: async (u) => { pushed.push(u); },
      },
      HOST,
      consumeRequest(identity),
    );
    expect(res.status).toBe(200);
    expect(pushed).toHaveLength(0);
    expect(await storage.pendingUnlockApprovals.get(HOST)).toBeUndefined();
  });

  it("clears the pending row when a lease is deposited (Approve flow)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    // First, simulate a boot poll → records pending.
    await handleConsumeUnlockKey(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
        pendingUnlockApprovals: storage.pendingUnlockApprovals,
      },
      HOST,
      consumeRequest(identity),
    );
    expect(await storage.pendingUnlockApprovals.get(HOST)).toBeDefined();

    // Now the user clicks Approve — webapp signs + posts a lease.
    const unlockKey = new Uint8Array(32).fill(0xab);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 600_000;
    const leaseSig = signAutoUnlockLease(
      { serverId: HOST, leaseId: "feedface00112233", expiresAt, unlockKey, multiUse: false, issuedAt },
      irk,
    );
    const dRes = await handleDepositAutoUnlockLease(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        autoUnlockLeases: storage.autoUnlockLeases,
        pendingUnlockApprovals: storage.pendingUnlockApprovals,
      },
      HOST,
      {
        request: {
          serverId: HOST,
          leaseId: "feedface00112233",
          unlockKey: bytesToHex(unlockKey),
          multiUse: false,
          expiresAt,
          issuedAt,
        },
        signature: bytesToHex(leaseSig),
      },
    );
    expect(dRes.status).toBe(200);
    // Pending row is gone.
    expect(await storage.pendingUnlockApprovals.get(HOST)).toBeUndefined();
  });
});

describe("GET /api/unlock/approvals/pending (proxied by daemon)", () => {
  it("returns pending=[] when no row exists", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await handleGetPendingUnlockApproval(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        pendingUnlockApprovals: storage.pendingUnlockApprovals,
      },
      HOST,
    );
    expect(res.status).toBe(200);
    expect((res.body as { pending: unknown[] }).pending).toEqual([]);
  });

  it("returns the pending row's metadata (no unlock key disclosure)", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    await storage.pendingUnlockApprovals.upsertWithDedup(HOST, "req-deadbeef", 1_700_000_000_000, 60_000);
    const res = await handleGetPendingUnlockApproval(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        pendingUnlockApprovals: storage.pendingUnlockApprovals,
      },
      HOST,
    );
    expect(res.status).toBe(200);
    const body = res.body as { pending: Array<{ requestId: string; serverFqdn: string; requestedAt: number }> };
    expect(body.pending).toEqual([
      { requestId: "req-deadbeef", serverFqdn: HOST, requestedAt: 1_700_000_000_000 },
    ]);
  });

  it("gracefully returns pending=[] when storage isn't configured", async () => {
    const irk = makeKey();
    const identity = makeKey();
    const storage = await setup({ irk, identity });
    const res = await handleGetPendingUnlockApproval(
      {
        servers: storage.servers,
        usernames: storage.usernames,
        luksKeys: storage.luksKeys,
        // pendingUnlockApprovals intentionally omitted
      },
      HOST,
    );
    expect(res.status).toBe(200);
    expect((res.body as { pending: unknown[] }).pending).toEqual([]);
  });
});
