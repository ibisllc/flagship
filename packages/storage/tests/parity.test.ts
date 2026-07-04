/**
 * D1 ↔ InMemory adapter PARITY suite (finding OPS-A).
 *
 * Production runs the D1 adapter (src/d1.ts, ~3100 LOC); almost every
 * other test runs InMemory (src/inMemory.ts). A UNIQUE / NULL / ordering /
 * upsert divergence between the two surfaces ONLY at deploy. This suite
 * runs the SAME assertion set against BOTH adapters so a divergence fails
 * here, in ~milliseconds, instead of in prod.
 *
 * Approach: REAL D1-over-SQLite (NOT a schema-conformance fallback). The
 * D1 adapter is driven against an in-process `node:sqlite` database with
 * every migration 0001..0048 applied in order (see support/sqliteD1.ts) —
 * so the schema, UNIQUE indexes, column DEFAULTs, NULL handling, and
 * `RETURNING`/`meta.changes` semantics are the production ones, not a
 * mock's approximation. node:sqlite ships with Node (this repo runs Node
 * 24), so this adds ZERO new dependencies.
 *
 * Each `parityCase` runs a closure twice — once per adapter — and asserts
 * the two produced the byte-identical observable result. Where the two
 * adapters legitimately differ, that difference is asserted EXPLICITLY
 * with a comment explaining why (none found load-bearing as of 0048; see
 * the notes inline).
 */
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/inMemory.js";
import { D1Storage } from "../src/d1.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import type { Storage } from "../src/types.js";

/** Build a fresh pair of empty stores. Each test gets its own SQLite so
 *  state never leaks between cases. */
function freshPair(): {
  mem: Storage;
  d1: Storage;
  sqlite: SqliteD1;
} {
  const sqlite = createSqliteD1();
  return { mem: new InMemoryStorage(), d1: new D1Storage(sqlite), sqlite };
}

const openHandles: SqliteD1[] = [];
afterAll(() => {
  for (const h of openHandles) h.close();
});

/**
 * Run `body` against a fresh InMemory store and a fresh D1-over-SQLite
 * store, returning both results so the caller can assert equality. The
 * body must be pure w.r.t. the passed store (no shared mutable closure
 * state) so the two runs are independent.
 */
async function bothAdapters<T>(
  body: (s: Storage) => Promise<T>,
): Promise<{ mem: T; d1: T }> {
  const { mem, d1, sqlite } = freshPair();
  openHandles.push(sqlite);
  const memResult = await body(mem);
  const d1Result = await body(d1);
  return { mem: memResult, d1: d1Result };
}

/** Assert both adapters produced deep-equal observable output. */
function expectParity<T>(pair: { mem: T; d1: T }): void {
  expect(pair.d1).toEqual(pair.mem);
}

