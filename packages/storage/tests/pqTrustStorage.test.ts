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
  });
}
