/**
 * D1 ↔ InMemory adapter PARITY suite — the CAS / conditional-UPDATE /
 * INSERT-OR-IGNORE / idempotent-consume surface (OPS-A, wave 2).
 *
 * The companion `parity.test.ts` covers ~14 stores (usernames, authCodes,
 * routing, pendingRePairs, deviceCapabilityGrants, …). This file extends
 * coverage to the highest-risk REMAINING stores: every store whose D1
 * adapter branches on `meta.changes`, a conditional `UPDATE … WHERE`, an
 * `INSERT OR IGNORE` / `ON CONFLICT`, or a delete-on-consume idempotency
 * primitive — the exact class where D1 and InMemory most easily diverge
 * (D1 reporting `changes:0` / throwing a UNIQUE error where the map silently
 * succeeds, or returning a row a second time after a consume).
 *
 * Mechanism (identical to parity.test.ts): the REAL production D1 adapter
 * (`src/d1.ts`) is driven against an in-process `node:sqlite` with EVERY
 * migration 0001..NNNN applied (support/sqliteD1.ts), so the UNIQUE indexes,
 * partial indexes, `ON CONFLICT … WHERE` clauses, column DEFAULTs and NULL
 * handling are the production ones. Each `parityCase` runs ONE operation
 * sequence twice — once per fresh adapter — and asserts the two produced the
 * deep-equal observable result (return values, changes-derived booleans,
 * conflict/idempotency behavior, ordering). Where the two adapters
 * LEGITIMATELY differ (e.g. demo_users' insert-collision reason string,
 * which the contract deliberately leaves unpinned), the difference is
 * asserted EXPLICITLY with a comment, never silently tolerated.
 *
 * This wave found + fixed one real divergence — InMemory
 * `mintReservations.tryAcquire` preserved the original `acquiredAt` on a
 * same-holder re-acquire while the D1 `ON CONFLICT … SET acquired_at =
 * excluded.acquired_at` rewrites it to `now`. InMemory was corrected to
 * mirror prod; the test below pins the agreed behavior so it can't regress.
 */
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import { D1Storage } from "../src/d1.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import type { Storage } from "../src/types.js";

const openHandles: SqliteD1[] = [];
afterAll(() => {
  for (const h of openHandles) h.close();
});

/** A fresh InMemory + D1-over-SQLite pair sharing no state. */
function freshPair(): { mem: Storage; d1: Storage } {
  const sqlite = createSqliteD1();
  openHandles.push(sqlite);
  return { mem: new InMemoryStorage(), d1: new D1Storage(sqlite) };
}

/**
 * Run one operation sequence against a fresh InMemory store and a fresh
 * D1-over-SQLite store, then assert the two produced byte/shape-identical
 * observable output. `body` MUST be pure w.r.t. the passed store (no shared
 * mutable closure state) so the two runs are independent. Returns the shared
 * result so the caller can pin the concrete expected shape too.
 */
async function parityCase<T>(body: (s: Storage) => Promise<T>): Promise<T> {
  const { mem, d1 } = freshPair();
  const memResult = await body(mem);
  const d1Result = await body(d1);
  expect(d1Result).toEqual(memResult);
  return d1Result;
}

