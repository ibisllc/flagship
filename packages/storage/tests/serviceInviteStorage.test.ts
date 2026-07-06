/**
 * ServiceInviteStorage adapter contract (docs/service-access-gating.md).
 *
 * Runs the SAME assertion set against BOTH adapters: InMemory directly + the
 * D1 adapter over a REAL node:sqlite database with every migration applied (so
 * the `0056_service_invites` UNIQUE(secret_hash) index + the conditional
 * first-bind UPDATE are the production ones). The first-bind / same-AID-
 * idempotent / reject-different-AID redeem semantics are the heart of the
 * feature, so they're asserted identically on both surfaces.
 */
import { describe, expect, it } from "vitest";
import {
  D1Storage,
  InMemoryStorage,
  type ServiceInviteStorage,
} from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

function freshStore(adapter: "InMemory" | "D1"): {
  store: ServiceInviteStorage;
  cleanup: () => void;
} {
  if (adapter === "InMemory") {
    return { store: new InMemoryStorage().serviceInvites, cleanup: () => {} };
  }
  const sqlite = createSqliteD1();
  return { store: new D1Storage(sqlite).serviceInvites, cleanup: () => sqlite.close() };
}

const AUTHOR = "aa".repeat(32);
const FRIEND = "bb".repeat(32);
const OTHER = "cc".repeat(32);

function mk(overrides: Partial<{
  inviteId: string;
  authorAID: string;
  serviceRef: string;
  encryptedBundle: string;
  secretHash: string;
  createdAt: number;
}> = {}) {
  return {
    inviteId: "id1",
    authorAID: AUTHOR,
    serviceRef: "alice-notes",
    encryptedBundle: "deadbeef",
    secretHash: "11".repeat(32),
    createdAt: 1000,
    ...overrides,
  };
}

const ADAPTERS: ("InMemory" | "D1")[] = ["InMemory", "D1"];

