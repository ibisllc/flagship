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
});
