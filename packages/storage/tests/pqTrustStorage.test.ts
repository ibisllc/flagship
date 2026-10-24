/**
 * Architecture v2 (migration 0111): key bindings, boot-key hybrid signatures and policy state,
 * against the in-memory store and the production D1 adapter (node:sqlite, every migration).
 */
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import { D1Storage } from "../src/d1.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import type { PqKeyBindingRecord, PolicyStateRecord } from "../src/pqTrust.js";
import type { Storage } from "../src/types.js";

const handles: SqliteD1[] = [];
afterAll(() => handles.forEach((h) => h.close()));

const backends: Array<[string, () => Storage]> = [
  ["in-memory", () => new InMemoryStorage()],
  ["D1", () => {
    const h = createSqliteD1();
    handles.push(h);
    return new D1Storage(h as never);
  }],
];

const D = "home.alice.flagship.services";
const rec = (over: Partial<PqKeyBindingRecord> = {}): PqKeyBindingRecord => ({
  role: "box-stk", subjectId: D, ed25519PubHex: "aa".repeat(32), mldsaPubHex: "bb".repeat(1952), issuedAt: 10, signatureHex: "cc".repeat(3373), storedAt: 11, ...over,
});
const pol = (over: Partial<PolicyStateRecord> = {}): PolicyStateRecord => ({
  scopeKind: "installation", scopeId: D, profile: "strict", rollout: "enforced", generation: 2, headDigest: "dd".repeat(32), enforcedEver: true, updatedAt: 5, ...over,
});