describe("D1 ↔ InMemory parity — CAS / conditional surface", () => {
  // ────────────────────────────────────────────────────────────────────
  // autoUnlockLeases — the consume-deletes-row one-shot idempotency. A
  // one-shot lease must be returned EXACTLY once then vanish; a multi-use
  // lease survives repeated consumes; expired rows GC on consume.
  // ────────────────────────────────────────────────────────────────────
  describe("autoUnlockLeases", () => {
    const mk = (
      domain: string,
      leaseId: string,
      multiUse: boolean,
      dep: number,
      exp: number,
    ) => ({
      serverDomain: domain,
      leaseId,
      unlockKeyHex: `key-${leaseId}`,
      multiUse,
      depositedAt: dep,
      expiresAt: exp,
    });

    it("one-shot lease is consumed exactly once then gone", async () => {
      const r = await parityCase(async (s) => {
        await s.autoUnlockLeases.put(mk("box.alice", "L1", false, 1, 10_000));
        const first = await s.autoUnlockLeases.consume("box.alice", 100);
        const second = await s.autoUnlockLeases.consume("box.alice", 100);
        return { firstKey: first?.unlockKeyHex, secondDefined: second !== undefined };
      });
      expect(r).toEqual({ firstKey: "key-L1", secondDefined: false });
    });

    it("multi-use lease survives repeated consume", async () => {
      const r = await parityCase(async (s) => {
        await s.autoUnlockLeases.put(mk("box.alice", "M1", true, 1, 10_000));
        const a = await s.autoUnlockLeases.consume("box.alice", 100);
        const b = await s.autoUnlockLeases.consume("box.alice", 100);
        return { a: a?.leaseId, b: b?.leaseId, multiUse: a?.multiUse };
      });
      expect(r).toEqual({ a: "M1", b: "M1", multiUse: true });
    });

    it("consume picks the freshest non-expired; expired rows GC'd", async () => {
      const r = await parityCase(async (s) => {
        await s.autoUnlockLeases.put(mk("box.alice", "old", true, 1, 50)); // expired at now=100
        await s.autoUnlockLeases.put(mk("box.alice", "newer", true, 20, 10_000));
        await s.autoUnlockLeases.put(mk("box.alice", "newest", true, 30, 10_000));
        const picked = await s.autoUnlockLeases.consume("box.alice", 100);
        const live = (await s.autoUnlockLeases.list("box.alice", 100))
          .map((l) => l.leaseId)
          .sort();
        return { picked: picked?.leaseId, live };
      });
      // "old" is GC'd by the consume's expiry sweep; "newest" (latest
      // depositedAt) wins the pick; both multi-use rows remain listable.
      expect(r).toEqual({ picked: "newest", live: ["newer", "newest"] });
    });

    it("revoke returns whether a row was deleted; consume of nothing is undefined", async () => {
      const r = await parityCase(async (s) => {
        await s.autoUnlockLeases.put(mk("box.alice", "R1", true, 1, 10_000));
        const revoked = await s.autoUnlockLeases.revoke("box.alice", "R1");
        const revokeMissing = await s.autoUnlockLeases.revoke("box.alice", "ghost");
        const consumeEmpty = await s.autoUnlockLeases.consume("box.alice", 100);
        return { revoked, revokeMissing, consumeEmptyDefined: consumeEmpty !== undefined };
      });
      expect(r).toEqual({ revoked: true, revokeMissing: false, consumeEmptyDefined: false });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // boxSealedLeases — release increments uses_consumed; deletes the row on
  // reaching max_uses (one-shot maxUses=1 is gone after first release).
  // The returned record carries the POST-increment uses_consumed.
  // ────────────────────────────────────────────────────────────────────
  describe("boxSealedLeases", () => {
    const mk = (
      domain: string,
      leaseId: string,
      maxUses: number | null,
      dep: number,
      exp: number,
    ) => ({
      serverDomain: domain,
      leaseId,
      stkPubHex: `stk-${leaseId}`,
      sealedKeyHex: `sealed-${leaseId}`,
      issuedAt: 1,
      expiresAt: exp,
      maxUses,
      usesConsumed: 0,
      signatureHex: "sig",
      depositedAt: dep,
    });

    it("maxUses=1 one-shot: released once (usesConsumed=1) then gone", async () => {
      const r = await parityCase(async (s) => {
        await s.boxSealedLeases.put(mk("box.alice", "L1", 1, 1, 10_000));
        const first = await s.boxSealedLeases.release("box.alice", 100);
        const second = await s.boxSealedLeases.release("box.alice", 100);
        return {
          firstUses: first?.usesConsumed,
          firstSealed: first?.sealedKeyHex,
          secondDefined: second !== undefined,
        };
      });
      expect(r).toEqual({ firstUses: 1, firstSealed: "sealed-L1", secondDefined: false });
    });

    it("maxUses=2: release twice (1,2) then exhausted on the third", async () => {
      const r = await parityCase(async (s) => {
        await s.boxSealedLeases.put(mk("box.alice", "L2", 2, 1, 10_000));
        const a = await s.boxSealedLeases.release("box.alice", 100);
        const b = await s.boxSealedLeases.release("box.alice", 100);
        const c = await s.boxSealedLeases.release("box.alice", 100);
        return { a: a?.usesConsumed, b: b?.usesConsumed, cDefined: c !== undefined };
      });
      expect(r).toEqual({ a: 1, b: 2, cDefined: false });
    });

    it("maxUses=null is unbounded until expiry", async () => {
      const r = await parityCase(async (s) => {
        await s.boxSealedLeases.put(mk("box.alice", "U", null, 1, 10_000));
        const a = await s.boxSealedLeases.release("box.alice", 100);
        const b = await s.boxSealedLeases.release("box.alice", 100);
        const c = await s.boxSealedLeases.release("box.alice", 100);
        return { uses: [a?.usesConsumed, b?.usesConsumed, c?.usesConsumed] };
      });
      expect(r).toEqual({ uses: [1, 2, 3] });
    });

    it("release picks freshest non-expired; exhausted+expired rows GC'd, revoke counts", async () => {
      const r = await parityCase(async (s) => {
        await s.boxSealedLeases.put(mk("box.alice", "expired", null, 5, 50)); // exp<=100
        await s.boxSealedLeases.put(mk("box.alice", "fresh", null, 40, 10_000));
        const picked = await s.boxSealedLeases.release("box.alice", 100);
        const live = (await s.boxSealedLeases.list("box.alice", 100)).map((l) => l.leaseId);
        const revoked = await s.boxSealedLeases.revoke("box.alice", "fresh");
        const revokeMissing = await s.boxSealedLeases.revoke("box.alice", "ghost");
        return { picked: picked?.leaseId, live, revoked, revokeMissing };
      });
      expect(r).toEqual({ picked: "fresh", live: ["fresh"], revoked: true, revokeMissing: false });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // secretMailbox — single-use nonce (putRequest), write-once reply
  // (putResponse conditional WHERE response IS NULL), single-use release
  // (consumeResponse conditional WHERE consumed IS NULL), expiry GC.
  // ────────────────────────────────────────────────────────────────────
  describe("secretMailbox", () => {
    const mk = (
      domain: string,
      nonce: string,
      user: string,
      exp: number,
      extra: Partial<import("../src/types.js").SecretMailboxRecord> = {},
    ) => ({
      serverDomain: domain,
      username: user,
      requestNonceHex: nonce,
      stkPubHex: "STK",
      purpose: "unlock-key" as const,
      requestIssuedAt: 1,
      requestSignatureHex: "rsig",
      deviceInfoJson: null,
      postedAt: 1,
      expiresAt: exp,
      lastPushAt: 0,
      responseSealedHex: null,
      responseIssuedAt: null,
      respondedAt: null,
      consumedAt: null,
      ...extra,
    });

    it("single-use nonce: duplicate (domain,nonce) rejected identically", async () => {
      const r = await parityCase(async (s) => {
        const first = await s.secretMailbox.putRequest(mk("box.alice", "n1", "alice", 10_000));
        const dup = await s.secretMailbox.putRequest(mk("box.alice", "n1", "alice", 10_000));
        return { first, dup };
      });
      expect(r.first).toEqual({ ok: true });
      expect(r.dup).toEqual({ ok: false, reason: "duplicate nonce" });
    });

    it("putResponse is write-once; a second reply is 'already answered'", async () => {
      const r = await parityCase(async (s) => {
        await s.secretMailbox.putRequest(mk("box.alice", "n1", "alice", 10_000));
        const first = await s.secretMailbox.putResponse("box.alice", "n1", "sealedA", 5, 100);
        const second = await s.secretMailbox.putResponse("box.alice", "n1", "sealedB", 6, 101);
        const onUnknown = await s.secretMailbox.putResponse("box.alice", "ghost", "x", 7, 102);
        return { first, second, onUnknown };
      });
      expect(r.first).toEqual({ ok: true });
      expect(r.second).toEqual({ ok: false, reason: "already answered" });
      expect(r.onUnknown).toEqual({ ok: false, reason: "unknown request" });
    });

    it("consumeResponse releases the sealed reply exactly once", async () => {
      const r = await parityCase(async (s) => {
        await s.secretMailbox.putRequest(mk("box.alice", "n1", "alice", 10_000));
        // no reply yet → consume returns undefined
        const beforeReply = await s.secretMailbox.consumeResponse("box.alice", "n1", 100);
        await s.secretMailbox.putResponse("box.alice", "n1", "sealedA", 5, 100);
        const firstConsume = await s.secretMailbox.consumeResponse("box.alice", "n1", 101);
        const secondConsume = await s.secretMailbox.consumeResponse("box.alice", "n1", 102);
        return {
          beforeReplyDefined: beforeReply !== undefined,
          firstSealed: firstConsume?.responseSealedHex,
          firstConsumedAt: firstConsume?.consumedAt,
          secondDefined: secondConsume !== undefined,
        };
      });
      expect(r).toEqual({
        beforeReplyDefined: false,
        firstSealed: "sealedA",
        firstConsumedAt: 101,
        secondDefined: false,
      });
    });

    it("expiry: putResponse past TTL is 'unknown request'; consume GCs the row", async () => {
      const r = await parityCase(async (s) => {
        await s.secretMailbox.putRequest(mk("box.alice", "n1", "alice", 100));
        // reply lands while valid…
        await s.secretMailbox.putResponse("box.alice", "n1", "sealedA", 5, 50);
        // …but the box consumes AFTER expiry → undefined + GC
        const consumed = await s.secretMailbox.consumeResponse("box.alice", "n1", 200);
        // a fresh putResponse now sees no row at all
        const lateReply = await s.secretMailbox.putResponse("box.alice", "n1", "x", 9, 201);
        return { consumedDefined: consumed !== undefined, lateReply };
      });
      expect(r.consumedDefined).toBe(false);
      expect(r.lateReply).toEqual({ ok: false, reason: "unknown request" });
    });

    it("listPendingForUser: only un-answered, un-consumed, un-expired; postedAt DESC", async () => {
      const r = await parityCase(async (s) => {
        await s.secretMailbox.putRequest(mk("box.alice", "p1", "alice", 10_000, { postedAt: 10 }));
        await s.secretMailbox.putRequest(mk("box.alice", "p2", "alice", 10_000, { postedAt: 30 }));
        await s.secretMailbox.putRequest(mk("box.alice", "p3", "alice", 10_000, { postedAt: 20 }));
        await s.secretMailbox.putRequest(mk("box.alice", "answered", "alice", 10_000, { postedAt: 40 }));
        await s.secretMailbox.putRequest(mk("box.alice", "expired", "alice", 50, { postedAt: 50 }));
        // answer one (drops from pending) and let one expire
        await s.secretMailbox.putResponse("box.alice", "answered", "sealed", 1, 100);
        const pending = (await s.secretMailbox.listPendingForUser("alice", 100)).map(
          (m) => m.requestNonceHex,
        );
        return pending;
      });
      // postedAt DESC over the still-pending set; "answered" + "expired" excluded.
      expect(r).toEqual(["p2", "p3", "p1"]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // mintReservations — the dead-lead-safe CAS lease. ⭐ This store carried
  // a real InMemory↔D1 divergence (acquiredAt on same-holder re-acquire);
  // these cases pin the now-agreed behavior so it can't regress.
  // ────────────────────────────────────────────────────────────────────
  describe("mintReservations", () => {
    it("first acquire wins; contender backs off and reads the live holder", async () => {
      const r = await parityCase(async (s) => {
        const first = await s.mintReservations.tryAcquire({
          username: "alice",
          holderPubHex: "AA",
          expiresAt: 1000,
          now: 10,
        });
        const contender = await s.mintReservations.tryAcquire({
          username: "alice",
          holderPubHex: "BB",
          expiresAt: 9999,
          now: 50,
        });
        return {
          firstAcquired: first.acquired,
          firstHolder: first.holder.holderPubHex,
          contenderAcquired: contender.acquired,
          // the loser sees the WINNER's live lease, unchanged
          contenderSeesHolder: contender.holder.holderPubHex,
          contenderSeesExpires: contender.holder.expiresAt,
          contenderSeesAcquiredAt: contender.holder.acquiredAt,
        };
      });
      expect(r).toEqual({
        firstAcquired: true,
        firstHolder: "aa",
        contenderAcquired: false,
        contenderSeesHolder: "aa",
        contenderSeesExpires: 1000,
        contenderSeesAcquiredAt: 10,
      });
    });

    it("same holder re-acquiring a LIVE lease extends it AND restamps acquiredAt to now", async () => {
      // ⭐ The regression guard. Pre-fix InMemory kept the ORIGINAL
      // acquiredAt here (10) while D1's `ON CONFLICT … SET acquired_at =
      // excluded.acquired_at` rewrote it to `now` (50). InMemory was
      // corrected to match prod; both now report 50.
      const r = await parityCase(async (s) => {
        await s.mintReservations.tryAcquire({
          username: "alice",
          holderPubHex: "AA",
          expiresAt: 1000,
          now: 10,
        });
        const again = await s.mintReservations.tryAcquire({
          username: "alice",
          holderPubHex: "AA",
          expiresAt: 2000,
          now: 50,
        });
        const after = await s.mintReservations.get("alice");
        return {
          acquired: again.acquired,
          holderAcquiredAt: again.holder.acquiredAt,
          holderExpiresAt: again.holder.expiresAt,
          afterAcquiredAt: after?.acquiredAt,
          afterExpiresAt: after?.expiresAt,
        };
      });
      expect(r).toEqual({
        acquired: true,
        holderAcquiredAt: 50,
        holderExpiresAt: 2000,
        afterAcquiredAt: 50,
        afterExpiresAt: 2000,
      });
    });

    it("an EXPIRED lease is reclaimable by a new holder; acquiredAt = now", async () => {
      const r = await parityCase(async (s) => {
        await s.mintReservations.tryAcquire({
          username: "alice",
          holderPubHex: "AA",
          expiresAt: 100,
          now: 10,
        });
        const taker = await s.mintReservations.tryAcquire({
          username: "alice",
          holderPubHex: "BB",
          expiresAt: 9999,
          now: 200, // past the old lease's expiry
        });
        return {
          acquired: taker.acquired,
          holder: taker.holder.holderPubHex,
          acquiredAt: taker.holder.acquiredAt,
        };
      });
      expect(r).toEqual({ acquired: true, holder: "bb", acquiredAt: 200 });
    });

    it("release only frees YOUR lease; a stale holder's release is a no-op", async () => {
      const r = await parityCase(async (s) => {
        await s.mintReservations.tryAcquire({
          username: "alice",
          holderPubHex: "AA",
          expiresAt: 1000,
          now: 10,
        });
        // wrong holder tries to release → no-op
        await s.mintReservations.release("alice", "BB");
        const stillHeld = await s.mintReservations.get("alice");
        // the real holder releases → gone
        await s.mintReservations.release("alice", "AA");
        const afterRelease = await s.mintReservations.get("alice");
        return {
          stillHeldBy: stillHeld?.holderPubHex,
          afterReleaseDefined: afterRelease !== undefined,
        };
      });
      expect(r).toEqual({ stillHeldBy: "aa", afterReleaseDefined: false });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // watchDelegates — one-active-per-user (D1 unique partial index;
  // InMemory explicit check), re-mint after revoke, revoke-unknown throws.
  // ────────────────────────────────────────────────────────────────────
  describe("watchDelegates", () => {
    const mk = (
      id: string,
      user: string,
      pub: string,
      issued: number,
      revokedAt: number | null = null,
    ) => ({
      grantId: id,
      username: user,
      delegatePubHex: pub,
      scopesJson: '["boot-approval"]',
      issuedAt: issued,
      expiresAt: issued + 1000,
      signatureHex: "sig",
      revokedAt,
    });

    it("duplicate ACTIVE delegate for a user rejected with the shared reason", async () => {
      const r = await parityCase(async (s) => {
        const first = await s.watchDelegates.put(mk("g1", "alice", "pubA", 1));
        const dup = await s.watchDelegates.put(mk("g2", "alice", "pubB", 2));
        return { first, dup };
      });
      expect(r.first).toEqual({ ok: true });
      expect(r.dup).toEqual({
        ok: false,
        reason: "duplicate active watch delegate for user",
      });
    });

    it("revoke then re-mint same user is allowed; getActive returns the live one", async () => {
      const r = await parityCase(async (s) => {
        await s.watchDelegates.put(mk("g1", "alice", "pubA", 1));
        await s.watchDelegates.revoke("g1", 5);
        const reissue = await s.watchDelegates.put(mk("g2", "alice", "pubB", 6));
        const active = await s.watchDelegates.getActiveForUser("alice");
        const byPub = await s.watchDelegates.getActiveByDelegatePub("pubB");
        const list = (await s.watchDelegates.listForUser("alice")).map((g) => g.grantId);
        return { reissue, activeId: active?.grantId, byPubId: byPub?.grantId, list };
      });
      expect(r.reissue).toEqual({ ok: true });
      expect(r.activeId).toBe("g2");
      expect(r.byPubId).toBe("g2");
      // listForUser is issued_at DESC; both rows retained.
      expect(r.list).toEqual(["g2", "g1"]);
    });

    it("revoke of an unknown grantId throws in BOTH adapters", async () => {
      const { mem, d1 } = freshPair();
      await expect(mem.watchDelegates.revoke("nope", 1)).rejects.toThrow();
      await expect(d1.watchDelegates.revoke("nope", 1)).rejects.toThrow();
    });

    it("a revoked delegate is not returned by the active lookups", async () => {
      const r = await parityCase(async (s) => {
        await s.watchDelegates.put(mk("g1", "alice", "pubA", 1));
        await s.watchDelegates.revoke("g1", 5);
        const active = await s.watchDelegates.getActiveForUser("alice");
        const byPub = await s.watchDelegates.getActiveByDelegatePub("pubA");
        return { activeDefined: active !== undefined, byPubDefined: byPub !== undefined };
      });
      expect(r).toEqual({ activeDefined: false, byPubDefined: false });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // acmeAccountKeyGrants — MANY active per user (no unique-active index);
  // put rejects only a duplicate grantId; revokeByAccountKeyId tombstones
  // every active copy of a rotated key and returns the count.
  // ────────────────────────────────────────────────────────────────────
  describe("acmeAccountKeyGrants", () => {
    const mk = (
      id: string,
      user: string,
      keyId: string,
      recipient: string,
      issued: number,
      revokedAt: number | null = null,
    ) => ({
      grantId: id,
      username: user,
      accountKeyId: keyId,
      recipientPubHex: recipient,
      sealedAccountKeyHex: `sealed-${id}`,
      issuedAt: issued,
      expiresAt: issued + 1000,
      signatureHex: "sig",
      revokedAt,
    });

    it("multiple active grants per user coexist; only a duplicate grantId is rejected", async () => {
      const r = await parityCase(async (s) => {
        const a = await s.acmeAccountKeyGrants.put(mk("g1", "alice", "K", "dev1", 1));
        const b = await s.acmeAccountKeyGrants.put(mk("g2", "alice", "K", "dev2", 2));
        const dupId = await s.acmeAccountKeyGrants.put(mk("g1", "alice", "K", "dev3", 3));
        const active = (await s.acmeAccountKeyGrants.getActiveForUser("alice"))
          .map((g) => g.grantId)
          .sort();
        return { a, b, dupId, active };
      });
      expect(r.a).toEqual({ ok: true });
      expect(r.b).toEqual({ ok: true });
      expect(r.dupId).toEqual({ ok: false, reason: "duplicate acme account key grant id" });
      expect(r.active).toEqual(["g1", "g2"]);
    });

    it("revokeByAccountKeyId tombstones every active copy and returns the count", async () => {
      const r = await parityCase(async (s) => {
        await s.acmeAccountKeyGrants.put(mk("g1", "alice", "OLD", "dev1", 1));
        await s.acmeAccountKeyGrants.put(mk("g2", "alice", "OLD", "dev2", 2));
        await s.acmeAccountKeyGrants.put(mk("g3", "alice", "NEW", "dev3", 3));
        // pre-revoke g2 so it should NOT count toward the rotation revoke
        await s.acmeAccountKeyGrants.revoke("g2", 4);
        const revoked = await s.acmeAccountKeyGrants.revokeByAccountKeyId("OLD", 5);
        const stillActive = (await s.acmeAccountKeyGrants.getActiveForUser("alice"))
          .map((g) => g.grantId)
          .sort();
        const byRecipient = (await s.acmeAccountKeyGrants.getActiveByRecipient("dev3")).map(
          (g) => g.grantId,
        );
        return { revoked, stillActive, byRecipient };
      });
      // only g1 was still-active under OLD → count 1; NEW's g3 survives.
      expect(r).toEqual({ revoked: 1, stillActive: ["g3"], byRecipient: ["g3"] });
    });

    it("revoke of an unknown grantId throws in BOTH adapters", async () => {
      const { mem, d1 } = freshPair();
      await expect(mem.acmeAccountKeyGrants.revoke("nope", 1)).rejects.toThrow();
      await expect(d1.acmeAccountKeyGrants.revoke("nope", 1)).rejects.toThrow();
    });

    it("revokeByAccountKeyId on an unknown key returns 0 (not an error)", async () => {
      const r = await parityCase((s) => s.acmeAccountKeyGrants.revokeByAccountKeyId("ghost", 1));
      expect(r).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // demoUsers — the none→provisioning CAS transition (the race the lock
  // exists for), idempotent setProvisionPhase, insert-collision (reason
  // strings legitimately differ — assert ok-parity only).
  // ────────────────────────────────────────────────────────────────────
  describe("demoUsers", () => {
    const mk = (user: string, state: import("../src/types.js").DemoUserState = "none") => ({
      username: user,
      display: user.toUpperCase(),
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "nbg1",
      size: "cx22",
      activeServerId: null,
      activeServerIp: null,
      image: null,
      activeServerFqdn: null,
      lastActivityAt: 1,
      state,
      createdAt: 1,
      provisionPhase: null,
      provisionPhaseAt: null,
      provisionLastError: null,
    });

    it("CAS transition succeeds only when `from` matches; the loser gets null", async () => {
      const r = await parityCase(async (s) => {
        await s.demoUsers.insert(mk("alice", "none"));
        // winner: none → provisioning, applying a patch
        const winner = await s.demoUsers.transition("alice", "none", "provisioning", {
          activeServerId: "srv-1",
        });
        // a second none→provisioning loses (state is already provisioning)
        const loser = await s.demoUsers.transition("alice", "none", "provisioning", {
          activeServerId: "srv-2",
        });
        const after = await s.demoUsers.get("alice");
        return {
          winnerState: winner?.state,
          winnerSrv: winner?.activeServerId,
          loserNull: loser === null,
          // the loser's patch must NOT have applied
          afterSrv: after?.activeServerId,
          afterState: after?.state,
        };
      });
      expect(r).toEqual({
        winnerState: "provisioning",
        winnerSrv: "srv-1",
        loserNull: true,
        afterSrv: "srv-1",
        afterState: "provisioning",
      });
    });

    it("transition on an unknown username is null in both", async () => {
      const r = await parityCase((s) =>
        s.demoUsers.transition("ghost", "none", "provisioning"),
      );
      expect(r).toBeNull();
    });

    it("setProvisionPhase is idempotent + returns the merged row; null on unknown", async () => {
      const r = await parityCase(async (s) => {
        await s.demoUsers.insert(mk("alice", "provisioning"));
        const p1 = await s.demoUsers.setProvisionPhase("alice", "booting", null, 100);
        const p2 = await s.demoUsers.setProvisionPhase("alice", "booting", null, 200); // re-post
        const failed = await s.demoUsers.setProvisionPhase("alice", "failed", "boom", 300);
        const cleared = await s.demoUsers.setProvisionPhase("alice", "up", null, 400);
        const unknown = await s.demoUsers.setProvisionPhase("ghost", "x", null, 1);
        return {
          p1: { phase: p1?.provisionPhase, at: p1?.provisionPhaseAt },
          p2At: p2?.provisionPhaseAt,
          failedErr: failed?.provisionLastError,
          clearedErr: cleared?.provisionLastError,
          unknownNull: unknown === null,
        };
      });
      expect(r).toEqual({
        p1: { phase: "booting", at: 100 },
        p2At: 200, // re-post refreshes the timestamp
        failedErr: "boom",
        clearedErr: null, // passing null clears the error
        unknownNull: true,
      });
    });

    it("countActive + findIdle agree across adapters", async () => {
      const r = await parityCase(async (s) => {
        await s.demoUsers.insert({ ...mk("a", "up"), lastActivityAt: 10 });
        await s.demoUsers.insert({ ...mk("b", "provisioning"), lastActivityAt: 5 });
        await s.demoUsers.insert({ ...mk("c", "idle-pending-teardown"), lastActivityAt: 20 });
        await s.demoUsers.insert({ ...mk("d", "none"), lastActivityAt: 1 }); // not active
        const active = await s.demoUsers.countActive();
        const idle = (await s.demoUsers.findIdle(15)).map((x) => x.username); // lastActivity<15
        return { active, idle };
      });
      // a(10) + b(5) idle (ascending lastActivity); c(20) not idle; d not active.
      expect(r).toEqual({ active: 3, idle: ["b", "a"] });
    });

    it("insert collision returns ok:false in BOTH (reason strings differ by design)", async () => {
      // The contract deliberately leaves the collision reason unpinned —
      // InMemory returns a friendly "demo username already exists" while
      // D1 surfaces the raw "UNIQUE constraint failed: …". Assert the
      // CALLER-OBSERVABLE contract (ok:false) is identical; the reason is
      // the handler's to translate, so we do NOT assert it for equality.
      const { mem, d1 } = freshPair();
      await mem.demoUsers.insert(mk("dup"));
      await d1.demoUsers.insert(mk("dup"));
      const memDup = await mem.demoUsers.insert(mk("dup"));
      const d1Dup = await d1.demoUsers.insert(mk("dup"));
      expect(memDup.ok).toBe(false);
      expect(d1Dup.ok).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // acmeAccountKeyDelivery — ONE slot per box (put overwrites);
  // deleteByAccountKeyId drops every slot of a rotated key + returns count.
  // (put-overwrite is covered in parity.test.ts; this adds the multi-slot
  // rotation + delete-by-domain shapes.)
  // ────────────────────────────────────────────────────────────────────
  describe("acmeAccountKeyDelivery", () => {
    const mk = (domain: string, keyId: string, sealed: string) => ({
      serverDomain: domain,
      accountKeyId: keyId,
      sealedAccountKeyHex: sealed,
      recipientPubHex: "stk",
      issuedAt: 1,
      expiresAt: 1000,
      revokedAt: null,
    });

    it("deleteByDomain drops one slot; deleteByAccountKeyId drops all of a key", async () => {
      const r = await parityCase(async (s) => {
        await s.acmeAccountKeyDelivery.put(mk("a.alice", "K1", "s"));
        await s.acmeAccountKeyDelivery.put(mk("b.alice", "K1", "s"));
        await s.acmeAccountKeyDelivery.put(mk("c.alice", "K2", "s"));
        await s.acmeAccountKeyDelivery.deleteByDomain("a.alice");
        const afterDomainDelete = await s.acmeAccountKeyDelivery.getByDomain("a.alice");
        const droppedByKey = await s.acmeAccountKeyDelivery.deleteByAccountKeyId("K1");
        const bGone = await s.acmeAccountKeyDelivery.getByDomain("b.alice");
        const cAlive = await s.acmeAccountKeyDelivery.getByDomain("c.alice");
        return {
          afterDomainDeleteDefined: afterDomainDelete !== undefined,
          droppedByKey,
          bGoneDefined: bGone !== undefined,
          cAliveKey: cAlive?.accountKeyId,
        };
      });
      // a.alice already deleted by domain → K1 now has only b.alice → count 1.
      expect(r).toEqual({
        afterDomainDeleteDefined: false,
        droppedByKey: 1,
        bGoneDefined: false,
        cAliveKey: "K2",
      });
    });

    it("deleteByAccountKeyId on an unknown key returns 0", async () => {
      const r = await parityCase((s) => s.acmeAccountKeyDelivery.deleteByAccountKeyId("ghost"));
      expect(r).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // schemaVersion — INSERT-collision idempotency (first stamp wins;
  // re-record is a no-op returning false; appliedAt preserved).
  // ────────────────────────────────────────────────────────────────────
  describe("schemaVersion", () => {
    it("record returns true once; re-record is false and preserves appliedAt", async () => {
      const r = await parityCase(async (s) => {
        const first = await s.schemaVersion.record("0049", 100);
        const dup = await s.schemaVersion.record("0049", 200); // first stamp wins
        const other = await s.schemaVersion.record("0050", 300);
        const has49 = await s.schemaVersion.has("0049");
        const has99 = await s.schemaVersion.has("0099");
        const list = (await s.schemaVersion.list()).map((v) => ({ v: v.version, at: v.appliedAt }));
        return { first, dup, other, has49, has99, list };
      });
      expect(r.first).toBe(true);
      expect(r.dup).toBe(false);
      expect(r.other).toBe(true);
      expect(r.has49).toBe(true);
      expect(r.has99).toBe(false);
      // ascending by version; 0049's appliedAt stayed 100 (the dup didn't bump it).
      expect(r.list).toEqual([
        { v: "0049", at: 100 },
        { v: "0050", at: 300 },
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // installPolicyFanout — recordOnce is the INSERT-OR-IGNORE notify-once
  // guard (first insert true → caller notifies; a retry false → must NOT).
  // ────────────────────────────────────────────────────────────────────
  describe("installPolicyFanout", () => {
    const mk = (domain: string, count: number, at: number) => ({
      serverDomain: domain,
      username: "alice",
      registeredAt: at,
      fanoutCount: count,
      notifiedAt: at,
    });

    it("recordOnce returns true the first time, false on every retry", async () => {
      const r = await parityCase(async (s) => {
        const first = await s.installPolicyFanout.recordOnce(mk("box.alice", 3, 100));
        const retry = await s.installPolicyFanout.recordOnce(mk("box.alice", 9, 200));
        const stored = await s.installPolicyFanout.get("box.alice");
        const other = await s.installPolicyFanout.recordOnce(mk("box2.alice", 1, 300));
        return {
          first,
          retry,
          // the IGNORE'd retry must NOT overwrite the original row
          storedCount: stored?.fanoutCount,
          storedAt: stored?.notifiedAt,
          other,
        };
      });
      expect(r).toEqual({ first: true, retry: false, storedCount: 3, storedAt: 100, other: true });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // entitlementRevocations + userIdentity — the monotonic putIfNewer CAS
  // (strictly-greater accepted; equal/older rejected; loser returns the
  // UNCHANGED stored record).
  // ────────────────────────────────────────────────────────────────────
  describe("entitlementRevocations (monotonic putIfNewer)", () => {
    const mk = (user: string, issuedAt: number, certs: string) => ({
      username: user,
      certIdsJson: certs,
      irkSignatureHex: `sig-${issuedAt}`,
      issuedAt,
      updatedAt: issuedAt,
    });

    it("strictly-newer accepted; equal + older rejected, returning the stored record", async () => {
      const r = await parityCase(async (s) => {
        const v1 = await s.entitlementRevocations.putIfNewer(mk("alice", 100, '["a"]'));
        const newer = await s.entitlementRevocations.putIfNewer(mk("alice", 200, '["a","b"]'));
        const equal = await s.entitlementRevocations.putIfNewer(mk("alice", 200, '["x"]'));
        const older = await s.entitlementRevocations.putIfNewer(mk("alice", 50, '["y"]'));
        const final = await s.entitlementRevocations.get("alice");
        return {
          v1Accepted: v1.accepted,
          newerAccepted: newer.accepted,
          equalAccepted: equal.accepted,
          equalStoredCerts: equal.stored.certIdsJson, // the UNCHANGED 200-list
          olderAccepted: older.accepted,
          finalCerts: final?.certIdsJson,
          finalIssued: final?.issuedAt,
        };
      });
      expect(r).toEqual({
        v1Accepted: true,
        newerAccepted: true,
        equalAccepted: false,
        equalStoredCerts: '["a","b"]',
        olderAccepted: false,
        finalCerts: '["a","b"]',
        finalIssued: 200,
      });
    });
  });

  describe("userIdentity (monotonic putIfNewer by blobVersion)", () => {
    const mk = (hash: string, version: number, signers: string[]) => ({
      usernameHash: hash,
      encryptedBlob: new Uint8Array([version, version + 1]),
      authorizedSigners: signers,
      blobVersion: version,
      signatureHex: `sig-${version}`,
      updatedAt: version,
    });

    it("higher blobVersion accepted; equal/lower rejected, returning the stored record", async () => {
      const r = await parityCase(async (s) => {
        const v1 = await s.userIdentity.putIfNewer(mk("h", 1, ["s1"]));
        const v2 = await s.userIdentity.putIfNewer(mk("h", 2, ["s1", "s2"]));
        const equal = await s.userIdentity.putIfNewer(mk("h", 2, ["z"]));
        const lower = await s.userIdentity.putIfNewer(mk("h", 1, ["q"]));
        const final = await s.userIdentity.get("h");
        return {
          v1Accepted: v1.accepted,
          v2Accepted: v2.accepted,
          equalAccepted: equal.accepted,
          equalSigners: equal.stored.authorizedSigners, // unchanged v2 signers
          lowerAccepted: lower.accepted,
          finalVersion: final?.blobVersion,
          finalSigners: final?.authorizedSigners,
          finalBlob: final ? Array.from(final.encryptedBlob) : null,
        };
      });
      expect(r).toEqual({
        v1Accepted: true,
        v2Accepted: true,
        equalAccepted: false,
        equalSigners: ["s1", "s2"],
        lowerAccepted: false,
        finalVersion: 2,
        finalSigners: ["s1", "s2"],
        finalBlob: [2, 3],
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // customDomainOrders — destructive upsert + the setStatus CAS on fqdn
  // (a stale verifier can't clobber a row a newer request replaced).
  // ────────────────────────────────────────────────────────────────────
  describe("customDomainOrders", () => {
    const mk = (
      svc: string,
      user: string,
      fqdn: string,
      status: import("../src/types.js").CustomDomainOrderRecord["status"] = "pending",
    ) => ({
      serviceId: svc,
      userId: user,
      fqdn,
      status,
      lastChanged: 1,
      failCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    it("destructive upsert replaces the prior row wholesale", async () => {
      const r = await parityCase(async (s) => {
        await s.customDomainOrders.upsert(mk("svc", "alice", "first.example.com"));
        const replaced = await s.customDomainOrders.upsert({
          ...mk("svc", "alice", "second.example.com"),
          failCount: 5,
        });
        const got = await s.customDomainOrders.get("alice", "svc");
        return { replacedFqdn: replaced.fqdn, gotFqdn: got?.fqdn, gotFails: got?.failCount };
      });
      expect(r).toEqual({
        replacedFqdn: "second.example.com",
        gotFqdn: "second.example.com",
        gotFails: 5,
      });
    });

    it("setStatus CAS: matches fqdn → true (+failCount bump on failed); stale fqdn → false", async () => {
      const r = await parityCase(async (s) => {
        await s.customDomainOrders.upsert(mk("svc", "alice", "a.example.com"));
        const activate = await s.customDomainOrders.setStatus(
          "alice",
          "svc",
          "a.example.com",
          "active",
          10,
        );
        // a stale verifier writes against the OLD fqdn after a re-request
        await s.customDomainOrders.upsert(mk("svc", "alice", "b.example.com"));
        const staleWrite = await s.customDomainOrders.setStatus(
          "alice",
          "svc",
          "a.example.com", // no longer the current fqdn
          "active",
          20,
        );
        const failOnce = await s.customDomainOrders.setStatus(
          "alice",
          "svc",
          "b.example.com",
          "failed",
          30,
        );
        const got = await s.customDomainOrders.get("alice", "svc");
        return {
          activate,
          staleWrite,
          failOnce,
          finalStatus: got?.status,
          finalFails: got?.failCount,
        };
      });
      expect(r.activate).toBe(true);
      expect(r.staleWrite).toBe(false); // CAS rejects the stale fqdn
      expect(r.failOnce).toBe(true);
      expect(r.finalStatus).toBe("failed");
      expect(r.finalFails).toBe(1); // bumped exactly once by the 'failed' write
    });

    it("setStatus on a missing order is false; listByStatus filters identically", async () => {
      const r = await parityCase(async (s) => {
        await s.customDomainOrders.upsert(mk("s1", "alice", "x.example.com", "active"));
        await s.customDomainOrders.upsert(mk("s2", "alice", "y.example.com", "pending"));
        const missing = await s.customDomainOrders.setStatus(
          "alice",
          "ghost",
          "z.example.com",
          "active",
          1,
        );
        const active = (await s.customDomainOrders.listActive()).map((o) => o.serviceId);
        const pending = (await s.customDomainOrders.listByStatus("pending")).map(
          (o) => o.serviceId,
        );
        return { missing, active, pending };
      });
      expect(r).toEqual({ missing: false, active: ["s1"], pending: ["s2"] });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // demoLlmLedger — append-and-prune-in-one-write rolling window + sumSince.
  // ────────────────────────────────────────────────────────────────────
  describe("demoLlmLedger", () => {
    it("append prunes entries older than pruneBefore in the same write", async () => {
      const r = await parityCase(async (s) => {
        await s.demoLlmLedger.append("alice", 100, 10, 0); // nothing to prune
        await s.demoLlmLedger.append("alice", 200, 20, 0);
        // this append prunes everything strictly older than 150 (drops the 100 row)
        await s.demoLlmLedger.append("alice", 300, 30, 150);
        const windowed = await s.demoLlmLedger.sumSince("alice", 150);
        const all = await s.demoLlmLedger.sumSince("alice", 0);
        const other = await s.demoLlmLedger.sumSince("bob", 0);
        return { windowed, all, other };
      });
      // 100-row pruned ⇒ remaining 200(20)+300(30); sumSince(150) = 50; sum all = 50.
      expect(r).toEqual({ windowed: 50, all: 50, other: 0 });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // llmPromo — bumpDaily / bumpLifetime accumulate-and-return-post-state
  // (the row is created at 0 on first bump in both).
  // ────────────────────────────────────────────────────────────────────
  describe("llmPromo (accumulate-on-bump)", () => {
    it("bumpDaily creates then accumulates; returns the post-state", async () => {
      const r = await parityCase(async (s) => {
        const first = await s.llmPromo.bumpDaily("alice", 5, 10, 2);
        const second = await s.llmPromo.bumpDaily("alice", 5, 3, 1);
        const read = await s.llmPromo.getDaily("alice", 5);
        const otherDay = await s.llmPromo.getDaily("alice", 6);
        return {
          firstCount: first.dailyCount,
          secondCount: second.dailyCount,
          readIn: read?.dailyInputTokens,
          readOut: read?.dailyOutputTokens,
          otherDayDefined: otherDay !== undefined,
        };
      });
      expect(r).toEqual({
        firstCount: 1,
        secondCount: 2,
        readIn: 13, // 10 + 3
        readOut: 3, // 2 + 1
        otherDayDefined: false,
      });
    });

    it("bumpLifetime accumulates count + tokens and stamps updatedAt", async () => {
      const r = await parityCase(async (s) => {
        await s.llmPromo.bumpLifetime("alice", 100, 50, 1_000);
        const second = await s.llmPromo.bumpLifetime("alice", 7, 3, 2_000);
        const read = await s.llmPromo.getLifetime("alice");
        return {
          count: second.lifetimeCount,
          inTok: read?.lifetimeInputTokens,
          outTok: read?.lifetimeOutputTokens,
          updatedAt: read?.updatedAt,
        };
      });
      expect(r).toEqual({ count: 2, inTok: 107, outTok: 53, updatedAt: 2_000 });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // luksKeys — idempotent sealed-blob overwrite + delete-absent no-op.
  // ────────────────────────────────────────────────────────────────────
  describe("luksKeys", () => {
    it("putSealed overwrites; getSealed round-trips; deleteSealed is idempotent", async () => {
      const r = await parityCase(async (s) => {
        await s.luksKeys.putSealed({ serverDomain: "box.alice", sealedKeyHex: "v1", sealedAt: 1 });
        await s.luksKeys.putSealed({ serverDomain: "box.alice", sealedKeyHex: "v2", sealedAt: 2 });
        const got = await s.luksKeys.getSealed("box.alice");
        await s.luksKeys.deleteSealed("box.alice");
        await s.luksKeys.deleteSealed("box.alice"); // absent → no-op
        const afterDelete = await s.luksKeys.getSealed("box.alice");
        const missing = await s.luksKeys.getSealed("ghost.alice");
        return {
          sealed: got?.sealedKeyHex,
          sealedAt: got?.sealedAt,
          afterDeleteDefined: afterDelete !== undefined,
          missingDefined: missing !== undefined,
        };
      });
      expect(r).toEqual({
        sealed: "v2",
        sealedAt: 2,
        afterDeleteDefined: false,
        missingDefined: false,
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // installEvents — per-serial seq assignment + sinceSeq filter (the
  // history-cap behavior is documented; here we pin seq + ordering parity).
  // ────────────────────────────────────────────────────────────────────
  describe("installEvents", () => {
    it("put assigns ascending per-serial seq; list honors sinceSeq", async () => {
      const r = await parityCase(async (s) => {
        const a = await s.installEvents.put({
          serial: "s1",
          eventName: "boot",
          detail: "1",
          postedAt: 1,
        });
        const b = await s.installEvents.put({
          serial: "s1",
          eventName: "net",
          detail: "2",
          postedAt: 2,
        });
        // a different serial restarts its own seq sequence
        const otherSerial = await s.installEvents.put({
          serial: "s2",
          eventName: "boot",
          detail: "x",
          postedAt: 1,
        });
        const all = (await s.installEvents.list("s1")).map((e) => e.seq);
        const since = (await s.installEvents.list("s1", a.ok ? a.seq : 0)).map((e) => e.seq);
        return {
          aSeq: a.ok ? a.seq : null,
          bSeq: b.ok ? b.seq : null,
          otherSeq: otherSerial.ok ? otherSerial.seq : null,
          all,
          since,
        };
      });
      expect(r.aSeq).toBe(1);
      expect(r.bSeq).toBe(2);
      expect(r.otherSeq).toBe(1); // per-serial sequence
      expect(r.all).toEqual([1, 2]);
      expect(r.since).toEqual([2]); // sinceSeq exclusive
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // provisionStatus — upsert-with-append: first report inserts a 1-element
  // history; later reports update the latest fields and GROW the history.
  // ────────────────────────────────────────────────────────────────────
  describe("provisionStatus", () => {
    it("upsert appends to history and tracks the latest phase/detail", async () => {
      const r = await parityCase(async (s) => {
        await s.provisionStatus.putProvisionStatus("s1", {
          serverDomain: "box.alice",
          phase: "partitioning",
          ts: 10,
        });
        await s.provisionStatus.putProvisionStatus("s1", {
          phase: "installing",
          detail: "42%",
          ts: 20,
        });
        await s.provisionStatus.putProvisionStatus("s1", { phase: "registered", ts: 30 });
        const got = await s.provisionStatus.getProvisionStatus("s1");
        const missing = await s.provisionStatus.getProvisionStatus("ghost");
        return {
          latestPhase: got?.phase,
          latestDetail: got?.detail,
          updatedAt: got?.updatedAt,
          historyPhases: got?.history.map((h) => h.phase),
          historyTs: got?.history.map((h) => h.ts),
          missingNull: missing === null,
        };
      });
      expect(r).toEqual({
        latestPhase: "registered",
        latestDetail: undefined,
        updatedAt: 30,
        historyPhases: ["partitioning", "installing", "registered"],
        historyTs: [10, 20, 30],
        missingNull: true,
      });
    });
  });
});
