import { describe, expect, it } from "vitest";
import {
  InMemoryAcmeAccountKeyGrantStorage,
  type AcmeAccountKeyGrantRecord,
} from "../src/index.js";

function rec(over: Partial<AcmeAccountKeyGrantRecord> = {}): AcmeAccountKeyGrantRecord {
  return {
    grantId: "g1",
    username: "dani",
    accountKeyId: "key-aaa",
    recipientPubHex: "aa".repeat(32),
    sealedAccountKeyHex: "cc".repeat(48),
    issuedAt: 1000,
    expiresAt: 2000,
    signatureHex: "bb".repeat(64),
    revokedAt: null,
    ...over,
  };
}

describe("InMemoryAcmeAccountKeyGrantStorage", () => {
  it("put / get / listForUser round-trip (case-insensitive user)", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    expect((await s.put(rec())).ok).toBe(true);
    expect((await s.get("g1"))?.username).toBe("dani");
    expect((await s.get("g1"))?.sealedAccountKeyHex).toBe("cc".repeat(48));
    expect(await s.get("nope")).toBeUndefined();
    expect((await s.listForUser("DANI")).length).toBe(1);
  });

  it("rejects a duplicate grantId; the prior row is untouched", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    expect((await s.put(rec({ grantId: "g1", accountKeyId: "key-aaa" }))).ok).toBe(true);
    expect(await s.put(rec({ grantId: "g1", accountKeyId: "key-bbb" }))).toEqual({
      ok: false,
      reason: "duplicate acme account key grant id",
    });
    // Original survived (not overwritten by the rejected put).
    expect((await s.get("g1"))?.accountKeyId).toBe("key-aaa");
  });

  it("ALLOWS multiple active grants per user (one per admin device)", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    // Two admin devices, same account + same account key, different recipients.
    expect(
      (await s.put(rec({ grantId: "g1", recipientPubHex: "11".repeat(32) }))).ok,
    ).toBe(true);
    expect(
      (await s.put(rec({ grantId: "g2", recipientPubHex: "22".repeat(32) }))).ok,
    ).toBe(true);
    const active = await s.getActiveForUser("dani");
    expect(active.map((r) => r.grantId).sort()).toEqual(["g1", "g2"]);
  });

  it("getActiveForUser returns all active, newest-first, excludes revoked", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    await s.put(rec({ grantId: "g1", recipientPubHex: "11".repeat(32), issuedAt: 1000 }));
    await s.put(rec({ grantId: "g2", recipientPubHex: "22".repeat(32), issuedAt: 3000 }));
    await s.put(rec({ grantId: "g3", recipientPubHex: "33".repeat(32), issuedAt: 2000 }));
    expect((await s.getActiveForUser("dani")).map((r) => r.grantId)).toEqual([
      "g2",
      "g3",
      "g1",
    ]);
    await s.revoke("g2", 4000);
    expect((await s.getActiveForUser("dani")).map((r) => r.grantId)).toEqual(["g3", "g1"]);
  });

  it("getActiveByRecipient returns only that device's active grants", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    await s.put(rec({ grantId: "g1", recipientPubHex: "11".repeat(32) }));
    await s.put(rec({ grantId: "g2", recipientPubHex: "22".repeat(32) }));
    expect((await s.getActiveByRecipient("11".repeat(32))).map((r) => r.grantId)).toEqual([
      "g1",
    ]);
    // Case-insensitive pubkey match.
    expect((await s.getActiveByRecipient("22".repeat(32).toUpperCase())).map((r) => r.grantId)).toEqual([
      "g2",
    ]);
    await s.revoke("g1", 5000);
    expect(await s.getActiveByRecipient("11".repeat(32))).toEqual([]);
  });

  it("revoke flips revoked_at but keeps the row for audit", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    await s.put(rec({ grantId: "g1" }));
    await s.revoke("g1", 1500);
    expect((await s.get("g1"))?.revokedAt).toBe(1500);
    expect((await s.listForUser("dani")).length).toBe(1);
    expect((await s.getActiveForUser("dani")).length).toBe(0);
  });

  it("revoke throws on an unknown grantId", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    await expect(s.revoke("nope", 1)).rejects.toThrow(/unknown grantId/);
  });

  it("revokeByAccountKeyId tombstones EVERY active grant of a rotated key", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    // Three devices on key-aaa (two users), one device on key-bbb.
    await s.put(rec({ grantId: "g1", username: "dani", accountKeyId: "key-aaa", recipientPubHex: "11".repeat(32) }));
    await s.put(rec({ grantId: "g2", username: "dani", accountKeyId: "key-aaa", recipientPubHex: "22".repeat(32) }));
    await s.put(rec({ grantId: "g3", username: "robin", accountKeyId: "key-aaa", recipientPubHex: "33".repeat(32) }));
    await s.put(rec({ grantId: "g4", username: "dani", accountKeyId: "key-bbb", recipientPubHex: "44".repeat(32) }));
    // One of key-aaa is already revoked — it must NOT be counted again.
    await s.revoke("g2", 1500);

    const n = await s.revokeByAccountKeyId("key-aaa", 6000);
    expect(n).toBe(2); // g1 + g3 (g2 was already revoked)
    expect((await s.get("g1"))?.revokedAt).toBe(6000);
    expect((await s.get("g3"))?.revokedAt).toBe(6000);
    expect((await s.get("g2"))?.revokedAt).toBe(1500); // unchanged
    // The other key is untouched.
    expect((await s.get("g4"))?.revokedAt).toBeNull();
  });

  it("revokeByAccountKeyId returns 0 when no active grant matches", async () => {
    const s = new InMemoryAcmeAccountKeyGrantStorage();
    await s.put(rec({ grantId: "g1", accountKeyId: "key-aaa" }));
    expect(await s.revokeByAccountKeyId("key-zzz", 7000)).toBe(0);
    expect((await s.get("g1"))?.revokedAt).toBeNull();
  });
});
