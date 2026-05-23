import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import type { AuthCodeRecord } from "../src/types.js";

function authCode(serial: string, status: AuthCodeRecord["status"] = "active"): AuthCodeRecord {
  return {
    serial,
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKeyHex: "00".repeat(32),
    userPubKeyHex: "11".repeat(32),
    userSignatureHex: "22".repeat(64),
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 3_600_000,
    status,
    recordedAt: 1_700_000_000_000,
  };
}

describe("InMemoryStorage", () => {
  it("usernames: put/get round-trips and rejects different IRK on the same name", async () => {
    const s = new InMemoryStorage();
    expect(await s.usernames.put({ username: "harry", irkPubHex: "aa".repeat(32), claimedAt: 1 })).toEqual({ ok: true });
    expect(await s.usernames.get("harry")).toMatchObject({ irkPubHex: "aa".repeat(32) });
    expect(await s.usernames.put({ username: "harry", irkPubHex: "aa".repeat(32), claimedAt: 2 })).toEqual({ ok: true });
    expect(await s.usernames.put({ username: "harry", irkPubHex: "bb".repeat(32), claimedAt: 3 })).toMatchObject({ ok: false });
  });

  it("usernames: isDemo defaults false, setDemo flips it, re-put preserves it (#84)", async () => {
    const s = new InMemoryStorage();
    await s.usernames.put({ username: "demo", irkPubHex: "aa".repeat(32), claimedAt: 1 });
    expect((await s.usernames.get("demo"))?.isDemo).toBe(false);

    expect(await s.usernames.setDemo("demo", true)).toBe(true);
    expect((await s.usernames.get("demo"))?.isDemo).toBe(true);

    // A benign re-claim (same IRK, no isDemo on the record) must not
    // silently un-demo the account.
    await s.usernames.put({ username: "demo", irkPubHex: "aa".repeat(32), claimedAt: 2 });
    expect((await s.usernames.get("demo"))?.isDemo).toBe(true);

    expect(await s.usernames.setDemo("demo", false)).toBe(true);
    expect((await s.usernames.get("demo"))?.isDemo).toBe(false);

    // setDemo on an unknown username is a no-op false (not a throw).
    expect(await s.usernames.setDemo("ghost", true)).toBe(false);
  });

  it("usernames: an explicit isDemo on put is honored on first claim (#84)", async () => {
    const s = new InMemoryStorage();
    await s.usernames.put({ username: "seed", irkPubHex: "cc".repeat(32), claimedAt: 1, isDemo: true });
    expect((await s.usernames.get("seed"))?.isDemo).toBe(true);
  });

  it("auth codes: markUsed once succeeds, twice fails (atomic single-use)", async () => {
    const s = new InMemoryStorage();
    await s.authCodes.put(authCode("S001"));
    expect(await s.authCodes.markUsed("S001", 1_700_000_001_000)).toEqual({ ok: true });
    expect(await s.authCodes.markUsed("S001", 1_700_000_002_000)).toMatchObject({ ok: false });
  });

  it("auth codes: markUsed rejects when expired", async () => {
    const s = new InMemoryStorage();
    await s.authCodes.put(authCode("S002"));
    expect(await s.authCodes.markUsed("S002", 1_799_000_000_000)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("auth codes: markRevoked is idempotent", async () => {
    const s = new InMemoryStorage();
    await s.authCodes.put(authCode("S003"));
    expect(await s.authCodes.markRevoked("S003", 1)).toEqual({ ok: true });
    expect(await s.authCodes.markRevoked("S003", 2)).toEqual({ ok: true });
    expect(await s.authCodes.markUsed("S003", 1_700_000_500_000)).toMatchObject({ ok: false });
  });

  it("servers: put/get/listForUser/revoke", async () => {
    const s = new InMemoryStorage();
    await s.servers.put({
      serverDomain: "home.harry.flagship.services",
      username: "harry",
      identityPubKeyHex: "44".repeat(32),
      registeredAt: 1,
    });
    await s.servers.put({
      serverDomain: "home.bob.flagship.services",
      username: "bob",
      identityPubKeyHex: "55".repeat(32),
      registeredAt: 2,
    });
    expect((await s.servers.listForUser("harry")).length).toBe(1);
    expect((await s.servers.listForUser("bob")).length).toBe(1);
    expect(await s.servers.revoke("home.harry.flagship.services", "stolen", 99)).toBe(true);
    expect((await s.servers.get("home.harry.flagship.services"))?.revokedAt).toBe(99);
    expect(await s.servers.revoke("missing.flagship.services", "stolen", 99)).toBe(false);
  });

  describe("autoUnlockLeases", () => {
    const SRV = "home.alice.flagship.services";
    function lease(id: string, opts: { multiUse: boolean; expiresAt: number; depositedAt?: number }) {
      return {
        serverDomain: SRV,
        leaseId: id,
        unlockKeyHex: "ab".repeat(32),
        multiUse: opts.multiUse,
        depositedAt: opts.depositedAt ?? 1_000,
        expiresAt: opts.expiresAt,
      };
    }

    it("one-shot lease (multiUse=false) is consumed and removed on first read", async () => {
      const s = new InMemoryStorage();
      await s.autoUnlockLeases.put(lease("L1", { multiUse: false, expiresAt: 5_000 }));
      const r1 = await s.autoUnlockLeases.consume(SRV, 2_000);
      expect(r1?.leaseId).toBe("L1");
      const r2 = await s.autoUnlockLeases.consume(SRV, 2_001);
      expect(r2).toBeUndefined();
    });

    it("multi-use lease persists across consumes until expiry", async () => {
      const s = new InMemoryStorage();
      await s.autoUnlockLeases.put(lease("L2", { multiUse: true, expiresAt: 10_000 }));
      const r1 = await s.autoUnlockLeases.consume(SRV, 1_500);
      const r2 = await s.autoUnlockLeases.consume(SRV, 5_000);
      expect(r1?.leaseId).toBe("L2");
      expect(r2?.leaseId).toBe("L2");
      const r3 = await s.autoUnlockLeases.consume(SRV, 10_001);
      expect(r3).toBeUndefined();
      expect(await s.autoUnlockLeases.list(SRV, 10_001)).toHaveLength(0);
    });

    it("consume picks the freshest non-expired lease when multiple exist", async () => {
      const s = new InMemoryStorage();
      await s.autoUnlockLeases.put(lease("phone-old", { multiUse: true, expiresAt: 9_000, depositedAt: 1_000 }));
      await s.autoUnlockLeases.put(lease("web-new",   { multiUse: true, expiresAt: 9_000, depositedAt: 5_000 }));
      const r = await s.autoUnlockLeases.consume(SRV, 6_000);
      expect(r?.leaseId).toBe("web-new");
    });

    it("expired rows are skipped and GC'd; the next non-expired wins", async () => {
      const s = new InMemoryStorage();
      await s.autoUnlockLeases.put(lease("expired", { multiUse: true, expiresAt: 100,  depositedAt: 50 }));
      await s.autoUnlockLeases.put(lease("live",    { multiUse: true, expiresAt: 9_000, depositedAt: 60 }));
      const r = await s.autoUnlockLeases.consume(SRV, 200);
      expect(r?.leaseId).toBe("live");
      const all = await s.autoUnlockLeases.list(SRV, 200);
      expect(all.map((l) => l.leaseId)).toEqual(["live"]);
    });

    it("revoke deletes by (serverDomain, leaseId) and reports whether a row was removed", async () => {
      const s = new InMemoryStorage();
      await s.autoUnlockLeases.put(lease("L1", { multiUse: true, expiresAt: 9_000 }));
      expect(await s.autoUnlockLeases.revoke(SRV, "missing")).toBe(false);
      expect(await s.autoUnlockLeases.revoke(SRV, "L1")).toBe(true);
      expect(await s.autoUnlockLeases.consume(SRV, 1_000)).toBeUndefined();
    });

    it("list returns active leases for a server, freshest first", async () => {
      const s = new InMemoryStorage();
      await s.autoUnlockLeases.put(lease("a", { multiUse: true, expiresAt: 9_000, depositedAt: 100 }));
      await s.autoUnlockLeases.put(lease("b", { multiUse: true, expiresAt: 9_000, depositedAt: 300 }));
      await s.autoUnlockLeases.put(lease("c", { multiUse: true, expiresAt: 9_000, depositedAt: 200 }));
      const out = await s.autoUnlockLeases.list(SRV, 1_000);
      expect(out.map((l) => l.leaseId)).toEqual(["b", "c", "a"]);
    });

    it("leases are scoped to serverDomain — a different server's leases are invisible", async () => {
      const s = new InMemoryStorage();
      await s.autoUnlockLeases.put(lease("L1", { multiUse: true, expiresAt: 9_000 }));
      const r = await s.autoUnlockLeases.consume("other.flagship.services", 1_000);
      expect(r).toBeUndefined();
      expect(await s.autoUnlockLeases.list("other.flagship.services", 1_000)).toHaveLength(0);
    });
  });

  describe("secretMailbox", () => {
    const SRV = "home.alice.flagship.services";
    function req(nonce: string, over: Partial<{ postedAt: number; expiresAt: number }> = {}) {
      return {
        serverDomain: SRV,
        username: "alice",
        requestNonceHex: nonce,
        stkPubHex: "aa".repeat(32),
        purpose: "unlock-key" as const,
        requestIssuedAt: 1_000,
        requestSignatureHex: "bb".repeat(64),
        deviceInfoJson: null,
        postedAt: over.postedAt ?? 1_000,
        expiresAt: over.expiresAt ?? 9_000,
        lastPushAt: 0,
        responseSealedHex: null,
        responseIssuedAt: null,
        respondedAt: null,
        consumedAt: null,
      };
    }

    it("putRequest enforces a single-use nonce", async () => {
      const s = new InMemoryStorage();
      expect((await s.secretMailbox.putRequest(req("11".repeat(32)))).ok).toBe(true);
      const dup = await s.secretMailbox.putRequest(req("11".repeat(32)));
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.reason).toBe("duplicate nonce");
    });

    it("listPendingForUser excludes answered, consumed, and expired rows", async () => {
      const s = new InMemoryStorage();
      await s.secretMailbox.putRequest(req("a1".repeat(32), { postedAt: 100 }));
      await s.secretMailbox.putRequest(req("a2".repeat(32), { postedAt: 200 }));
      await s.secretMailbox.putRequest(req("a3".repeat(32), { postedAt: 300, expiresAt: 150 }));
      // Answer a2 → no longer pending.
      await s.secretMailbox.putResponse(SRV, "a2".repeat(32), "cc".repeat(8), 50, 50);
      const pending = await s.secretMailbox.listPendingForUser("alice", 200);
      // a1 only: a2 answered, a3 expired-at-150 < 200.
      expect(pending.map((r) => r.requestNonceHex)).toEqual(["a1".repeat(32)]);
    });

    it("putResponse is write-once + consumeResponse is single-use", async () => {
      const s = new InMemoryStorage();
      await s.secretMailbox.putRequest(req("b1".repeat(32)));
      expect((await s.secretMailbox.putResponse(SRV, "b1".repeat(32), "dd".repeat(8), 10, 10)).ok).toBe(true);
      const second = await s.secretMailbox.putResponse(SRV, "b1".repeat(32), "ee".repeat(8), 11, 11);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("already answered");
      const c1 = await s.secretMailbox.consumeResponse(SRV, "b1".repeat(32), 20);
      expect(c1?.responseSealedHex).toBe("dd".repeat(8));
      expect(c1?.consumedAt).toBe(20);
      expect(await s.secretMailbox.consumeResponse(SRV, "b1".repeat(32), 21)).toBeUndefined();
    });

    it("consumeResponse GCs an expired row and returns undefined", async () => {
      const s = new InMemoryStorage();
      await s.secretMailbox.putRequest(req("c1".repeat(32), { expiresAt: 100 }));
      await s.secretMailbox.putResponse(SRV, "c1".repeat(32), "ff".repeat(8), 50, 50);
      expect(await s.secretMailbox.consumeResponse(SRV, "c1".repeat(32), 200)).toBeUndefined();
      // Row is gone.
      expect(await s.secretMailbox.getRequest(SRV, "c1".repeat(32))).toBeUndefined();
    });
  });

  describe("boxSealedLeases", () => {
    const SRV = "home.alice.flagship.services";
    function lease(id: string, over: Partial<{ maxUses: number | null; expiresAt: number; depositedAt: number }> = {}) {
      return {
        serverDomain: SRV,
        leaseId: id,
        stkPubHex: "aa".repeat(32),
        sealedKeyHex: "bb".repeat(48),
        issuedAt: 1_000,
        expiresAt: over.expiresAt ?? 9_000,
        maxUses: over.maxUses === undefined ? null : over.maxUses,
        usesConsumed: 0,
        signatureHex: "cc".repeat(64),
        depositedAt: over.depositedAt ?? 1_000,
      };
    }

    it("release returns the sealed key + increments use count; exhausts at maxUses", async () => {
      const s = new InMemoryStorage();
      await s.boxSealedLeases.put(lease("L1", { maxUses: 2 }));
      const r1 = await s.boxSealedLeases.release(SRV, 2_000);
      expect(r1?.sealedKeyHex).toBe("bb".repeat(48));
      expect(r1?.usesConsumed).toBe(1);
      const r2 = await s.boxSealedLeases.release(SRV, 2_001);
      expect(r2?.usesConsumed).toBe(2);
      expect(await s.boxSealedLeases.release(SRV, 2_002)).toBeUndefined();
    });

    it("unbounded lease (maxUses=null) survives many releases until expiry", async () => {
      const s = new InMemoryStorage();
      await s.boxSealedLeases.put(lease("L2"));
      for (let i = 0; i < 4; i++) expect(await s.boxSealedLeases.release(SRV, 2_000)).toBeDefined();
      expect(await s.boxSealedLeases.release(SRV, 10_001)).toBeUndefined();
    });

    it("release picks the freshest non-expired lease + GCs expired/exhausted", async () => {
      const s = new InMemoryStorage();
      await s.boxSealedLeases.put(lease("old", { depositedAt: 100 }));
      await s.boxSealedLeases.put(lease("new", { depositedAt: 500 }));
      await s.boxSealedLeases.put(lease("expired", { expiresAt: 50, depositedAt: 900 }));
      const r = await s.boxSealedLeases.release(SRV, 200);
      expect(r?.leaseId).toBe("new");
      expect((await s.boxSealedLeases.list(SRV, 200)).map((l) => l.leaseId).sort()).toEqual(["new", "old"]);
    });

    it("revoke drops the lease + list is metadata only", async () => {
      const s = new InMemoryStorage();
      await s.boxSealedLeases.put(lease("L1"));
      expect(await s.boxSealedLeases.revoke(SRV, "missing")).toBe(false);
      expect(await s.boxSealedLeases.revoke(SRV, "L1")).toBe(true);
      expect(await s.boxSealedLeases.release(SRV, 1_000)).toBeUndefined();
    });
  });

  describe("webauthnRecovery", () => {
    function rec(over: Partial<{ username: string; credentialIdHex: string; wrappedUmkB64: string; irkPubHex: string; createdAt: number; updatedAt: number }> = {}) {
      return {
        username: "alice",
        credentialIdHex: "deadbeef",
        wrappedUmkB64: "QUJDRA==", // ABCD
        irkPubHex: "aa".repeat(32),
        createdAt: 1_000,
        updatedAt: 1_000,
        ...over,
      };
    }

    it("upsert + get round-trip (case-insensitive lookup)", async () => {
      const s = new InMemoryStorage();
      await s.webauthnRecovery.upsert(rec({ username: "Alice" }));
      const r = await s.webauthnRecovery.get("alice");
      expect(r?.credentialIdHex).toBe("deadbeef");
    });

    it("upsert overwrites the prior wrappedUmkB64 (passkey rotation)", async () => {
      const s = new InMemoryStorage();
      await s.webauthnRecovery.upsert(rec({ wrappedUmkB64: "first==", updatedAt: 100 }));
      await s.webauthnRecovery.upsert(rec({ wrappedUmkB64: "second==", updatedAt: 200 }));
      const r = await s.webauthnRecovery.get("alice");
      expect(r?.wrappedUmkB64).toBe("second==");
      expect(r?.updatedAt).toBe(200);
    });

    it("delete removes the row and reports the change", async () => {
      const s = new InMemoryStorage();
      await s.webauthnRecovery.upsert(rec());
      expect(await s.webauthnRecovery.delete("alice")).toBe(true);
      expect(await s.webauthnRecovery.get("alice")).toBeUndefined();
      expect(await s.webauthnRecovery.delete("alice")).toBe(false);
    });

    it("get returns undefined for an unknown username", async () => {
      const s = new InMemoryStorage();
      expect(await s.webauthnRecovery.get("ghost")).toBeUndefined();
    });
  });

  describe("pendingUnlockApprovals", () => {
    const SRV = "test.alice.flagship.services";

    it("first upsert returns shouldPush=true and a fresh requestId", async () => {
      const s = new InMemoryStorage();
      const r = await s.pendingUnlockApprovals.upsertWithDedup(SRV, "req-1", 1_000, 60_000);
      expect(r).toEqual({ requestId: "req-1", shouldPush: true });
    });

    it("second upsert within dedup window keeps original requestId and skips push", async () => {
      const s = new InMemoryStorage();
      await s.pendingUnlockApprovals.upsertWithDedup(SRV, "req-1", 1_000, 60_000);
      await s.pendingUnlockApprovals.touchLastPushAt(SRV, 1_000);
      const r = await s.pendingUnlockApprovals.upsertWithDedup(SRV, "req-2", 30_000, 60_000);
      expect(r).toEqual({ requestId: "req-1", shouldPush: false });
    });

    it("upsert outside dedup window returns shouldPush=true (re-push), keeps original requestId", async () => {
      const s = new InMemoryStorage();
      await s.pendingUnlockApprovals.upsertWithDedup(SRV, "req-1", 1_000, 60_000);
      await s.pendingUnlockApprovals.touchLastPushAt(SRV, 1_000);
      const r = await s.pendingUnlockApprovals.upsertWithDedup(SRV, "req-2", 65_000, 60_000);
      expect(r).toEqual({ requestId: "req-1", shouldPush: true });
    });

    it("delete clears the row; subsequent upsert is a fresh row", async () => {
      const s = new InMemoryStorage();
      await s.pendingUnlockApprovals.upsertWithDedup(SRV, "req-1", 1_000, 60_000);
      expect(await s.pendingUnlockApprovals.delete(SRV)).toBe(true);
      expect(await s.pendingUnlockApprovals.get(SRV)).toBeUndefined();
      const r = await s.pendingUnlockApprovals.upsertWithDedup(SRV, "req-fresh", 2_000, 60_000);
      expect(r).toEqual({ requestId: "req-fresh", shouldPush: true });
    });

    it("get returns the persisted row including lastPushAt", async () => {
      const s = new InMemoryStorage();
      await s.pendingUnlockApprovals.upsertWithDedup(SRV, "req-1", 1_000, 60_000);
      await s.pendingUnlockApprovals.touchLastPushAt(SRV, 1_500);
      expect(await s.pendingUnlockApprovals.get(SRV)).toEqual({
        serverDomain: SRV,
        requestId: "req-1",
        requestedAt: 1_000,
        lastPushAt: 1_500,
      });
    });
  });
});

describe("InMemoryCustomDomainOrderStorage (#79A)", () => {
  it("upsert/get round-trips; a new request destructively replaces the prior", async () => {
    const s = new InMemoryStorage();
    await s.customDomainOrders.upsert({
      serviceId: "harry-game1", userId: "Harry", fqdn: "old.example.com",
      status: "pending", lastChanged: 100, failCount: 0, createdAt: 100, updatedAt: 100,
    });
    expect(await s.customDomainOrders.get("harry", "harry-game1")).toMatchObject({
      fqdn: "old.example.com", status: "pending", userId: "harry",
    });
    // Destructive replace — wholesale overwrite, even status/failCount.
    await s.customDomainOrders.upsert({
      serviceId: "harry-game1", userId: "harry", fqdn: "new.example.com",
      status: "pending", lastChanged: 500, failCount: 0, createdAt: 100, updatedAt: 500,
    });
    const r = await s.customDomainOrders.get("harry", "harry-game1");
    expect(r?.fqdn).toBe("new.example.com");
    expect(r?.lastChanged).toBe(500);
  });

  it("setStatus is CAS'd on fqdn (a stale verifier can't clobber a replaced row)", async () => {
    const s = new InMemoryStorage();
    await s.customDomainOrders.upsert({
      serviceId: "a", userId: "u", fqdn: "shop.example.com",
      status: "pending", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    // Stale verifier writing for an old fqdn → no-op.
    expect(await s.customDomainOrders.setStatus("u", "a", "OLD.example.com", "active", 2)).toBe(false);
    // Correct fqdn → applied.
    expect(await s.customDomainOrders.setStatus("u", "a", "shop.example.com", "active", 2)).toBe(true);
    expect((await s.customDomainOrders.get("u", "a"))?.status).toBe("active");
    // failed bumps failCount.
    await s.customDomainOrders.setStatus("u", "a", "shop.example.com", "failed", 3);
    expect((await s.customDomainOrders.get("u", "a"))?.failCount).toBe(1);
  });

  it("listActive returns only active orders", async () => {
    const s = new InMemoryStorage();
    await s.customDomainOrders.upsert({ serviceId: "a1", userId: "u", fqdn: "x.example.com", status: "active", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1 });
    await s.customDomainOrders.upsert({ serviceId: "a2", userId: "u", fqdn: "y.example.com", status: "pending", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1 });
    const active = await s.customDomainOrders.listActive();
    expect(active.map((r) => r.serviceId)).toEqual(["a1"]);
  });
});

describe("CustomDomainOrder podCanonical (#87 Phase 3)", () => {
  it("podCanonical round-trips through upsert/get/listActive", async () => {
    const s = new InMemoryStorage();
    await s.customDomainOrders.upsert({
      serviceId: "a", userId: "u", fqdn: "shop.example.com",
      status: "active", podCanonical: "home.u.flagship.services",
      lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    expect((await s.customDomainOrders.get("u", "a"))?.podCanonical).toBe("home.u.flagship.services");
    const active = await s.customDomainOrders.listActive();
    expect(active[0]?.podCanonical).toBe("home.u.flagship.services");
    // Pending order with no pod yet → undefined (cold-start skips it).
    await s.customDomainOrders.upsert({
      serviceId: "b", userId: "u", fqdn: "p.example.com",
      status: "pending", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    expect((await s.customDomainOrders.get("u", "b"))?.podCanonical).toBeUndefined();
  });
});

describe("CustomDomainOrder listByStatus (#79B)", () => {
  it("filters by status (listActive delegates to it)", async () => {
    const s = new InMemoryStorage();
    await s.customDomainOrders.upsert({ serviceId: "a1", userId: "u", fqdn: "p.example.com", status: "pending", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1 });
    await s.customDomainOrders.upsert({ serviceId: "a2", userId: "u", fqdn: "a.example.com", status: "active", podCanonical: "home.u.flagship.services", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1 });
    await s.customDomainOrders.upsert({ serviceId: "a3", userId: "u", fqdn: "f.example.com", status: "failed", lastChanged: 1, failCount: 3, createdAt: 1, updatedAt: 1 });
    expect((await s.customDomainOrders.listByStatus("pending")).map((r) => r.serviceId)).toEqual(["a1"]);
    expect((await s.customDomainOrders.listByStatus("failed")).map((r) => r.serviceId)).toEqual(["a3"]);
    expect((await s.customDomainOrders.listActive()).map((r) => r.serviceId)).toEqual(["a2"]);
  });
});

describe("InMemoryDemoLlmLedgerStorage (#85)", () => {
  it("sums only grants at or after the window start", async () => {
    const s = new InMemoryStorage();
    const t = 1_000_000_000;
    const win = 24 * 60 * 60_000;
    await s.demoLlmLedger.append("demo", t - win - 1, 100, 0); // out of window, pruned
    await s.demoLlmLedger.append("demo", t - 10_000, 200, t - win);
    await s.demoLlmLedger.append("demo", t, 300, t - win);
    expect(await s.demoLlmLedger.sumSince("demo", t - win)).toBe(500);
    // Boundary is inclusive (>= sinceMs).
    expect(await s.demoLlmLedger.sumSince("demo", t)).toBe(300);
  });
  it("prunes entries older than pruneBefore on append", async () => {
    const s = new InMemoryStorage();
    await s.demoLlmLedger.append("demo", 100, 50, 0);
    await s.demoLlmLedger.append("demo", 200, 50, 0);
    // A later append with pruneBefore=150 drops the grantedAt=100 row.
    await s.demoLlmLedger.append("demo", 300, 50, 150);
    expect(await s.demoLlmLedger.sumSince("demo", 0)).toBe(100); // 200 + 300 only
  });
  it("isolates users", async () => {
    const s = new InMemoryStorage();
    await s.demoLlmLedger.append("a", 10, 999, 0);
    await s.demoLlmLedger.append("b", 10, 1, 0);
    expect(await s.demoLlmLedger.sumSince("a", 0)).toBe(999);
    expect(await s.demoLlmLedger.sumSince("b", 0)).toBe(1);
    expect(await s.demoLlmLedger.sumSince("c", 0)).toBe(0);
  });
});

describe("InMemoryInstallPolicyFanoutStorage (N0d-2)", () => {
  const rec = (serverDomain: string) => ({
    serverDomain,
    username: "alice",
    registeredAt: 1_000,
    fanoutCount: 3,
    notifiedAt: 1_001,
  });

  it("records the first fan-out and reads it back", async () => {
    const s = new InMemoryStorage();
    expect(await s.installPolicyFanout.recordOnce(rec("home.alice.flagship.services"))).toBe(true);
    expect(await s.installPolicyFanout.get("home.alice.flagship.services")).toEqual(
      rec("home.alice.flagship.services"),
    );
  });

  it("recordOnce is idempotent — a retried registration does not re-notify", async () => {
    const s = new InMemoryStorage();
    expect(await s.installPolicyFanout.recordOnce(rec("h.alice.flagship.services"))).toBe(true);
    expect(
      await s.installPolicyFanout.recordOnce({
        ...rec("h.alice.flagship.services"),
        fanoutCount: 99,
      }),
    ).toBe(false);
    // The original row is preserved; the retry did not overwrite it.
    expect((await s.installPolicyFanout.get("h.alice.flagship.services"))?.fanoutCount).toBe(3);
  });

  it("returns undefined for an unknown server", async () => {
    const s = new InMemoryStorage();
    expect(await s.installPolicyFanout.get("nope.flagship.services")).toBeUndefined();
  });
});