describe("ServiceInviteStorage parity", () => {
  for (const adapter of ADAPTERS) {
    describe(adapter, () => {
      const run = async (fn: (store: ServiceInviteStorage) => Promise<void>) => {
        const { store, cleanup } = freshStore(adapter);
        try {
          await fn(store);
        } finally {
          cleanup();
        }
      };

      it("creates and reads back an invite (unbound, unrevoked)", () =>
        run(async (store) => {
          expect(await store.create(mk())).toEqual({ ok: true });
          const got = await store.get("id1");
          expect(got).toBeDefined();
          expect(got!.authorAID).toBe(AUTHOR);
          expect(got!.serviceRef).toBe("alice-notes");
          expect(got!.encryptedBundle).toBe("deadbeef");
          expect(got!.secretHash).toBe("11".repeat(32));
          expect(got!.boundAID).toBeNull();
          expect(got!.boundAt).toBeNull();
          expect(got!.revokedAt).toBeNull();
        }));

      it("create is idempotent on an identical re-create; rejects an id clash", () =>
        run(async (store) => {
          expect(await store.create(mk())).toEqual({ ok: true });
          expect(await store.create(mk())).toEqual({ ok: true }); // identical
          // same id, different serviceRef + secret → duplicate
          const clash = await store.create(
            mk({ serviceRef: "alice-secret", secretHash: "99".repeat(32) }),
          );
          expect(clash.ok).toBe(false);
        }));

      it("rejects a second invite reusing the same secret_hash", () =>
        run(async (store) => {
          expect(await store.create(mk({ inviteId: "id1" }))).toEqual({ ok: true });
          const dup = await store.create(mk({ inviteId: "id2" })); // same secretHash
          expect(dup.ok).toBe(false);
        }));

      it("FIRST redeem binds the visitor AID (firstBind:true)", () =>
        run(async (store) => {
          await store.create(mk());
          const res = await store.redeem("11".repeat(32), FRIEND, 2000);
          expect(res.ok).toBe(true);
          if (res.ok) {
            expect(res.firstBind).toBe(true);
            expect(res.record.boundAID).toBe(FRIEND);
            expect(res.record.boundAt).toBe(2000);
          }
          const got = await store.get("id1");
          expect(got!.boundAID).toBe(FRIEND);
          expect(got!.boundAt).toBe(2000);
        }));

      it("re-redeem by the SAME AID is idempotent (firstBind:false, no re-bind)", () =>
        run(async (store) => {
          await store.create(mk());
          await store.redeem("11".repeat(32), FRIEND, 2000);
          const again = await store.redeem("11".repeat(32), FRIEND, 9999);
          expect(again.ok).toBe(true);
          if (again.ok) {
            expect(again.firstBind).toBe(false);
            // boundAt is NOT bumped on the idempotent re-redeem
            expect(again.record.boundAt).toBe(2000);
          }
        }));

      it("redeem by a DIFFERENT AID after binding is rejected (409 'already bound')", () =>
        run(async (store) => {
          await store.create(mk());
          await store.redeem("11".repeat(32), FRIEND, 2000);
          const other = await store.redeem("11".repeat(32), OTHER, 3000);
          expect(other).toEqual({ ok: false, reason: "already bound" });
          // binding is unchanged
          expect((await store.get("id1"))!.boundAID).toBe(FRIEND);
        }));

      it("redeem of an unknown secret is rejected", () =>
        run(async (store) => {
          const res = await store.redeem("ff".repeat(32), FRIEND, 1);
          expect(res).toEqual({ ok: false, reason: "unknown secret" });
        }));

      it("revoke denies an UNREDEEMED invite's first redeem", () =>
        run(async (store) => {
          await store.create(mk());
          expect(await store.revoke("id1", 1500)).toBe(true);
          const res = await store.redeem("11".repeat(32), FRIEND, 2000);
          expect(res).toEqual({ ok: false, reason: "revoked" });
        }));

      it("revoke after a bind denies even the SAME AID's re-redeem", () =>
        run(async (store) => {
          await store.create(mk());
          await store.redeem("11".repeat(32), FRIEND, 2000);
          expect(await store.revoke("id1", 2500)).toBe(true);
          const res = await store.redeem("11".repeat(32), FRIEND, 3000);
          expect(res).toEqual({ ok: false, reason: "revoked" });
        }));

      it("revoke is idempotent (preserves first revokedAt); unknown id → false", () =>
        run(async (store) => {
          await store.create(mk());
          expect(await store.revoke("id1", 1500)).toBe(true);
          expect(await store.revoke("id1", 9999)).toBe(true);
          expect((await store.get("id1"))!.revokedAt).toBe(1500);
          expect(await store.revoke("nope", 1)).toBe(false);
        }));

      it("getBySecretHash resolves the redeem-path read; lookups are case-insensitive", () =>
        run(async (store) => {
          await store.create(mk({ secretHash: "ABCD".repeat(16) }));
          const lower = await store.getBySecretHash("abcd".repeat(16));
          expect(lower).toBeDefined();
          expect(lower!.inviteId).toBe("id1");
          // redeem with mixed-case secret + author AID still matches
          const res = await store.redeem("AbCd".repeat(16), FRIEND.toUpperCase(), 7);
          expect(res.ok).toBe(true);
          if (res.ok) expect(res.record.boundAID).toBe(FRIEND); // stored lower-cased
        }));

      it("listForAuthor returns an author's invites createdAt DESC, scoped per author", () =>
        run(async (store) => {
          await store.create(mk({ inviteId: "a", secretHash: "01".repeat(32), createdAt: 10 }));
          await store.create(mk({ inviteId: "b", secretHash: "02".repeat(32), createdAt: 30 }));
          await store.create(mk({ inviteId: "c", secretHash: "03".repeat(32), createdAt: 20 }));
          await store.create(
            mk({ inviteId: "d", authorAID: OTHER, secretHash: "04".repeat(32), createdAt: 99 }),
          );
          const mine = await store.listForAuthor(AUTHOR);
          expect(mine.map((r) => r.inviteId)).toEqual(["b", "c", "a"]);
          const theirs = await store.listForAuthor(OTHER);
          expect(theirs.map((r) => r.inviteId)).toEqual(["d"]);
        }));

      it("returns undefined / [] for unknown keys", () =>
        run(async (store) => {
          expect(await store.get("nope")).toBeUndefined();
          expect(await store.getBySecretHash("ff".repeat(32))).toBeUndefined();
          expect(await store.listForAuthor("ee".repeat(32))).toEqual([]);
        }));

      // ── v2 hardening (migration 0057) ───────────────────────────────
      it("v1-shaped create lands the v2 defaults (no sig, single-use, auto, 0)", () =>
        run(async (store) => {
          await store.create(mk());
          const got = (await store.get("id1"))!;
          expect(got.createSig).toBeNull();
          expect(got.maxRedemptions).toBeNull();
          expect(got.expiresAt).toBeNull();
          expect(got.redemptions).toBe(0);
          expect(got.approvalMode).toBe("auto");
          expect(got.boundAIDs).toEqual([]);
        }));

      it("create persists createSig + maxRedemptions + expiresAt + approvalMode", () =>
        run(async (store) => {
          await store.create({
            ...mk(),
            createSig: "ab".repeat(64),
            maxRedemptions: 3,
            expiresAt: 5000,
            approvalMode: "manual",
          });
          const got = (await store.get("id1"))!;
          expect(got.createSig).toBe("ab".repeat(64));
          expect(got.maxRedemptions).toBe(3);
          expect(got.expiresAt).toBe(5000);
          expect(got.approvalMode).toBe("manual");
        }));

      it("a GROUP invite (maxN) binds multiple AIDs; boundAID stays the first", () =>
        run(async (store) => {
          await store.create({ ...mk(), maxRedemptions: 3 });
          const a = await store.redeem("11".repeat(32), FRIEND, 100);
          const b = await store.redeem("11".repeat(32), OTHER, 200);
          expect(a.ok && a.firstBind).toBe(true);
          expect(b.ok && b.firstBind).toBe(true);
          const got = (await store.get("id1"))!;
          expect(got.boundAID).toBe(FRIEND); // FIRST bind, v1-compatible
          expect(got.boundAt).toBe(100);
          expect(got.boundAIDs).toEqual([FRIEND, OTHER]);
          expect(got.redemptions).toBe(2);
        }));

      it("GROUP re-redeem of an already-bound AID is idempotent (firstBind:false)", () =>
        run(async (store) => {
          await store.create({ ...mk(), maxRedemptions: 3 });
          await store.redeem("11".repeat(32), FRIEND, 100);
          const again = await store.redeem("11".repeat(32), FRIEND, 999);
          expect(again.ok && again.firstBind).toBe(false);
          expect((await store.get("id1"))!.redemptions).toBe(1);
        }));

      it("GROUP enforces the cap: a new AID over maxN is rejected", () =>
        run(async (store) => {
          await store.create({ ...mk(), maxRedemptions: 2 });
          await store.redeem("11".repeat(32), FRIEND, 100);
          await store.redeem("11".repeat(32), OTHER, 200);
          const third = await store.redeem("11".repeat(32), "dd".repeat(32), 300);
          expect(third).toEqual({ ok: false, reason: "max redemptions reached" });
          expect((await store.get("id1"))!.boundAIDs).toEqual([FRIEND, OTHER]);
        }));

      it("maxRedemptions:0 is unlimited", () =>
        run(async (store) => {
          await store.create({ ...mk(), maxRedemptions: 0 });
          for (let i = 0; i < 5; i++) {
            const r = await store.redeem("11".repeat(32), `0${i}`.repeat(32), 10 + i);
            expect(r.ok).toBe(true);
          }
          expect((await store.get("id1"))!.redemptions).toBe(5);
        }));

      it("an expired invite rejects redeem", () =>
        run(async (store) => {
          await store.create({ ...mk(), expiresAt: 1000 });
          const ok = await store.redeem("11".repeat(32), FRIEND, 999); // before expiry
          expect(ok.ok).toBe(true);
          await store.create({ ...mk({ inviteId: "id2", secretHash: "22".repeat(32) }), expiresAt: 1000 });
          const late = await store.redeem("22".repeat(32), FRIEND, 1001); // after expiry
          expect(late).toEqual({ ok: false, reason: "expired" });
        }));

      it("revokedSince returns revoked invites + their bound AIDs after the cursor, ASC", () =>
        run(async (store) => {
          await store.create({ ...mk({ inviteId: "g1", secretHash: "a1".repeat(32) }), maxRedemptions: 5 });
          await store.redeem("a1".repeat(32), FRIEND, 50);
          await store.redeem("a1".repeat(32), OTHER, 60);
          await store.create(mk({ inviteId: "p1", secretHash: "a2".repeat(32) }));
          await store.redeem("a2".repeat(32), "ee".repeat(32), 70);
          // revoke p1 first (older), then g1 (newer)
          await store.revoke("p1", 100);
          await store.revoke("g1", 200);
          const all = await store.revokedSince(AUTHOR, 0);
          expect(all.map((r) => r.inviteId)).toEqual(["p1", "g1"]); // revokedAt ASC
          expect(all[1]!.boundAIDs).toEqual([FRIEND, OTHER]);
          // cursor excludes p1 (revokedAt 100)
          const after = await store.revokedSince(AUTHOR, 100);
          expect(after.map((r) => r.inviteId)).toEqual(["g1"]);
          // scoped per author
          expect(await store.revokedSince(OTHER, 0)).toEqual([]);
        }));
    });
  }
});
