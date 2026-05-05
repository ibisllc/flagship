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
});