describe("D1 ↔ InMemory parity", () => {
  // ────────────────────────────────────────────────────────────────────
  // usernames — claim conflict, re-claim preservation, swap CAS, TOTP
  // lifecycle, recovery-code CAS (the NULL ⇄ "" baseline is a known
  // divergence trap).
  // ────────────────────────────────────────────────────────────────────
  describe("usernames", () => {
    it("put → get returns identical record shape (DEFAULT-filled fields)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "Alice", irkPubHex: "aa", claimedAt: 100 });
        return s.usernames.get("alice");
      });
      expectParity(r);
      // Both must surface the column DEFAULTs as concrete values.
      expect(r.d1).toMatchObject({
        username: "alice",
        irkPubHex: "aa",
        claimedAt: 100,
        accountType: "single",
        recoveryWipePolicy: "graceful",
      });
    });

    it("get of an unknown username is undefined in both", async () => {
      const r = await bothAdapters((s) => s.usernames.get("nobody"));
      expect(r.mem).toBeUndefined();
      expect(r.d1).toBeUndefined();
    });

    it("re-claim with a DIFFERENT irk is rejected identically", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "bob", irkPubHex: "11", claimedAt: 1 });
        return s.usernames.put({ username: "bob", irkPubHex: "22", claimedAt: 2 });
      });
      expectParity(r);
      expect(r.d1).toEqual({ ok: false, reason: "username already claimed" });
    });

    it("benign re-claim updates claimed_at but preserves accountType", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "carol", irkPubHex: "ff", claimedAt: 1 });
        await s.usernames.finalizeTotpEnrollment("carol", 5, "[]");
        // re-put WITHOUT accountType — must not kick multi → single
        await s.usernames.put({ username: "carol", irkPubHex: "ff", claimedAt: 9 });
        return s.usernames.get("carol");
      });
      expectParity(r);
      expect(r.d1).toMatchObject({ accountType: "multi", claimedAt: 9 });
    });

    it("gating v2 — aidPubHex round-trips + survives a benign re-claim", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({
          username: "dave",
          irkPubHex: "ab",
          claimedAt: 1,
          aidPubHex: "cd".repeat(32),
        });
        const set = await s.usernames.get("dave");
        // re-put WITHOUT aidPubHex must not drop the stored AID
        await s.usernames.put({ username: "dave", irkPubHex: "ab", claimedAt: 9 });
        const after = await s.usernames.get("dave");
        return { set: set?.aidPubHex, after: after?.aidPubHex };
      });
      expectParity(r);
      expect(r.d1).toEqual({ set: "cd".repeat(32), after: "cd".repeat(32) });
    });

    it("Slice D — adminRootPubHex round-trips + survives a benign re-claim", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({
          username: "dana",
          irkPubHex: "ab",
          claimedAt: 1,
          adminRootPubHex: "ef".repeat(32),
        });
        const set = await s.usernames.get("dana");
        // re-put WITHOUT adminRootPubHex must not drop the pinned admin root
        await s.usernames.put({ username: "dana", irkPubHex: "ab", claimedAt: 9 });
        const after = await s.usernames.get("dana");
        return { set: set?.adminRootPubHex, after: after?.adminRootPubHex };
      });
      expectParity(r);
      expect(r.d1).toEqual({ set: "ef".repeat(32), after: "ef".repeat(32) });
    });

    it("swapIrkPub CAS: matches old → true; stale old → false", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "dave", irkPubHex: "aa", claimedAt: 1 });
        const good = await s.usernames.swapIrkPub("dave", "aa", "bb", 2);
        const stale = await s.usernames.swapIrkPub("dave", "aa", "cc", 3);
        const after = await s.usernames.get("dave");
        return { good, stale, irk: after?.irkPubHex };
      });
      expectParity(r);
      expect(r.d1).toEqual({ good: true, stale: false, irk: "bb" });
    });

    it("swapIrkPub on a missing username is false in both", async () => {
      const r = await bothAdapters((s) => s.usernames.swapIrkPub("ghost", "x", "y", 1));
      expect(r.mem).toBe(false);
      expect(r.d1).toBe(false);
    });

    it("TOTP lifecycle: enroll → clear round-trips identically", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "erin", irkPubHex: "aa", claimedAt: 1 });
        await s.usernames.setTotpSecretEncrypted("erin", "sealed");
        await s.usernames.finalizeTotpEnrollment("erin", 10, '["h1","h2"]');
        const enrolled = await s.usernames.get("erin");
        await s.usernames.clearTotp("erin");
        const cleared = await s.usernames.get("erin");
        return { enrolled, cleared };
      });
      expectParity(r);
      expect(r.d1.enrolled).toMatchObject({
        accountType: "multi",
        totpEnrolledAt: 10,
        recoveryCodesHashesJson: '["h1","h2"]',
      });
      expect(r.d1.cleared).toMatchObject({ accountType: "single" });
      // After clear, the TOTP artifacts must be gone (undefined) in both.
      expect(r.d1.cleared?.totpEnrolledAt).toBeUndefined();
      expect(r.d1.cleared?.recoveryCodesHashesJson).toBeUndefined();
    });

    it("casRecoveryCodes: NULL baseline matches \"\" in both adapters", async () => {
      // This is the classic SQL-vs-map divergence trap: a fresh row has
      // recovery_codes_hashes_json = NULL, but the contract says the
      // caller passes "" for the empty baseline. D1 special-cases the
      // WHERE (NULL OR ''); InMemory collapses undefined → "". Assert
      // they agree.
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "fae", irkPubHex: "aa", claimedAt: 1 });
        const first = await s.usernames.casRecoveryCodes("fae", "", '["a"]');
        const replay = await s.usernames.casRecoveryCodes("fae", "", '["b"]'); // stale expectation
        const correct = await s.usernames.casRecoveryCodes("fae", '["a"]', '["c"]');
        const after = (await s.usernames.get("fae"))?.recoveryCodesHashesJson;
        return { first, replay, correct, after };
      });
      expectParity(r);
      expect(r.d1).toEqual({ first: true, replay: false, correct: true, after: '["c"]' });
    });

    it("list returns the same set (order-insensitive)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "u1", irkPubHex: "1", claimedAt: 1 });
        await s.usernames.put({ username: "u2", irkPubHex: "2", claimedAt: 2 });
        const list = await s.usernames.list();
        return list.map((x) => x.username).sort();
      });
      expectParity(r);
      expect(r.d1).toEqual(["u1", "u2"]);
    });

    it("lastActive absent on a fresh row; touchLastActive sets it + survives a benign re-put", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "gail", irkPubHex: "aa", claimedAt: 1 });
        const fresh = (await s.usernames.get("gail"))?.lastActive ?? null;
        const touched = await s.usernames.touchLastActive("gail", 5_000);
        const afterTouch = (await s.usernames.get("gail"))?.lastActive ?? null;
        // a benign re-put (no lastActive) must NOT clear it
        await s.usernames.put({ username: "gail", irkPubHex: "aa", claimedAt: 9 });
        const afterReput = (await s.usernames.get("gail"))?.lastActive ?? null;
        return { fresh, touched, afterTouch, afterReput };
      });
      expectParity(r);
      expect(r.d1).toEqual({ fresh: null, touched: true, afterTouch: 5_000, afterReput: 5_000 });
    });

    it("touchLastActive on a missing username is false in both", async () => {
      const r = await bothAdapters((s) => s.usernames.touchLastActive("ghost", 1));
      expect(r.mem).toBe(false);
      expect(r.d1).toBe(false);
    });

    it("delete hard-removes the row (true), then get is undefined; double-delete is false", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernames.put({ username: "hank", irkPubHex: "aa", claimedAt: 1 });
        const first = await s.usernames.delete("hank");
        const afterGet = await s.usernames.get("hank");
        const second = await s.usernames.delete("hank");
        return { first, afterGet, second };
      });
      expectParity(r);
      expect(r.d1).toEqual({ first: true, afterGet: undefined, second: false });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // suggestionQueue (0061) — FIFO pop (enqueued_at, name), idempotent
  // enqueue, INSERT-OR-IGNORE dedupe counting.
  // ────────────────────────────────────────────────────────────────────
  describe("suggestionQueue", () => {
    it("enqueue counts only NEW rows; dupes are ignored", async () => {
      const r = await bothAdapters(async (s) => {
        const a = await s.suggestionQueue.enqueue(["brave-fox", "calm-owl"], 10);
        const b = await s.suggestionQueue.enqueue(["calm-owl", "wild-hare"], 20);
        return { a, b, count: await s.suggestionQueue.count() };
      });
      expectParity(r);
      expect(r.d1).toEqual({ a: 2, b: 1, count: 3 });
    });

    it("popOldest is FIFO by (enqueued_at, name) and deletes", async () => {
      const r = await bothAdapters(async (s) => {
        await s.suggestionQueue.enqueue(["wild-hare", "brave-fox"], 5); // same ts → name tiebreak
        await s.suggestionQueue.enqueue(["calm-owl"], 9);
        const first = await s.suggestionQueue.popOldest();
        const second = await s.suggestionQueue.popOldest();
        return { first, second, remaining: await s.suggestionQueue.list() };
      });
      expectParity(r);
      expect(r.d1).toEqual({ first: "brave-fox", second: "wild-hare", remaining: ["calm-owl"] });
    });

    it("popOldest on an empty queue returns null", async () => {
      const r = await bothAdapters(async (s) => s.suggestionQueue.popOldest());
      expectParity(r);
      expect(r.d1).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // suggestThrottle (0061) — upsert overwrite + prune-by-lastAt.
  // ────────────────────────────────────────────────────────────────────
  describe("suggestThrottle", () => {
    it("upsert inserts then overwrites; get round-trips the record", async () => {
      const r = await bothAdapters(async (s) => {
        await s.suggestThrottle.upsert({ deviceKey: "dev1", count: 1, windowStart: 100, lastAt: 100, nextAllowedAt: 2100 });
        await s.suggestThrottle.upsert({ deviceKey: "dev1", count: 2, windowStart: 100, lastAt: 200, nextAllowedAt: 5200 });
        return s.suggestThrottle.get("dev1");
      });
      expectParity(r);
      expect(r.d1).toEqual({ deviceKey: "dev1", count: 2, windowStart: 100, lastAt: 200, nextAllowedAt: 5200 });
    });

    it("get on an unknown key is undefined; prune drops stale rows by lastAt", async () => {
      const r = await bothAdapters(async (s) => {
        await s.suggestThrottle.upsert({ deviceKey: "old", count: 1, windowStart: 0, lastAt: 50, nextAllowedAt: 100 });
        await s.suggestThrottle.upsert({ deviceKey: "fresh", count: 1, windowStart: 0, lastAt: 500, nextAllowedAt: 600 });
        const removed = await s.suggestThrottle.prune(200);
        return {
          missing: await s.suggestThrottle.get("nope"),
          removed,
          old: await s.suggestThrottle.get("old"),
          fresh: await s.suggestThrottle.get("fresh"),
        };
      });
      expectParity(r);
      expect(r.d1.removed).toBe(1);
      expect(r.d1.old).toBeUndefined();
      expect(r.d1.fresh).toMatchObject({ deviceKey: "fresh" });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // usernameOffers (0062) — record/upsert + isOffered recency window +
  // consume + prune-by-offeredAt (the claim gate roster).
  // ────────────────────────────────────────────────────────────────────
  describe("usernameOffers", () => {
    it("record then isOffered honors the recency window; consume removes it", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernameOffers.record("happy-otter", "devA", 1000);
        return {
          fresh: await s.usernameOffers.isOffered("happy-otter", 500), // 1000 >= 500
          stale: await s.usernameOffers.isOffered("happy-otter", 1500), // 1000 < 1500
          missing: await s.usernameOffers.isOffered("nope", 0),
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ fresh: true, stale: false, missing: false });
    });

    it("record upserts (case-insensitive) and consume deletes", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernameOffers.record("Brave-Fox", "d1", 10);
        await s.usernameOffers.record("brave-fox", "d2", 20); // upsert, refresh offeredAt
        const before = await s.usernameOffers.isOffered("brave-fox", 15); // 20 >= 15
        await s.usernameOffers.consume("BRAVE-FOX");
        const after = await s.usernameOffers.isOffered("brave-fox", 0);
        return { before, after };
      });
      expectParity(r);
      expect(r.d1).toEqual({ before: true, after: false });
    });

    it("prune drops offers older than the cutoff", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernameOffers.record("old-owl", "d", 50);
        await s.usernameOffers.record("new-elk", "d", 500);
        const removed = await s.usernameOffers.prune(200);
        return {
          removed,
          old: await s.usernameOffers.isOffered("old-owl", 0),
          new: await s.usernameOffers.isOffered("new-elk", 0),
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ removed: 1, old: false, new: true });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // usernameAliases — the ?1-reuse path (isConsumed binds 1 value into 2
  // predicates) + alias-chain resolution + conflicting-alias rejection.
  // ────────────────────────────────────────────────────────────────────
  describe("usernameAliases", () => {
    it("isConsumed sees both old and new sides (?1 reuse)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernameAliases.put({ oldUsername: "old", newUsername: "new", effectiveAt: 1, signatureHex: "s" });
        return {
          old: await s.usernameAliases.isConsumed("old"),
          knew: await s.usernameAliases.isConsumed("new"),
          none: await s.usernameAliases.isConsumed("zzz"),
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ old: true, knew: true, none: false });
    });

    it("resolve walks the chain identically", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernameAliases.put({ oldUsername: "a", newUsername: "b", effectiveAt: 1, signatureHex: "s" });
        await s.usernameAliases.put({ oldUsername: "b", newUsername: "c", effectiveAt: 2, signatureHex: "s" });
        return s.usernameAliases.resolve("a");
      });
      expectParity(r);
      expect(r.d1).toEqual({ current: "c", chain: ["a", "b", "c"] });
    });

    it("conflicting alias is rejected identically; identical re-put is idempotent", async () => {
      const r = await bothAdapters(async (s) => {
        await s.usernameAliases.put({ oldUsername: "x", newUsername: "y", effectiveAt: 1, signatureHex: "s" });
        const dup = await s.usernameAliases.put({ oldUsername: "x", newUsername: "y", effectiveAt: 1, signatureHex: "s" });
        const conflict = await s.usernameAliases.put({ oldUsername: "x", newUsername: "z", effectiveAt: 2, signatureHex: "s" });
        return { dup, conflict };
      });
      expectParity(r);
      expect(r.d1.dup).toEqual({ ok: true });
      expect(r.d1.conflict.ok).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // authCodes — status lifecycle, the active-vs-used-inclusive lookups,
  // outstanding-by-username time filter.
  // ────────────────────────────────────────────────────────────────────
  describe("authCodes", () => {
    const mk = (serial: string, domain: string, extra: Partial<import("../src/types.js").AuthCodeRecord> = {}) => ({
      serial,
      username: "alice",
      serverName: "home",
      serverDomain: domain,
      delegatedPubKeyHex: "dd",
      userPubKeyHex: "uu",
      userSignatureHex: "ss",
      issuedAt: 1,
      expiresAt: 1_000_000,
      status: "active" as const,
      recordedAt: 1,
      ...extra,
    });

    it("put → get → markUsed → markRevoked transitions identically", async () => {
      const r = await bothAdapters(async (s) => {
        await s.authCodes.put(mk("s1", "d1.alice"));
        const got = await s.authCodes.get("s1");
        const used = await s.authCodes.markUsed("s1", 5);
        const reuse = await s.authCodes.markUsed("s1", 6); // already used
        const after = await s.authCodes.get("s1");
        return { got, used, reuse, status: after?.status, usedAt: after?.usedAt };
      });
      expectParity(r);
      expect(r.d1.used).toEqual({ ok: true });
      expect(r.d1.reuse.ok).toBe(false);
      expect(r.d1.status).toBe("used");
    });

    it("listActiveByServerDomain (active-only) vs latestByServerDomain (used-inclusive)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.authCodes.put(mk("a", "shared.alice", { recordedAt: 1 }));
        await s.authCodes.put(mk("b", "shared.alice", { recordedAt: 2 }));
        await s.authCodes.markUsed("a", 3); // a → used
        const active = (await s.authCodes.listActiveByServerDomain("shared.alice")).map((c) => c.serial).sort();
        const latest = (await s.authCodes.latestByServerDomain("shared.alice"))?.serial;
        return { active, latest };
      });
      expectParity(r);
      // only b stays active; latest-by-recorded includes the used 'a'? No —
      // b (recordedAt 2) is the most-recent regardless of status.
      expect(r.d1.active).toEqual(["b"]);
      expect(r.d1.latest).toBe("b");
    });

    it("listOutstandingByUsername filters expired + non-active identically", async () => {
      const r = await bothAdapters(async (s) => {
        await s.authCodes.put(mk("live", "d1.alice", { expiresAt: 1_000 }));
        await s.authCodes.put(mk("expired", "d2.alice", { expiresAt: 100 }));
        await s.authCodes.put(mk("usedone", "d3.alice", { expiresAt: 1_000 }));
        await s.authCodes.markUsed("usedone", 50);
        const out = (await s.authCodes.listOutstandingByUsername("alice", 500)).map((c) => c.serial).sort();
        return out;
      });
      expectParity(r);
      expect(r.d1).toEqual(["live"]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // servers — register / list / revoke; revoke of a missing row.
  // ────────────────────────────────────────────────────────────────────
  describe("servers", () => {
    it("put / listForUser / listAll / revoke parity", async () => {
      const r = await bothAdapters(async (s) => {
        await s.servers.put({ serverDomain: "a.alice", username: "alice", identityPubKeyHex: "1", registeredAt: 1 });
        await s.servers.put({ serverDomain: "b.alice", username: "alice", identityPubKeyHex: "2", registeredAt: 2 });
        const revoked = await s.servers.revoke("a.alice", "lost", 9);
        const revokeMissing = await s.servers.revoke("nope.alice", "x", 9);
        const forUser = (await s.servers.listForUser("alice")).map((x) => x.serverDomain).sort();
        const all = (await s.servers.listAll()).map((x) => x.serverDomain).sort();
        return { revoked, revokeMissing, forUser, all };
      });
      expectParity(r);
      expect(r.d1.revoked).toBe(true);
      expect(r.d1.revokeMissing).toBe(false);
      expect(r.d1.forUser).toEqual(["a.alice", "b.alice"]);
      // NOTE (doc drift found via this harness): the ServerStorage.listAll
      // contract comment in types.ts says "Every NON-revoked server", but
      // BOTH adapters return ALL rows (D1: `SELECT * FROM servers`;
      // InMemory: every map value) — neither filters revoked_at. The
      // adapters AGREE (so this is not an adapter divergence), but the
      // contract doc overstates the filtering. Asserting the real,
      // agreeing behavior; the doc is the thing to reconcile.
      expect(r.d1.all).toEqual(["a.alice", "b.alice"]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // routing — register idempotency, setTarget nonce/replay, release.
  // ────────────────────────────────────────────────────────────────────
  describe("routing", () => {
    const rec = (sub: string, rck: string) => ({
      subdomain: sub,
      username: "alice",
      rckPubKeyHex: rck,
      currentTargetHex: "",
      registeredAt: 1,
      lastTargetUpdate: 0,
      lastTargetNonce: "",
    });

    it("register: same RCK idempotent, different RCK rejected", async () => {
      const r = await bothAdapters(async (s) => {
        const first = await s.routing.register(rec("home.alice", "rck1"));
        const same = await s.routing.register(rec("home.alice", "rck1"));
        const diff = await s.routing.register(rec("home.alice", "rck2"));
        return { first, same, diff };
      });
      expectParity(r);
      expect(r.d1.first).toEqual({ ok: true });
      expect(r.d1.same).toEqual({ ok: true });
      expect(r.d1.diff.ok).toBe(false);
    });

    it("setTarget advances on a fresh nonce, no-op/reject on replay", async () => {
      const r = await bothAdapters(async (s) => {
        await s.routing.register(rec("h.alice", "rck1"));
        const set1 = await s.routing.setTarget("h.alice", "tgtA", "n1", 10);
        const got1 = await s.routing.get("h.alice");
        const replay = await s.routing.setTarget("h.alice", "tgtB", "n1", 11); // same nonce
        const got2 = await s.routing.get("h.alice");
        return {
          set1,
          target1: got1?.currentTargetHex,
          replay,
          target2: got2?.currentTargetHex,
        };
      });
      expectParity(r);
      expect(r.d1.set1).toEqual({ ok: true });
      expect(r.d1.target1).toBe("tgtA");
      // replay with a stale nonce must NOT advance the target.
      expect(r.d1.target2).toBe("tgtA");
    });

    it("release frees the subdomain; releasing an absent row is success", async () => {
      const r = await bothAdapters(async (s) => {
        await s.routing.register(rec("r.alice", "rck1"));
        const rel = await s.routing.release("r.alice");
        const relAgain = await s.routing.release("r.alice");
        // after release a DIFFERENT rck can claim it
        const reclaim = await s.routing.register(rec("r.alice", "rck2"));
        return { rel, relAgain, reclaim };
      });
      expectParity(r);
      expect(r.d1.rel).toEqual({ ok: true });
      expect(r.d1.relAgain).toEqual({ ok: true });
      expect(r.d1.reclaim).toEqual({ ok: true });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // daemonStatus — null cert fields, listForUser filter, signed-report
  // columns (migration 0048 report_json / signature_hex).
  // ────────────────────────────────────────────────────────────────────
  describe("daemonStatus", () => {
    it("put with NULL cert fields round-trips identically", async () => {
      const r = await bothAdapters(async (s) => {
        await s.daemonStatus.put({
          serverDomain: "x.alice",
          certSha256: null,
          certValidUntil: null,
          certIssuer: null,
          servicesServedJson: "[]",
          lastReported: 5,
        });
        return s.daemonStatus.get("x.alice");
      });
      expectParity(r);
      expect(r.d1).toMatchObject({
        certSha256: null,
        certValidUntil: null,
        certIssuer: null,
      });
    });

    it("signed-report columns (0048) round-trip; listForUser filters by user", async () => {
      // listForUser keys off the canonical "<server>.<user>.flagship.services"
      // shape in BOTH adapters (D1 via a LIKE pattern; InMemory via a
      // 4+-label split checking parts[1] === user). Use the real shape so the
      // two filter mechanisms agree — a non-canonical domain matches NEITHER.
      const r = await bothAdapters(async (s) => {
        await s.daemonStatus.put({
          serverDomain: "home.alice.flagship.services",
          certSha256: "ab",
          certValidUntil: 100,
          certIssuer: "YR1",
          servicesServedJson: '["home.alice.flagship.services"]',
          lastReported: 5,
          reportJson: '{"x":1}',
          signatureHex: "sig",
        });
        await s.daemonStatus.put({
          serverDomain: "home.bob.flagship.services",
          certSha256: "cd",
          certValidUntil: 200,
          certIssuer: "YR1",
          servicesServedJson: "[]",
          lastReported: 6,
        });
        const forAlice = await s.daemonStatus.listForUser("alice");
        return {
          single: await s.daemonStatus.get("home.alice.flagship.services"),
          forAliceDomains: forAlice.map((x) => x.serverDomain),
        };
      });
      expectParity(r);
      expect(r.d1.single).toMatchObject({ reportJson: '{"x":1}', signatureHex: "sig" });
      expect(r.d1.forAliceDomains).toEqual(["home.alice.flagship.services"]);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // auditEvents — seq assignment + DESC ordering + sinceSeq + nullable
  // v1.2 columns surfaced as absent-not-null.
  // ────────────────────────────────────────────────────────────────────
  describe("auditEvents", () => {
    it("append assigns ascending seq; list is DESC and honors sinceSeq", async () => {
      const r = await bothAdapters(async (s) => {
        const a = await s.auditEvents.append({ username: "alice", eventKind: "recovery-set-up", detail: "1", devicePrefix: "", postedAt: 1 });
        const b = await s.auditEvents.append({ username: "alice", eventKind: "device-added", detail: "2", devicePrefix: "p", postedAt: 2 });
        const c = await s.auditEvents.append({ username: "alice", eventKind: "device-disconnected", detail: "3", devicePrefix: "", postedAt: 3 });
        const all = (await s.auditEvents.list("alice", 0, 10)).map((e) => e.seq);
        const since = (await s.auditEvents.list("alice", b.seq, 10)).map((e) => e.seq);
        return { seqs: [a.seq, b.seq, c.seq], all, since };
      });
      expectParity(r);
      expect(r.d1.seqs).toEqual([1, 2, 3]);
      expect(r.d1.all).toEqual([3, 2, 1]); // DESC
      expect(r.d1.since).toEqual([3]); // sinceSeq exclusive lower bound
    });

    it("nullable v1.2 columns: absent on read when not provided; surfaced when set", async () => {
      const r = await bothAdapters(async (s) => {
        await s.auditEvents.append({ username: "u", eventKind: "totp-enrolled", detail: "d", devicePrefix: "", postedAt: 1 });
        await s.auditEvents.append({
          username: "u",
          eventKind: "device-added",
          detail: "d2",
          devicePrefix: "",
          postedAt: 2,
          accountTypeAtEvent: "multi",
          quarantineUntil: 999,
          recoveryMethod: "totp",
        });
        const rows = await s.auditEvents.list("u", 0, 10);
        // newest first
        return rows.map((e) => ({
          kind: e.eventKind,
          acct: e.accountTypeAtEvent ?? null,
          q: e.quarantineUntil ?? null,
          method: e.recoveryMethod ?? null,
        }));
      });
      expectParity(r);
      expect(r.d1[0]).toEqual({ kind: "device-added", acct: "multi", q: 999, method: "totp" });
      expect(r.d1[1]).toEqual({ kind: "totp-enrolled", acct: null, q: null, method: null });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // pendingRePairs — initiate single-pending guard, object, bitmap OR-in,
  // listActive ordering.
  // ────────────────────────────────────────────────────────────────────
  describe("pendingRePairs", () => {
    const mk = (u: string, at: number) => ({
      username: u,
      newIrkPubHex: "new",
      oldIrkPubHex: "old",
      initiatedAt: at,
      completesAt: at + 1000,
    });

    it("initiate is single-pending; second initiate rejected", async () => {
      const r = await bothAdapters(async (s) => {
        const first = await s.pendingRePairs.initiate(mk("alice", 1));
        const second = await s.pendingRePairs.initiate(mk("alice", 2));
        return { first, second };
      });
      expectParity(r);
      expect(r.d1.first).toEqual({ ok: true });
      expect(r.d1.second.ok).toBe(false);
    });

    it("object marks the row; orInAlertsFiredBit is idempotent per bit", async () => {
      const r = await bothAdapters(async (s) => {
        await s.pendingRePairs.initiate(mk("bob", 1));
        const objected = await s.pendingRePairs.object("bob", 5);
        const objMissing = await s.pendingRePairs.object("ghost", 5);
        const bit1 = await s.pendingRePairs.orInAlertsFiredBit("bob", 0b0010);
        const bit1again = await s.pendingRePairs.orInAlertsFiredBit("bob", 0b0010);
        const bit2 = await s.pendingRePairs.orInAlertsFiredBit("bob", 0b0100);
        return { objected, objMissing, bit1, bit1again, bit2 };
      });
      expectParity(r);
      expect(r.d1).toEqual({ objected: true, objMissing: false, bit1: 0b0010, bit1again: 0b0010, bit2: 0b0110 });
    });

    it("listActive excludes objected rows, ascending by initiation", async () => {
      const r = await bothAdapters(async (s) => {
        await s.pendingRePairs.initiate(mk("z", 30));
        await s.pendingRePairs.initiate(mk("a", 10));
        await s.pendingRePairs.initiate(mk("m", 20));
        await s.pendingRePairs.object("m", 99); // drop the middle
        return (await s.pendingRePairs.listActive()).map((p) => p.username);
      });
      expectParity(r);
      expect(r.d1).toEqual(["a", "z"]); // ascending initiatedAt, m excluded
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // pushTokens — quarantine fields, listQuarantined ordering, bitmap.
  // ────────────────────────────────────────────────────────────────────
  describe("pushTokens", () => {
    const mk = (id: string, u: string, reg: number, extra: Partial<import("../src/types.js").PushTokenRecord> = {}) => ({
      tokenId: id,
      username: u,
      platform: "apns" as const,
      providerToken: "tok",
      pushX25519PubHex: "pk",
      registrationSignatureHex: "sig",
      label: "iPhone",
      registeredAt: reg,
      lastSeenAt: reg,
      ...extra,
    });

    it("put / get / listByUser / remove / touchLastSeen parity", async () => {
      const r = await bothAdapters(async (s) => {
        await s.pushTokens.put(mk("t1", "alice", 1));
        await s.pushTokens.put(mk("t2", "alice", 2));
        await s.pushTokens.touchLastSeen("t1", 50);
        const list = (await s.pushTokens.listByUser("alice")).map((t) => t.tokenId).sort();
        const t1 = await s.pushTokens.get("t1");
        await s.pushTokens.remove("t2");
        const afterRemove = (await s.pushTokens.listByUser("alice")).map((t) => t.tokenId).sort();
        return { list, lastSeen: t1?.lastSeenAt, afterRemove };
      });
      expectParity(r);
      expect(r.d1).toEqual({ list: ["t1", "t2"], lastSeen: 50, afterRemove: ["t1"] });
    });

    it("setQuarantineUntil + listQuarantined ordering + orInQuarantineAlertBit", async () => {
      const r = await bothAdapters(async (s) => {
        await s.pushTokens.put(mk("q1", "alice", 10));
        await s.pushTokens.put(mk("q2", "alice", 5));
        await s.pushTokens.put(mk("notq", "alice", 1));
        const setOk = await s.pushTokens.setQuarantineUntil("q1", 10_000);
        const setMissing = await s.pushTokens.setQuarantineUntil("ghost", 10_000);
        await s.pushTokens.setQuarantineUntil("q2", 10_000);
        const quarantined = (await s.pushTokens.listQuarantined(100)).map((t) => t.tokenId);
        const bit = await s.pushTokens.orInQuarantineAlertBit("q1", 0b0001);
        const bitMissing = await s.pushTokens.orInQuarantineAlertBit("ghost", 0b0001);
        return { setOk, setMissing, quarantined, bit, bitMissing };
      });
      expectParity(r);
      expect(r.d1.setOk).toBe(true);
      expect(r.d1.setMissing).toBe(false);
      // ascending registration: q2 (5) before q1 (10); notq not quarantined
      expect(r.d1.quarantined).toEqual(["q2", "q1"]);
      expect(r.d1.bit).toBe(0b0001);
      expect(r.d1.bitMissing).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // voiciLinks — code-collision insert, getByService, cascade delete,
  // expiry GC.
  // ────────────────────────────────────────────────────────────────────
  describe("voiciLinks", () => {
    it("insert collision rejected; get + getByService parity", async () => {
      const r = await bothAdapters(async (s) => {
        const a = await s.voiciLinks.insert({ code: "abc", username: "alice", serviceId: "svc1", targetUrl: "u1", createdAt: 1 });
        const dup = await s.voiciLinks.insert({ code: "abc", username: "alice", targetUrl: "u2", createdAt: 2 });
        const got = await s.voiciLinks.get("abc");
        const byService = await s.voiciLinks.getByService("alice", "svc1");
        return { a, dup, gotCode: got?.code, byServiceCode: byService?.code };
      });
      expectParity(r);
      expect(r.d1.a).toEqual({ ok: true });
      expect(r.d1.dup.ok).toBe(false);
      expect(r.d1.gotCode).toBe("abc");
      expect(r.d1.byServiceCode).toBe("abc");
    });

    it("deleteByService cascade + deleteExpired count parity", async () => {
      const r = await bothAdapters(async (s) => {
        await s.voiciLinks.insert({ code: "c1", username: "alice", serviceId: "svc", targetUrl: "u", createdAt: 1 });
        await s.voiciLinks.insert({ code: "c2", username: "alice", serviceId: "svc", targetUrl: "u", createdAt: 2 });
        await s.voiciLinks.insert({ code: "e1", username: "alice", targetUrl: "u", createdAt: 1, expiresAt: 100 });
        const cascade = await s.voiciLinks.deleteByService("alice", "svc");
        const expired = await s.voiciLinks.deleteExpired(500);
        const remaining = await s.voiciLinks.get("e1");
        return { cascade, expired, remaining };
      });
      expectParity(r);
      expect(r.d1.cascade).toBe(2);
      expect(r.d1.expired).toBe(1);
      expect(r.d1.remaining).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // deviceCapabilityGrants — the UNIQUE-active-partial-index invariant is
  // THE classic UNIQUE-constraint divergence risk (D1 relies on the
  // partial index; InMemory checks explicitly).
  // ────────────────────────────────────────────────────────────────────
  describe("deviceCapabilityGrants", () => {
    const mk = (id: string, label: string, pub: string, issued: number, revokedAt: number | null = null) => ({
      grantId: id,
      username: "alice",
      deviceLabel: label,
      devicePubHex: pub,
      scopesJson: '["browse"]',
      issuedAt: issued,
      expiresAt: issued + 1000,
      signatureHex: "sig",
      revokedAt,
    });

    it("duplicate ACTIVE grant for (user,label) rejected with shared reason", async () => {
      const r = await bothAdapters(async (s) => {
        const first = await s.deviceCapabilityGrants.put(mk("g1", "phone", "pubA", 1));
        const dup = await s.deviceCapabilityGrants.put(mk("g2", "phone", "pubB", 2));
        return { first, dup };
      });
      expectParity(r);
      expect(r.d1.first).toEqual({ ok: true });
      expect(r.d1.dup).toEqual({ ok: false, reason: "duplicate active grant for (username, device_label)" });
    });

    it("revoke then re-issue same label is allowed (partial index excludes revoked)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.deviceCapabilityGrants.put(mk("g1", "phone", "pubA", 1));
        await s.deviceCapabilityGrants.revoke("g1", 5);
        const reissue = await s.deviceCapabilityGrants.put(mk("g2", "phone", "pubB", 6));
        const active = await s.deviceCapabilityGrants.getActiveForUserLabel("alice", "phone");
        const list = (await s.deviceCapabilityGrants.listForUser("alice")).map((g) => g.grantId);
        return { reissue, activeId: active?.grantId, list };
      });
      expectParity(r);
      expect(r.d1.reissue).toEqual({ ok: true });
      expect(r.d1.activeId).toBe("g2");
      // listForUser is issued_at DESC — both revoked + active retained.
      expect(r.d1.list).toEqual(["g2", "g1"]);
    });

    it("revoke unknown grantId throws in BOTH adapters", async () => {
      const { mem, d1, sqlite } = freshPair();
      openHandles.push(sqlite);
      await expect(mem.deviceCapabilityGrants.revoke("nope", 1)).rejects.toThrow();
      await expect(d1.deviceCapabilityGrants.revoke("nope", 1)).rejects.toThrow();
    });

    it("getByDevicePub returns most-recent active match", async () => {
      const r = await bothAdapters(async (s) => {
        await s.deviceCapabilityGrants.put(mk("g1", "labelA", "samepub", 1));
        await s.deviceCapabilityGrants.revoke("g1", 2);
        await s.deviceCapabilityGrants.put(mk("g2", "labelB", "samepub", 3));
        const got = await s.deviceCapabilityGrants.getByDevicePub("samepub");
        return got?.grantId;
      });
      expectParity(r);
      expect(r.d1).toBe("g2");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ctAlerts — claimAlertSlot is a UNIQUE/PRIMARY-KEY-collision "claim
  // once" primitive (D1 catches the PK violation; InMemory checks a Set).
  // ────────────────────────────────────────────────────────────────────
  describe("ctAlerts", () => {
    it("claimAlertSlot returns true exactly once per (user,cert)", async () => {
      const r = await bothAdapters(async (s) => {
        const first = await s.ctAlerts.claimAlertSlot("alice", "certX", 1);
        const second = await s.ctAlerts.claimAlertSlot("alice", "certX", 2);
        const other = await s.ctAlerts.claimAlertSlot("alice", "certY", 3);
        const has = await s.ctAlerts.has("alice", "certX");
        const hasNot = await s.ctAlerts.has("alice", "certZ");
        return { first, second, other, has, hasNot };
      });
      expectParity(r);
      expect(r.d1).toEqual({ first: true, second: false, other: true, has: true, hasNot: false });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // secretMailbox self-delete lane — `.com` writes the owner-IRK-signed
  // servers-self-delete order at account death; the box consumes it once.
  // Consume returns the freshest pending row, marks it consumed (so a
  // re-poll after a crashed wipe returns undefined), and GCs expired rows.
  // ────────────────────────────────────────────────────────────────────
  describe("secretMailbox (self-delete lane)", () => {
    const mk = (nonce: string, sealed: string, expiresAt = 1000) => ({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      requestNonceHex: nonce,
      stkPubHex: "ab".repeat(32),
      sealedHex: sealed,
      issuedAt: 1,
      expiresAt,
    });

    it("deposit → consume-once → second consume returns undefined", async () => {
      const r = await bothAdapters(async (s) => {
        const put = await s.secretMailbox.putSelfDeleteDeposit(mk("aa".repeat(16), "deadbeef"));
        const first = await s.secretMailbox.consumeSelfDeleteDeposit(
          "home.alice.flagship.services",
          10,
        );
        const second = await s.secretMailbox.consumeSelfDeleteDeposit(
          "home.alice.flagship.services",
          11,
        );
        return { putOk: put.ok, firstSealed: first?.sealedHex, secondDefined: second !== undefined };
      });
      expectParity(r);
      expect(r.d1).toEqual({ putOk: true, firstSealed: "deadbeef", secondDefined: false });
    });

    it("duplicate nonce rejected; expired rows never served", async () => {
      const r = await bothAdapters(async (s) => {
        await s.secretMailbox.putSelfDeleteDeposit(mk("bb".repeat(16), "one", 1000));
        const dup = await s.secretMailbox.putSelfDeleteDeposit(mk("bb".repeat(16), "two", 1000));
        // A separate, already-expired deposit on another domain.
        await s.secretMailbox.putSelfDeleteDeposit({
          ...mk("cc".repeat(16), "stale", 5),
          serverDomain: "old.alice.flagship.services",
        });
        const expired = await s.secretMailbox.consumeSelfDeleteDeposit(
          "old.alice.flagship.services",
          100,
        );
        return { dupOk: dup.ok, expiredDefined: expired !== undefined };
      });
      expectParity(r);
      expect(r.d1).toEqual({ dupOk: false, expiredDefined: false });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // secretMailbox swk lane — secret-free-recipe SWK delivery: the phone
  // deposits the sealed SWK-delivery carrier; the box consumes it once on
  // first boot. Same consume-once + dedup + GC semantics as the other lanes;
  // the carrier wraps a SEALED secret (not a public order).
  // ────────────────────────────────────────────────────────────────────
  describe("secretMailbox (swk lane)", () => {
    const mk = (nonce: string, sealed: string, expiresAt = 1000) => ({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      requestNonceHex: nonce,
      stkPubHex: "ab".repeat(32),
      sealedHex: sealed,
      issuedAt: 1,
      expiresAt,
    });

    it("deposit → consume-once → second consume returns undefined", async () => {
      const r = await bothAdapters(async (s) => {
        const put = await s.secretMailbox.putSwkDeposit(mk("aa".repeat(16), "cafebabe"));
        const first = await s.secretMailbox.consumeSwkDeposit("home.alice.flagship.services", 10);
        const second = await s.secretMailbox.consumeSwkDeposit("home.alice.flagship.services", 11);
        return { putOk: put.ok, firstSealed: first?.sealedHex, secondDefined: second !== undefined };
      });
      expectParity(r);
      expect(r.d1).toEqual({ putOk: true, firstSealed: "cafebabe", secondDefined: false });
    });

    it("duplicate nonce rejected; expired rows never served", async () => {
      const r = await bothAdapters(async (s) => {
        await s.secretMailbox.putSwkDeposit(mk("bb".repeat(16), "one", 1000));
        const dup = await s.secretMailbox.putSwkDeposit(mk("bb".repeat(16), "two", 1000));
        await s.secretMailbox.putSwkDeposit({
          ...mk("cc".repeat(16), "stale", 5),
          serverDomain: "old.alice.flagship.services",
        });
        const expired = await s.secretMailbox.consumeSwkDeposit("old.alice.flagship.services", 100);
        return { dupOk: dup.ok, expiredDefined: expired !== undefined };
      });
      expectParity(r);
      expect(r.d1).toEqual({ dupOk: false, expiredDefined: false });
    });

    it("the swk lane does not bleed into the self-delete lane (lane isolation)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.secretMailbox.putSwkDeposit(mk("dd".repeat(16), "swkblob"));
        // A self-delete consume must NOT return the swk row.
        const cross = await s.secretMailbox.consumeSelfDeleteDeposit(
          "home.alice.flagship.services",
          10,
        );
        const own = await s.secretMailbox.consumeSwkDeposit("home.alice.flagship.services", 11);
        return { crossDefined: cross !== undefined, ownSealed: own?.sealedHex };
      });
      expectParity(r);
      expect(r.d1).toEqual({ crossDefined: false, ownSealed: "swkblob" });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // secretMailbox cgk + set-leader lanes (Phase 6) — same consume-once + dedup
  // + GC + lane-isolation semantics as the swk lane.
  // ────────────────────────────────────────────────────────────────────
  describe("secretMailbox (cgk + set-leader lanes)", () => {
    const mk = (nonce: string, sealed: string, expiresAt = 1000) => ({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      requestNonceHex: nonce,
      stkPubHex: "ab".repeat(32),
      sealedHex: sealed,
      issuedAt: 1,
      expiresAt,
    });

    it("cgk deposit → consume-once → second consume undefined; dedup; lane isolation", async () => {
      const r = await bothAdapters(async (s) => {
        const put = await s.secretMailbox.putCgkDeposit(mk("aa".repeat(16), "cgkblob"));
        const dup = await s.secretMailbox.putCgkDeposit(mk("aa".repeat(16), "again"));
        const first = await s.secretMailbox.consumeCgkDeposit("home.alice.flagship.services", 10);
        const second = await s.secretMailbox.consumeCgkDeposit("home.alice.flagship.services", 11);
        // A swk consume must NOT see the cgk row.
        await s.secretMailbox.putCgkDeposit(mk("bb".repeat(16), "cgk2"));
        const cross = await s.secretMailbox.consumeSwkDeposit("home.alice.flagship.services", 12);
        return {
          putOk: put.ok,
          dupOk: dup.ok,
          firstSealed: first?.sealedHex,
          secondDefined: second !== undefined,
          crossDefined: cross !== undefined,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        putOk: true,
        dupOk: false,
        firstSealed: "cgkblob",
        secondDefined: false,
        crossDefined: false,
      });
    });

    it("set-leader deposit → consume-once → second consume undefined; expired never served", async () => {
      const r = await bothAdapters(async (s) => {
        const put = await s.secretMailbox.putSetLeaderDeposit(mk("cc".repeat(16), "voteblob"));
        const first = await s.secretMailbox.consumeSetLeaderDeposit("home.alice.flagship.services", 10);
        const second = await s.secretMailbox.consumeSetLeaderDeposit("home.alice.flagship.services", 11);
        await s.secretMailbox.putSetLeaderDeposit({
          ...mk("dd".repeat(16), "stale", 5),
          serverDomain: "old.alice.flagship.services",
        });
        const expired = await s.secretMailbox.consumeSetLeaderDeposit("old.alice.flagship.services", 100);
        return {
          putOk: put.ok,
          firstSealed: first?.sealedHex,
          secondDefined: second !== undefined,
          expiredDefined: expired !== undefined,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        putOk: true,
        firstSealed: "voteblob",
        secondDefined: false,
        expiredDefined: false,
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // secretMailbox update lane (server-update) — same consume-once + dedup + GC
  // + lane-isolation semantics as the other deposit lanes.
  // ────────────────────────────────────────────────────────────────────
  describe("secretMailbox (update lane)", () => {
    const mk = (nonce: string, sealed: string, expiresAt = 1000) => ({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      requestNonceHex: nonce,
      stkPubHex: "ab".repeat(32),
      sealedHex: sealed,
      issuedAt: 1,
      expiresAt,
    });

    it("update deposit → consume-once → second consume undefined; dedup; lane isolation; expired never served", async () => {
      const r = await bothAdapters(async (s) => {
        const put = await s.secretMailbox.putUpdateDeposit(mk("aa".repeat(16), "updateblob"));
        const dup = await s.secretMailbox.putUpdateDeposit(mk("aa".repeat(16), "again"));
        const first = await s.secretMailbox.consumeUpdateDeposit("home.alice.flagship.services", 10);
        const second = await s.secretMailbox.consumeUpdateDeposit("home.alice.flagship.services", 11);
        // A cgk consume must NOT see the update row.
        await s.secretMailbox.putUpdateDeposit(mk("bb".repeat(16), "update2"));
        const cross = await s.secretMailbox.consumeCgkDeposit("home.alice.flagship.services", 12);
        // Expired rows are never served.
        await s.secretMailbox.putUpdateDeposit({
          ...mk("cc".repeat(16), "stale", 5),
          serverDomain: "old.alice.flagship.services",
        });
        const expired = await s.secretMailbox.consumeUpdateDeposit("old.alice.flagship.services", 100);
        return {
          putOk: put.ok,
          dupOk: dup.ok,
          firstSealed: first?.sealedHex,
          secondDefined: second !== undefined,
          crossDefined: cross !== undefined,
          expiredDefined: expired !== undefined,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        putOk: true,
        dupOk: false,
        firstSealed: "updateblob",
        secondDefined: false,
        crossDefined: false,
        expiredDefined: false,
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // serverTransfers — the transfer-a-box broker lane. One offer per box
  // (re-issue replaces); claim is a one-time CAS; getOffer GCs an unclaimed
  // expired offer but keeps a claimed one.
  // ────────────────────────────────────────────────────────────────────
  describe("serverTransfers", () => {
    const dom = "home.alice.flagship.services";
    const mkOffer = (nonce: string, expiresAt = 1000) => ({
      serverDomain: dom,
      giverUsername: "alice",
      transferNonce: nonce,
      giverIrkPubHex: "aa".repeat(32),
      issuedAt: 1,
      expiresAt,
      offerSignatureHex: "ff".repeat(64),
      claimedAt: null,
      acquirerUsername: null,
      acquirerIrkPubHex: null,
      claimIssuedAt: null,
      claimSignatureHex: null,
      diskKeyHandoffHex: null,
      diskKeyHandoffAt: null,
      acquirerAdminRootPubHex: null,
      adminHandoffOldRootHex: null,
      adminHandoffNewRootHex: null,
      adminHandoffIssuedAt: null,
      adminHandoffSigHex: null,
      rehomeAuthIssuedAt: null,
      rehomeAuthSigHex: null,
    });

    it("offer → claim → record carries acquirer binding; second claim rejected", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverTransfers.putOffer(mkOffer("11".repeat(16)));
        const first = await s.serverTransfers.claim(
          dom, "11".repeat(16), "bob", "bb".repeat(32), "", 5, "cc".repeat(64), 10,
        );
        const second = await s.serverTransfers.claim(
          dom, "11".repeat(16), "carol", "dd".repeat(32), "", 6, "ee".repeat(64), 11,
        );
        const after = await s.serverTransfers.getOffer(dom, 12);
        return {
          firstOk: first.ok,
          firstAcq: first.ok ? first.record.acquirerUsername : null,
          secondOk: second.ok,
          secondReason: second.ok ? null : second.reason,
          afterClaimed: after?.claimedAt !== null && after?.claimedAt !== undefined,
          afterAcqIrk: after?.acquirerIrkPubHex,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        firstOk: true,
        firstAcq: "bob",
        secondOk: false,
        secondReason: "already claimed",
        afterClaimed: true,
        afterAcqIrk: "bb".repeat(32),
      });
    });

    it("putDiskKeyHandoff sets the re-sealed key on a claimed row; refuses unclaimed", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverTransfers.putOffer(mkOffer("55".repeat(16)));
        // Unclaimed → refused.
        const beforeClaim = await s.serverTransfers.putDiskKeyHandoff(dom, "ab".repeat(60), 9);
        await s.serverTransfers.claim(
          dom, "55".repeat(16), "bob", "bb".repeat(32), "", 5, "cc".repeat(64), 10,
        );
        const afterClaim = await s.serverTransfers.putDiskKeyHandoff(dom, "ab".repeat(60), 12);
        const row = await s.serverTransfers.getOffer(dom, 13);
        return {
          beforeClaim,
          afterClaim,
          handoff: row?.diskKeyHandoffHex,
          handoffAt: row?.diskKeyHandoffAt,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        beforeClaim: false,
        afterClaim: true,
        handoff: "ab".repeat(60),
        handoffAt: 12,
      });
    });

    it("claim records the acquirer admin root; putAdminHandoff sets the proof on a claimed row (Slice D §9.8)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverTransfers.putOffer(mkOffer("99".repeat(16)));
        // Unclaimed → refused.
        const beforeClaim = await s.serverTransfers.putAdminHandoff(dom, {
          oldRootHex: "1a".repeat(32),
          newRootHex: "2b".repeat(32),
          issuedAt: 7,
          sigHex: "3c".repeat(64),
        });
        await s.serverTransfers.claim(
          dom, "99".repeat(16), "bob", "bb".repeat(32), "1B".repeat(32), 5, "cc".repeat(64), 10,
        );
        const afterClaim = await s.serverTransfers.putAdminHandoff(dom, {
          oldRootHex: "1a".repeat(32),
          newRootHex: "2b".repeat(32),
          issuedAt: 7,
          sigHex: "3c".repeat(64),
        });
        // Idempotent re-deposit REPLACES.
        const redeposit = await s.serverTransfers.putAdminHandoff(dom, {
          oldRootHex: "1a".repeat(32),
          newRootHex: "", // unpin shape stores the empty string, not NULL
          issuedAt: 8,
          sigHex: "4d".repeat(64),
        });
        const row = await s.serverTransfers.getOffer(dom, 13);
        return {
          beforeClaim,
          afterClaim,
          redeposit,
          acquirerAdminRoot: row?.acquirerAdminRootPubHex, // lowercased on write
          oldRoot: row?.adminHandoffOldRootHex,
          newRoot: row?.adminHandoffNewRootHex,
          issuedAt: row?.adminHandoffIssuedAt,
          sig: row?.adminHandoffSigHex,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        beforeClaim: false,
        afterClaim: true,
        redeposit: true,
        acquirerAdminRoot: "1b".repeat(32),
        oldRoot: "1a".repeat(32),
        newRoot: "",
        issuedAt: 8,
        sig: "4d".repeat(64),
      });
    });

    it("putRehomeAuth sets the legacy proof on a claimed row; refuses unclaimed; re-deposit replaces (v1-sec GAP 3)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverTransfers.putOffer(mkOffer("77".repeat(16)));
        // Unclaimed → refused.
        const beforeClaim = await s.serverTransfers.putRehomeAuth(dom, {
          issuedAt: 7,
          sigHex: "5e".repeat(64),
        });
        await s.serverTransfers.claim(
          dom, "77".repeat(16), "bob", "bb".repeat(32), "", 5, "cc".repeat(64), 10,
        );
        const afterClaim = await s.serverTransfers.putRehomeAuth(dom, {
          issuedAt: 7,
          sigHex: "5E".repeat(64), // stored lowercased
        });
        // Idempotent re-deposit REPLACES.
        const redeposit = await s.serverTransfers.putRehomeAuth(dom, {
          issuedAt: 8,
          sigHex: "6f".repeat(64),
        });
        const row = await s.serverTransfers.getOffer(dom, 13);
        return {
          beforeClaim,
          afterClaim,
          redeposit,
          issuedAt: row?.rehomeAuthIssuedAt,
          sig: row?.rehomeAuthSigHex,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        beforeClaim: false,
        afterClaim: true,
        redeposit: true,
        issuedAt: 8,
        sig: "6f".repeat(64),
      });
    });

    it("re-issued offer replaces the prior unclaimed row", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverTransfers.putOffer(mkOffer("22".repeat(16)));
        await s.serverTransfers.putOffer(mkOffer("33".repeat(16)));
        // The old nonce can no longer be claimed; only the freshest stands.
        const oldClaim = await s.serverTransfers.claim(
          dom, "22".repeat(16), "bob", "bb".repeat(32), "", 5, "cc".repeat(64), 10,
        );
        const newClaim = await s.serverTransfers.claim(
          dom, "33".repeat(16), "bob", "bb".repeat(32), "", 6, "cc".repeat(64), 11,
        );
        return {
          oldOk: oldClaim.ok,
          oldReason: oldClaim.ok ? null : oldClaim.reason,
          newOk: newClaim.ok,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ oldOk: false, oldReason: "nonce mismatch", newOk: true });
    });

    it("claim of an expired offer is rejected; getOffer GCs the expired unclaimed row", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverTransfers.putOffer(mkOffer("44".repeat(16), 50));
        const expiredClaim = await s.serverTransfers.claim(
          dom, "44".repeat(16), "bob", "bb".repeat(32), "", 5, "cc".repeat(64), 100,
        );
        const gone = await s.serverTransfers.getOffer(dom, 100);
        return {
          claimOk: expiredClaim.ok,
          claimReason: expiredClaim.ok ? null : expiredClaim.reason,
          goneDefined: gone !== undefined,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ claimOk: false, claimReason: "expired", goneDefined: false });
    });

    it("claim of an absent / nonce-mismatched offer is rejected", async () => {
      const r = await bothAdapters(async (s) => {
        const absent = await s.serverTransfers.claim(
          dom, "55".repeat(16), "bob", "bb".repeat(32), "", 5, "cc".repeat(64), 10,
        );
        await s.serverTransfers.putOffer(mkOffer("66".repeat(16)));
        const wrongNonce = await s.serverTransfers.claim(
          dom, "77".repeat(16), "bob", "bb".repeat(32), "", 5, "cc".repeat(64), 10,
        );
        return {
          absentReason: absent.ok ? null : absent.reason,
          wrongNonceReason: wrongNonce.ok ? null : wrongNonce.reason,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ absentReason: "no offer", wrongNonceReason: "nonce mismatch" });
    });

    it("getOffer keeps a claimed offer even after expiry (re-seal window); remove deletes", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverTransfers.putOffer(mkOffer("88".repeat(16), 50));
        await s.serverTransfers.claim(
          dom, "88".repeat(16), "bob", "bb".repeat(32), "", 5, "cc".repeat(64), 40,
        );
        const afterExpiry = await s.serverTransfers.getOffer(dom, 100);
        await s.serverTransfers.remove(dom);
        const removed = await s.serverTransfers.getOffer(dom, 100);
        return {
          keptAfterExpiry: afterExpiry !== undefined,
          keptAcq: afterExpiry?.acquirerUsername,
          removedDefined: removed !== undefined,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ keptAfterExpiry: true, keptAcq: "bob", removedDefined: false });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // serverEvictions — the graceful-decommission lane. One row per retired
  // instance under a pod FQDN (re-issue upserts); the chain lists by
  // issuedAt asc; markNewAcked marks the whole pod; gc deletes acked+old.
  // ────────────────────────────────────────────────────────────────────
  describe("serverEvictions", () => {
    const pod = "home.alice.flagship.services";
    const mkEvict = (stk: string, issuedAt = 100) => ({
      podCanonical: pod,
      retiredStkPubHex: stk,
      orderJson: JSON.stringify({ retire: stk, issuedAt }),
      orderSignatureHex: "ff".repeat(64),
      issuedAt,
      oldAckedAt: null,
      newAckedAt: null,
      epochCompleteAt: null,
    });

    it("record → get returns the order; list returns the chain ordered by issuedAt asc", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverEvictions.recordEviction(mkEvict("bb".repeat(32), 300));
        await s.serverEvictions.recordEviction(mkEvict("aa".repeat(32), 100));
        await s.serverEvictions.recordEviction(mkEvict("cc".repeat(32), 200));
        const got = await s.serverEvictions.getEviction(pod, "aa".repeat(32));
        const chain = await s.serverEvictions.listEvictions(pod);
        return {
          gotStk: got?.retiredStkPubHex,
          gotJson: got?.orderJson,
          chainOrder: chain.map((e) => e.issuedAt),
          chainStks: chain.map((e) => e.retiredStkPubHex),
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        gotStk: "aa".repeat(32),
        gotJson: JSON.stringify({ retire: "aa".repeat(32), issuedAt: 100 }),
        chainOrder: [100, 200, 300],
        chainStks: ["aa".repeat(32), "cc".repeat(32), "bb".repeat(32)],
      });
    });

    it("re-recording the same retired STK upserts (one row, latest order)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverEvictions.recordEviction(mkEvict("aa".repeat(32), 100));
        await s.serverEvictions.recordEviction({
          ...mkEvict("aa".repeat(32), 100),
          orderJson: JSON.stringify({ v: 2 }),
        });
        const chain = await s.serverEvictions.listEvictions(pod);
        return { count: chain.length, json: chain[0]?.orderJson };
      });
      expectParity(r);
      expect(r.d1).toEqual({ count: 1, json: JSON.stringify({ v: 2 }) });
    });

    it("markOldAcked / markEpochComplete hit one row; markNewAcked marks the whole pod", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverEvictions.recordEviction(mkEvict("aa".repeat(32), 100));
        await s.serverEvictions.recordEviction(mkEvict("bb".repeat(32), 200));
        const oldAck = await s.serverEvictions.markOldAcked(pod, "aa".repeat(32), 10);
        const epoch = await s.serverEvictions.markEpochComplete(pod, "aa".repeat(32), 11);
        const newCount = await s.serverEvictions.markNewAcked(pod, 12);
        const missing = await s.serverEvictions.markOldAcked(pod, "ee".repeat(32), 13);
        const chain = await s.serverEvictions.listEvictions(pod);
        return {
          oldAck,
          epoch,
          newCount,
          missing,
          rowA: {
            old: chain[0]?.oldAckedAt,
            epoch: chain[0]?.epochCompleteAt,
            new: chain[0]?.newAckedAt,
          },
          rowB: {
            old: chain[1]?.oldAckedAt,
            epoch: chain[1]?.epochCompleteAt,
            new: chain[1]?.newAckedAt,
          },
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        oldAck: true,
        epoch: true,
        newCount: 2,
        missing: false,
        rowA: { old: 10, epoch: 11, new: 12 },
        rowB: { old: null, epoch: null, new: 12 },
      });
    });

    it("gcEvictions deletes acked+old rows; keeps un-acked and acked-but-recent", async () => {
      const r = await bothAdapters(async (s) => {
        // acked long ago → deleted.
        await s.serverEvictions.recordEviction(mkEvict("aa".repeat(32), 100));
        await s.serverEvictions.markNewAcked(pod, 1000);
        // a second pod, never acked → kept.
        await s.serverEvictions.recordEviction({
          ...mkEvict("bb".repeat(32), 200),
          podCanonical: "other.bob.flagship.services",
        });
        // gc at now=10000, ttl=5000 → cutoff 5000; pod-1's newAckedAt=1000 ≤ cutoff → gone.
        const removed = await s.serverEvictions.gcEvictions(10000, 5000);
        const pod1 = await s.serverEvictions.listEvictions(pod);
        const pod2 = await s.serverEvictions.listEvictions("other.bob.flagship.services");
        return { removed, pod1Len: pod1.length, pod2Len: pod2.length };
      });
      expectParity(r);
      expect(r.d1).toEqual({ removed: 1, pod1Len: 0, pod2Len: 1 });
    });

    it("gcEvictions keeps an acked row still within its TTL", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverEvictions.recordEviction(mkEvict("aa".repeat(32), 100));
        await s.serverEvictions.markNewAcked(pod, 9000);
        // cutoff = 10000 - 5000 = 5000; newAckedAt=9000 > cutoff → kept.
        const removed = await s.serverEvictions.gcEvictions(10000, 5000);
        const chain = await s.serverEvictions.listEvictions(pod);
        return { removed, len: chain.length };
      });
      expectParity(r);
      expect(r.d1).toEqual({ removed: 0, len: 1 });
    });

    it("deleteEviction removes exactly one row (migration-abort neutralize)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverEvictions.recordEviction(mkEvict("aa".repeat(32), 100));
        await s.serverEvictions.recordEviction(mkEvict("bb".repeat(32), 200));
        const deleted = await s.serverEvictions.deleteEviction(pod, "AA".repeat(32));
        const again = await s.serverEvictions.deleteEviction(pod, "aa".repeat(32));
        const chain = await s.serverEvictions.listEvictions(pod);
        return { deleted, again, stks: chain.map((e) => e.retiredStkPubHex) };
      });
      expectParity(r);
      expect(r.d1).toEqual({ deleted: true, again: false, stks: ["bb".repeat(32)] });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // serverMigrations — the server-migration orchestration lane (0081).
  // One row per migrating FQDN (upsert); listForUser orders by
  // initiatedAt asc; attach + the mark* stamps advance phase + timestamp.
  // ────────────────────────────────────────────────────────────────────
  describe("serverMigrations", () => {
    const mkSession = (domain: string, initiatedAt = 100) => ({
      serverDomain: domain,
      username: "alice",
      oldStkPubHex: "aa".repeat(32),
      orderJson: JSON.stringify({ migrate: domain }),
      orderSignatureHex: "ff".repeat(64),
      disposition: "wipe-after-handoff",
      phase: "initiated" as const,
      initiatedAt,
      newServerDomain: null,
      newStkPubHex: null,
      attachedAt: null,
      preSeededAt: null,
      readyAt: null,
      freezeAt: null,
      takenOverAt: null,
      abortedAt: null,
    });

    it("put → get returns the session (hex/hostnames lowercased); upsert replaces", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverMigrations.putSession({
          ...mkSession("HOME.Alice.Flagship.Services"),
          oldStkPubHex: "AA".repeat(32),
          orderSignatureHex: "FF".repeat(64),
        });
        await s.serverMigrations.putSession({
          ...mkSession("home.alice.flagship.services"),
          orderJson: JSON.stringify({ v: 2 }),
        });
        const got = await s.serverMigrations.getSession("home.alice.flagship.services");
        const all = await s.serverMigrations.listForUser("ALICE");
        return { got, count: all.length };
      });
      expectParity(r);
      expect(r.d1.count).toBe(1);
      expect(r.d1.got?.orderJson).toBe(JSON.stringify({ v: 2 }));
      expect(r.d1.got?.oldStkPubHex).toBe("aa".repeat(32));
      expect(r.d1.got?.phase).toBe("initiated");
    });

    it("listForUser returns sessions ordered by initiatedAt asc, scoped to the account", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serverMigrations.putSession(mkSession("b.alice.flagship.services", 300));
        await s.serverMigrations.putSession(mkSession("a.alice.flagship.services", 100));
        await s.serverMigrations.putSession({
          ...mkSession("c.bob.flagship.services", 50),
          username: "bob",
        });
        const list = await s.serverMigrations.listForUser("alice");
        return list.map((m) => m.serverDomain);
      });
      expectParity(r);
      expect(r.d1).toEqual(["a.alice.flagship.services", "b.alice.flagship.services"]);
    });

    it("attachNewBox + the mark* stamps advance phase and timestamps; false on a missing row", async () => {
      const r = await bothAdapters(async (s) => {
        const pod = "home.alice.flagship.services";
        await s.serverMigrations.putSession(mkSession(pod));
        const attached = await s.serverMigrations.attachNewBox(
          pod,
          "ATTIC.alice.flagship.services",
          "BB".repeat(32),
          10,
        );
        const afterAttach = await s.serverMigrations.getSession(pod);
        await s.serverMigrations.markPreSeeded(pod, 11);
        await s.serverMigrations.markReady(pod, 12);
        await s.serverMigrations.markFreeze(pod, 13);
        await s.serverMigrations.markTakenOver(pod, 14);
        const final = await s.serverMigrations.getSession(pod);
        const missing = await s.serverMigrations.markAborted("nope.alice.flagship.services", 15);
        return {
          attached,
          missing,
          attachPhase: afterAttach?.phase,
          newDomain: afterAttach?.newServerDomain,
          newStk: afterAttach?.newStkPubHex,
          finalPhase: final?.phase,
          stamps: [final?.preSeededAt, final?.readyAt, final?.freezeAt, final?.takenOverAt],
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        attached: true,
        missing: false,
        attachPhase: "provisioned",
        newDomain: "attic.alice.flagship.services",
        newStk: "bb".repeat(32),
        finalPhase: "taken-over",
        stamps: [11, 12, 13, 14],
      });
    });

    it("markAborted is terminal-stamping like the others (abortedAt + phase)", async () => {
      const r = await bothAdapters(async (s) => {
        const pod = "home.alice.flagship.services";
        await s.serverMigrations.putSession(mkSession(pod));
        const aborted = await s.serverMigrations.markAborted(pod, 42);
        const got = await s.serverMigrations.getSession(pod);
        return { aborted, phase: got?.phase, at: got?.abortedAt };
      });
      expectParity(r);
      expect(r.d1).toEqual({ aborted: true, phase: "aborted", at: 42 });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // acmeAccountKeyDelivery — one-slot-per-box upsert (put replaces),
  // deleteByAccountKeyId count.
  // ────────────────────────────────────────────────────────────────────
  describe("acmeAccountKeyDelivery", () => {
    const mk = (domain: string, keyId: string, sealed: string, revokedAt: number | null = null) => ({
      serverDomain: domain,
      accountKeyId: keyId,
      sealedAccountKeyHex: sealed,
      recipientPubHex: "stk",
      issuedAt: 1,
      expiresAt: 1000,
      revokedAt,
    });

    it("put replaces the per-box slot (re-deposit overwrites)", async () => {
      const r = await bothAdapters(async (s) => {
        await s.acmeAccountKeyDelivery.put(mk("box.alice", "k1", "sealed1"));
        await s.acmeAccountKeyDelivery.put(mk("box.alice", "k2", "sealed2"));
        const got = await s.acmeAccountKeyDelivery.getByDomain("box.alice");
        return { keyId: got?.accountKeyId, sealed: got?.sealedAccountKeyHex };
      });
      expectParity(r);
      expect(r.d1).toEqual({ keyId: "k2", sealed: "sealed2" });
    });

    it("deleteByAccountKeyId drops every slot of a key; returns count", async () => {
      const r = await bothAdapters(async (s) => {
        await s.acmeAccountKeyDelivery.put(mk("a.alice", "k1", "s"));
        await s.acmeAccountKeyDelivery.put(mk("b.alice", "k1", "s"));
        await s.acmeAccountKeyDelivery.put(mk("c.alice", "k2", "s"));
        const dropped = await s.acmeAccountKeyDelivery.deleteByAccountKeyId("k1");
        const remaining = await s.acmeAccountKeyDelivery.getByDomain("c.alice");
        const goneA = await s.acmeAccountKeyDelivery.getByDomain("a.alice");
        return { dropped, remaining: remaining?.accountKeyId, goneA };
      });
      expectParity(r);
      expect(r.d1.dropped).toBe(2);
      expect(r.d1.remaining).toBe("k2");
      expect(r.d1.goneA).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // namespace (name_claims) — the merged per-user leftmost-label UNIQUE
  // invariant + idempotent re-claim + case-insensitive matching.
  // ────────────────────────────────────────────────────────────────────
  describe("namespace", () => {
    it("claim free; idempotent same (kind,refId); collision on different", async () => {
      const r = await bothAdapters(async (s) => {
        const free = await s.namespace.claim({ username: "alice", label: "home", kind: "box", refId: "srv1", claimedAt: 1 });
        const same = await s.namespace.claim({ username: "alice", label: "home", kind: "box", refId: "srv1", claimedAt: 2 });
        const collide = await s.namespace.claim({ username: "alice", label: "home", kind: "app", refId: "app1", claimedAt: 3 });
        const resolved = await s.namespace.resolve("alice", "HOME"); // case-insensitive
        return { free, same, collide, resolvedKind: resolved?.kind, resolvedClaimedAt: resolved?.claimedAt };
      });
      expectParity(r);
      expect(r.d1.free).toEqual({ ok: true });
      expect(r.d1.same).toEqual({ ok: true });
      expect(r.d1.collide).toEqual({ ok: false, reason: "name taken" });
      expect(r.d1.resolvedKind).toBe("box");
      // idempotent re-claim preserves the ORIGINAL claimedAt (not bumped)
      expect(r.d1.resolvedClaimedAt).toBe(1);
    });

    it("release frees the label; listForUser is claimedAt ASC", async () => {
      const r = await bothAdapters(async (s) => {
        await s.namespace.claim({ username: "alice", label: "b", kind: "app", refId: "1", claimedAt: 20 });
        await s.namespace.claim({ username: "alice", label: "a", kind: "app", refId: "2", claimedAt: 10 });
        await s.namespace.release("alice", "b");
        const reclaim = await s.namespace.claim({ username: "alice", label: "b", kind: "box", refId: "3", claimedAt: 30 });
        const list = (await s.namespace.listForUser("alice")).map((c) => c.label);
        return { reclaim, list };
      });
      expectParity(r);
      expect(r.d1.reclaim).toEqual({ ok: true });
      expect(r.d1.list).toEqual(["a", "b"]); // claimedAt ASC: a(10), b(30)
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // serviceInvites (service_invites) — the UNIQUE(secret_hash) index + the
  // conditional first-bind UPDATE (atomic redeem) are the classic
  // UNIQUE/conditional-UPDATE divergence risk (D1 relies on meta.changes;
  // InMemory checks explicitly).
  // ────────────────────────────────────────────────────────────────────
  describe("serviceInvites", () => {
    const mk = (id: string, secret: string, extra: { authorAID?: string; createdAt?: number } = {}) => ({
      inviteId: id,
      authorAID: extra.authorAID ?? "aa".repeat(32),
      serviceRef: "alice-notes",
      encryptedBundle: "deadbeef",
      secretHash: secret,
      createdAt: extra.createdAt ?? 1000,
    });

    it("create idempotent-same / reject-id-clash / reject-secret-reuse", async () => {
      const r = await bothAdapters(async (s) => {
        const first = await s.serviceInvites.create(mk("id1", "11".repeat(32)));
        const same = await s.serviceInvites.create(mk("id1", "11".repeat(32)));
        const idClash = await s.serviceInvites.create({ ...mk("id1", "99".repeat(32)), serviceRef: "x" });
        const secretReuse = await s.serviceInvites.create(mk("id2", "11".repeat(32)));
        return {
          first,
          same,
          idClashOk: idClash.ok,
          secretReuseOk: secretReuse.ok,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ first: { ok: true }, same: { ok: true }, idClashOk: false, secretReuseOk: false });
    });

    it("redeem: first-bind, same-AID idempotent, different-AID rejected", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serviceInvites.create(mk("id1", "11".repeat(32)));
        const first = await s.serviceInvites.redeem("11".repeat(32), "bb".repeat(32), 2000);
        const sameAid = await s.serviceInvites.redeem("11".repeat(32), "bb".repeat(32), 9999);
        const diffAid = await s.serviceInvites.redeem("11".repeat(32), "cc".repeat(32), 3000);
        const unknown = await s.serviceInvites.redeem("ff".repeat(32), "bb".repeat(32), 1);
        const bound = (await s.serviceInvites.get("id1"))!;
        return {
          firstBind: first.ok && first.firstBind,
          firstBoundAt: first.ok ? first.record.boundAt : null,
          sameBind: sameAid.ok && sameAid.firstBind,
          diffAid,
          unknown,
          boundAID: bound.boundAID,
          boundAt: bound.boundAt,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        firstBind: true,
        firstBoundAt: 2000,
        sameBind: false,
        diffAid: { ok: false, reason: "already bound" },
        unknown: { ok: false, reason: "unknown secret" },
        boundAID: "bb".repeat(32),
        boundAt: 2000,
      });
    });

    it("revoke denies redeem; revoke idempotent; unknown id → false", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serviceInvites.create(mk("id1", "11".repeat(32)));
        const rev = await s.serviceInvites.revoke("id1", 1500);
        const revAgain = await s.serviceInvites.revoke("id1", 9999);
        const denied = await s.serviceInvites.redeem("11".repeat(32), "bb".repeat(32), 2000);
        const revokedAt = (await s.serviceInvites.get("id1"))!.revokedAt;
        const unknownRevoke = await s.serviceInvites.revoke("nope", 1);
        return { rev, revAgain, denied, revokedAt, unknownRevoke };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        rev: true,
        revAgain: true,
        denied: { ok: false, reason: "revoked" },
        revokedAt: 1500,
        unknownRevoke: false,
      });
    });

    it("listForAuthor is createdAt DESC, scoped per author", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serviceInvites.create(mk("a", "01".repeat(32), { createdAt: 10 }));
        await s.serviceInvites.create(mk("b", "02".repeat(32), { createdAt: 30 }));
        await s.serviceInvites.create(mk("c", "03".repeat(32), { createdAt: 20 }));
        await s.serviceInvites.create(mk("d", "04".repeat(32), { authorAID: "cc".repeat(32), createdAt: 99 }));
        return {
          mine: (await s.serviceInvites.listForAuthor("aa".repeat(32))).map((x) => x.inviteId),
          theirs: (await s.serviceInvites.listForAuthor("cc".repeat(32))).map((x) => x.inviteId),
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({ mine: ["b", "c", "a"], theirs: ["d"] });
    });

    // v2 hardening (migration 0057): the v2 columns + the bindings ledger +
    // GROUP multi-bind + expiry + revokedSince must read identically on both.
    it("v2 fields round-trip + group multi-bind + cap + expiry + revokedSince", async () => {
      const r = await bothAdapters(async (s) => {
        await s.serviceInvites.create(mk("p", "11".repeat(32)));
        await s.serviceInvites.create({
          inviteId: "g",
          authorAID: "aa".repeat(32),
          serviceRef: "alice-notes",
          encryptedBundle: "deadbeef",
          secretHash: "22".repeat(32),
          createdAt: 1000,
          createSig: "ab".repeat(64),
          maxRedemptions: 2,
          expiresAt: 9000,
          approvalMode: "manual",
        });
        const pDefaults = (await s.serviceInvites.get("p"))!;
        const gMeta = (await s.serviceInvites.get("g"))!;
        const b1 = await s.serviceInvites.redeem("22".repeat(32), "bb".repeat(32), 100);
        const b2 = await s.serviceInvites.redeem("22".repeat(32), "cc".repeat(32), 200);
        const b3 = await s.serviceInvites.redeem("22".repeat(32), "dd".repeat(32), 300);
        const dupe = await s.serviceInvites.redeem("22".repeat(32), "bb".repeat(32), 400);
        const gBound = (await s.serviceInvites.get("g"))!;
        await s.serviceInvites.create({
          inviteId: "e",
          authorAID: "aa".repeat(32),
          serviceRef: "x",
          encryptedBundle: "ff",
          secretHash: "33".repeat(32),
          createdAt: 1,
          expiresAt: 1000,
        });
        const expired = await s.serviceInvites.redeem("33".repeat(32), "bb".repeat(32), 1001);
        await s.serviceInvites.revoke("g", 5000);
        const revoked = await s.serviceInvites.revokedSince("aa".repeat(32), 0);
        return {
          pSig: pDefaults.createSig,
          pMax: pDefaults.maxRedemptions,
          pMode: pDefaults.approvalMode,
          gSig: gMeta.createSig,
          gMax: gMeta.maxRedemptions,
          gExp: gMeta.expiresAt,
          gMode: gMeta.approvalMode,
          b1First: b1.ok && b1.firstBind,
          b2First: b2.ok && b2.firstBind,
          b3,
          dupeFirst: dupe.ok && dupe.firstBind,
          gBoundFirst: gBound.boundAID,
          gBoundAt: gBound.boundAt,
          gBoundAIDs: gBound.boundAIDs,
          gRedemptions: gBound.redemptions,
          expired,
          revoked,
        };
      });
      expectParity(r);
      expect(r.d1).toEqual({
        pSig: null,
        pMax: null,
        pMode: "auto",
        gSig: "ab".repeat(64),
        gMax: 2,
        gExp: 9000,
        gMode: "manual",
        b1First: true,
        b2First: true,
        b3: { ok: false, reason: "max redemptions reached" },
        dupeFirst: false,
        gBoundFirst: "bb".repeat(32),
        gBoundAt: 100,
        gBoundAIDs: ["bb".repeat(32), "cc".repeat(32)],
        gRedemptions: 2,
        expired: { ok: false, reason: "expired" },
        revoked: [
          {
            inviteId: "g",
            serviceRef: "alice-notes",
            boundAIDs: ["bb".repeat(32), "cc".repeat(32)],
            revokedAt: 5000,
          },
        ],
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Harness self-check: the SQLite DB is the REAL prod schema (every
  // migration applied), with exactly the documented tolerated no-op.
  // ────────────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────
  // Peer-backup manifests (0080) — latest-wins upsert by generation
  // ────────────────────────────────────────────────────────────────────
  describe("peerBackupManifests", () => {
    const rec = (over: Partial<import("../src/types.js").PeerBackupManifestRecord> = {}) => ({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      generation: 1,
      updatedAt: 1000,
      ciphertextHex: "aa".repeat(64),
      nonceHex: "bb".repeat(12),
      ...over,
    });

    it("put + get round-trips", async () => {
      const r = await bothAdapters(async (s) => {
        const put = await s.peerBackupManifests.put(rec());
        const got = await s.peerBackupManifests.get("HOME.alice.flagship.services");
        return { put, got };
      });
      expect(r.mem).toEqual(r.d1);
      expect(r.mem.put).toEqual({ ok: true });
      expect(r.mem.got?.generation).toBe(1);
    });

    it("newer generation overwrites; stale generation is rejected", async () => {
      const r = await bothAdapters(async (s) => {
        await s.peerBackupManifests.put(rec({ generation: 2, ciphertextHex: "cc".repeat(4) }));
        const stale = await s.peerBackupManifests.put(rec({ generation: 2, ciphertextHex: "dd".repeat(4) }));
        const older = await s.peerBackupManifests.put(rec({ generation: 1 }));
        const newer = await s.peerBackupManifests.put(rec({ generation: 3, ciphertextHex: "ee".repeat(4) }));
        const got = await s.peerBackupManifests.get(rec().serverDomain);
        return { stale, older, newer, got };
      });
      expect(r.mem).toEqual(r.d1);
      expect(r.mem.stale).toEqual({ ok: false, reason: "stale generation" });
      expect(r.mem.older).toEqual({ ok: false, reason: "stale generation" });
      expect(r.mem.newer).toEqual({ ok: true });
      expect(r.mem.got?.generation).toBe(3);
      expect(r.mem.got?.ciphertextHex).toBe("ee".repeat(4));
    });

    it("get is non-consuming; delete removes", async () => {
      const r = await bothAdapters(async (s) => {
        await s.peerBackupManifests.put(rec());
        const first = await s.peerBackupManifests.get(rec().serverDomain);
        const second = await s.peerBackupManifests.get(rec().serverDomain);
        const del = await s.peerBackupManifests.delete(rec().serverDomain);
        const gone = await s.peerBackupManifests.get(rec().serverDomain);
        const delAgain = await s.peerBackupManifests.delete(rec().serverDomain);
        return { first, second, del, gone, delAgain };
      });
      expect(r.mem).toEqual(r.d1);
      expect(r.mem.first).toEqual(r.mem.second);
      expect(r.mem.del).toBe(true);
      expect(r.mem.gone).toBeUndefined();
      expect(r.mem.delAgain).toBe(false);
    });
  });

  describe("migration application", () => {
    it("applies the whole migration ledger cleanly (0026 is a SELECT 1; no-op)", () => {
      const sqlite = createSqliteD1();
      openHandles.push(sqlite);
      // 0026 historically renamed custom_domain_orders.app_id → service_id, but
      // fresh DBs already have service_id (0022 was edited in-place pre-launch),
      // so the rename was made a forward-only, replay-safe `SELECT 1;` no-op (it
      // aborted `wrangler d1 migrations apply` on a fresh DB otherwise). It now
      // APPLIES cleanly — there is no longer any error-tolerated divergence.
      expect(sqlite.toleratedNoOps).toHaveLength(0);
    });
  });
});
