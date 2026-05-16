import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import type { AuthCodeRecord, BuildTicketRecord } from "../src/types.js";

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

function ticket(code: string): BuildTicketRecord {
  return {
    code,
    blobJson: '{"v":1}',
    blobSignatureHex: "33".repeat(64),
    username: "harry",
    serverDomain: "home.harry.flagship.services",
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 3_600_000,
    status: "active",
    redemptions: 0,
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

  it("build tickets: put/get/refresh/markRedeemed all behave", async () => {
    const s = new InMemoryStorage();
    await s.buildTickets.put(ticket("ABCD-EFGH-JKMN"));
    const before = await s.buildTickets.get("ABCD-EFGH-JKMN");
    expect(before?.expiresAt).toBe(1_700_000_000_000 + 3_600_000);
    await s.buildTickets.refresh("ABCD-EFGH-JKMN", 1_800_000_000_000);
    expect((await s.buildTickets.get("ABCD-EFGH-JKMN"))?.expiresAt).toBe(1_800_000_000_000);
    await s.buildTickets.markRedeemed("ABCD-EFGH-JKMN", 1_700_000_500_000);
    expect((await s.buildTickets.get("ABCD-EFGH-JKMN"))?.redemptions).toBe(1);
    await s.buildTickets.markRedeemed("ABCD-EFGH-JKMN", 1_700_000_600_000);
    expect((await s.buildTickets.get("ABCD-EFGH-JKMN"))?.redemptions).toBe(2);
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
      appId: "harry-game1", userId: "Harry", fqdn: "old.example.com",
      status: "pending", lastChanged: 100, failCount: 0, createdAt: 100, updatedAt: 100,
    });
    expect(await s.customDomainOrders.get("harry", "harry-game1")).toMatchObject({
      fqdn: "old.example.com", status: "pending", userId: "harry",
    });
    // Destructive replace — wholesale overwrite, even status/failCount.
    await s.customDomainOrders.upsert({
      appId: "harry-game1", userId: "harry", fqdn: "new.example.com",
      status: "pending", lastChanged: 500, failCount: 0, createdAt: 100, updatedAt: 500,
    });
    const r = await s.customDomainOrders.get("harry", "harry-game1");
    expect(r?.fqdn).toBe("new.example.com");
    expect(r?.lastChanged).toBe(500);
  });

  it("setStatus is CAS'd on fqdn (a stale verifier can't clobber a replaced row)", async () => {
    const s = new InMemoryStorage();
    await s.customDomainOrders.upsert({
      appId: "a", userId: "u", fqdn: "shop.example.com",
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
    await s.customDomainOrders.upsert({ appId: "a1", userId: "u", fqdn: "x.example.com", status: "active", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1 });
    await s.customDomainOrders.upsert({ appId: "a2", userId: "u", fqdn: "y.example.com", status: "pending", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1 });
    const active = await s.customDomainOrders.listActive();
    expect(active.map((r) => r.appId)).toEqual(["a1"]);
  });
});

describe("CustomDomainOrder podCanonical (#87 Phase 3)", () => {
  it("podCanonical round-trips through upsert/get/listActive", async () => {
    const s = new InMemoryStorage();
    await s.customDomainOrders.upsert({
      appId: "a", userId: "u", fqdn: "shop.example.com",
      status: "active", podCanonical: "home.u.flagship.services",
      lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    expect((await s.customDomainOrders.get("u", "a"))?.podCanonical).toBe("home.u.flagship.services");
    const active = await s.customDomainOrders.listActive();
    expect(active[0]?.podCanonical).toBe("home.u.flagship.services");
    // Pending order with no pod yet → undefined (cold-start skips it).
    await s.customDomainOrders.upsert({
      appId: "b", userId: "u", fqdn: "p.example.com",
      status: "pending", lastChanged: 1, failCount: 0, createdAt: 1, updatedAt: 1,
    });
    expect((await s.customDomainOrders.get("u", "b"))?.podCanonical).toBeUndefined();
  });
});
