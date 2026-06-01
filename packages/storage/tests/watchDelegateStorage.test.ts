import { describe, expect, it } from "vitest";
import { InMemoryWatchDelegateStorage, type WatchDelegateRecord } from "../src/index.js";

function rec(over: Partial<WatchDelegateRecord> = {}): WatchDelegateRecord {
  return {
    grantId: "g1",
    username: "dani",
    delegatePubHex: "aa".repeat(32),
    scopesJson: JSON.stringify(["boot-approval"]),
    issuedAt: 1000,
    expiresAt: 2000,
    signatureHex: "bb".repeat(64),
    revokedAt: null,
    ...over,
  };
}

describe("InMemoryWatchDelegateStorage", () => {
  it("put / get / listForUser round-trip (case-insensitive)", async () => {
    const s = new InMemoryWatchDelegateStorage();
    expect((await s.put(rec())).ok).toBe(true);
    expect((await s.get("g1"))?.username).toBe("dani");
    expect(await s.get("nope")).toBeUndefined();
    expect((await s.listForUser("DANI")).length).toBe(1);
  });

  it("rejects a duplicate ACTIVE delegate for the same user; allows after revoke", async () => {
    const s = new InMemoryWatchDelegateStorage();
    expect((await s.put(rec({ grantId: "g1" }))).ok).toBe(true);
    expect(await s.put(rec({ grantId: "g2" }))).toEqual({
      ok: false,
      reason: "duplicate active watch delegate for user",
    });
    await s.revoke("g1", 1500);
    expect((await s.put(rec({ grantId: "g2" }))).ok).toBe(true);
  });

  it("getActiveForUser + getActiveByDelegatePub return only the active row", async () => {
    const s = new InMemoryWatchDelegateStorage();
    await s.put(rec({ grantId: "g1" }));
    expect((await s.getActiveForUser("dani"))?.grantId).toBe("g1");
    expect((await s.getActiveByDelegatePub("AA".repeat(32)))?.grantId).toBe("g1");
    await s.revoke("g1", 1500);
    expect(await s.getActiveForUser("dani")).toBeUndefined();
    expect(await s.getActiveByDelegatePub("aa".repeat(32))).toBeUndefined();
  });

  it("revoke throws on an unknown grantId", async () => {
    const s = new InMemoryWatchDelegateStorage();
    await expect(s.revoke("nope", 1)).rejects.toThrow(/unknown grantId/);
  });
});