for (const [name, make] of backends) {
  describe(`pq trust storage (${name})`, () => {
    it("keeps the first ML-DSA key per Ed25519 key, takes newer same-key bindings and a new STK", async () => {
      const s = make().pqTrust;
      expect(await s.forServer(D)).toEqual({ policy: null, stkBinding: null });
      expect(await s.putBinding(rec())).toEqual({ ok: true });
      expect(await s.putBinding(rec())).toEqual({ ok: false, reason: "stale" });
      expect(await s.putBinding(rec({ mldsaPubHex: "ee".repeat(1952), issuedAt: 99 }))).toEqual({ ok: false, reason: "pq-key-changed" });
      expect(await s.putBinding(rec({ issuedAt: 20 }))).toEqual({ ok: true });
      expect((await s.getBinding("box-stk", D))!.issuedAt).toBe(20);
      expect(await s.putBinding(rec({ ed25519PubHex: "ff".repeat(32), mldsaPubHex: "ee".repeat(1952), issuedAt: 1 }))).toEqual({ ok: true });
      expect((await s.getBinding("box-stk", D))!.ed25519PubHex).toBe("ff".repeat(32));
      expect(await s.getBinding("device", D)).toBeNull();
    });

    it("reads the installation policy and the STK binding together", async () => {
      const s = make().pqTrust;
      await s.putBinding(rec());
      expect(await s.forServer(D)).toEqual({ policy: null, stkBinding: rec() });
      await s.putPolicy(pol());
      await s.putPolicy(pol({ generation: 1, profile: "compatibility" }));
      expect(await s.forServer(D.toUpperCase())).toEqual({ policy: pol(), stkBinding: rec() });
      await s.putBinding(rec({ role: "device", subjectId: "dev_1" }));
      expect((await s.forServer("other.alice.flagship.services")).stkBinding).toBeNull();
    });

    it("stores the boot-key hybrid signature per server", async () => {
      const s = make().pqTrust;
      expect(await s.getBootHybrid(D)).toBeNull();
      const b = { serverDomain: D, stkPubHex: "aa".repeat(32), bootKeyPubHex: "bb".repeat(32), issuedAt: 3, hybridSignatureHex: "cc".repeat(3373), storedAt: 4 };
      await s.putBootHybrid(b);
      await s.putBootHybrid({ ...b, issuedAt: 4 });
      expect(await s.getBootHybrid(D)).toEqual({ ...b, issuedAt: 4 });
    });
    it("lists an account's identity and device bindings in one read", async () => {
      const s = make().pqTrust;
      await s.putBinding(rec({ role: "account-irk", subjectId: "alice" }));
      await s.putBinding(rec({ role: "admin-root", subjectId: "alice" }));
      await s.putBinding(rec({ role: "device", subjectId: "d1".repeat(16) }));
      await s.putBinding(rec({ role: "device", subjectId: "d2".repeat(16) }));
      await s.putBinding(rec({ role: "account-irk", subjectId: "bob" }));
      const got = await s.listAccountBindings("Alice", ["d1".repeat(16)]);
      expect(got.map((b) => `${b.role}:${b.subjectId}`).sort()).toEqual(["account-irk:alice", "admin-root:alice", `device:${"d1".repeat(16)}`]);
      expect((await s.listAccountBindings("alice", [])).length).toBe(2);
    });

    it("lists the bindings of the account's live devices when no ids are given", async () => {
      const all = make();
      const s = all.pqTrust;
      await all.usernames.put({ username: "alice", irkPubHex: "ac".repeat(32), claimedAt: 1 });
      await all.deviceIdentities.put({ accountId: "alice", deviceId: "d1".repeat(16), devicePubHex: "aa".repeat(32), platformClass: null, createdAt: 1, lastSeenAt: 1, revokedAt: null });
      await all.deviceIdentities.put({ accountId: "alice", deviceId: "d3".repeat(16), devicePubHex: "ab".repeat(32), platformClass: null, createdAt: 1, lastSeenAt: 1, revokedAt: null });
      await all.deviceIdentities.revoke("alice", "d3".repeat(16), 2);
      await s.putBinding(rec({ role: "account-irk", subjectId: "alice" }));
      await s.putBinding(rec({ role: "device", subjectId: "d1".repeat(16) }));
      await s.putBinding(rec({ role: "device", subjectId: "d3".repeat(16) }));
      const got = (await s.listAccountBindings("alice")).map((b) => `${b.role}:${b.subjectId}`).sort();
      expect(got).toEqual(name === "D1" ? ["account-irk:alice", `device:${"d1".repeat(16)}`] : ["account-irk:alice", `device:${"d1".repeat(16)}`, `device:${"d3".repeat(16)}`]);
    });

    it("appends policy changes only at the head, once per generation", async () => {
      const s = make().pqTrust;
      const ch = (generation: number, digest: string, prevDigest: string) => ({
        scopeKind: "installation", scopeId: D, generation, account: "alice", changeJson: "{}", suite: "hybrid-ed25519-mldsa65/v1", signatureHex: "aa", digest, prevDigest, storedAt: 1,
      });
      const zero = "0".repeat(64);
      const d1 = "11".repeat(32);
      const d2 = "22".repeat(32);
      expect(await s.appendPolicyChange(ch(1, d1, zero), pol({ generation: 1, headDigest: d1 }), { generation: 0, headDigest: zero })).toEqual({ ok: true });
      expect(await s.appendPolicyChange(ch(1, d2, zero), pol({ generation: 1, headDigest: d2 }), { generation: 0, headDigest: zero })).toEqual({ ok: false, reason: "conflict" });
      expect(await s.appendPolicyChange(ch(2, d2, d1), pol({ generation: 2, headDigest: d2 }), { generation: 1, headDigest: zero })).toEqual({ ok: false, reason: "conflict" });
      expect(await s.appendPolicyChange(ch(2, d2, d1), pol({ generation: 2, headDigest: d2 }), { generation: 1, headDigest: d1 })).toEqual({ ok: true });
      expect((await s.listPolicyChanges("installation", D)).map((c) => c.digest)).toEqual([d1, d2]);
      expect(await s.getPolicy("installation", D)).toMatchObject({ generation: 2, headDigest: d2 });
      expect(await s.listPolicyChanges("installation", "other")).toEqual([]);
    });
  });
}
