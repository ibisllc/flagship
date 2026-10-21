import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import { D1NameDibsClaimStorage, InMemoryNameDibsClaimStorage } from "../src/index.js";
import type { NameDibsClaimStorage } from "../src/index.js";

// Parity: the same assertions against the D1 adapter (sqlite + migration 0092)
// and the in-memory store. The load-bearing rule is "first verified claim wins"
// — at most one verified row per name.

const start = (name: string, username: string, nonce = "aa", createdAt = 1000) => ({
  name, username, irkPubHex: "11".repeat(32), nonce, createdAt,
});

function suite(name: string, make: () => NameDibsClaimStorage, teardown?: () => void) {
  describe(name, () => {
    afterEach(() => teardown?.());

    it("start() records a claim and a restart refreshes its nonce", async () => {
      const s = make();
      const a = await s.start(start("acme", "fresh-poppy", "aa"));
      expect(a).toMatchObject({ name: "acme", username: "fresh-poppy", nonce: "aa", attempts: 1 });
      const b = await s.start(start("acme", "fresh-poppy", "bb", 2000));
      expect(b).toMatchObject({ nonce: "bb", attempts: 2, createdAt: 2000 });
      expect(b.verifiedAt).toBeUndefined();
    });

    it("the first verified claim wins; a second claimant gets 'taken'", async () => {
      const s = make();
      await s.start(start("acme", "fresh-poppy"));
      await s.start(start("acme", "rapid-bison"));
      expect(await s.markVerified("acme", "fresh-poppy", "dns", 3000)).toEqual({ ok: true });
      expect(await s.markVerified("acme", "rapid-bison", "http", 3001)).toEqual({ ok: false, reason: "taken" });
      expect((await s.winner("acme"))?.username).toBe("fresh-poppy");
      expect((await s.get("acme", "rapid-bison"))?.verifiedAt).toBeUndefined();
    });

    it("re-verifying the winner is idempotent and a restart can't reset it", async () => {
      const s = make();
      await s.start(start("acme", "fresh-poppy", "aa"));
      await s.markVerified("acme", "fresh-poppy", "dns", 3000);
      expect(await s.markVerified("acme", "fresh-poppy", "http", 4000)).toEqual({ ok: true });
      const again = await s.start(start("acme", "fresh-poppy", "zz", 5000));
      expect(again).toMatchObject({ nonce: "aa", verifiedAt: 3000, method: "dns" });
    });

    it("markVerified() on an unknown claim reports 'missing'", async () => {
      expect(await make().markVerified("acme", "nobody", "dns", 1)).toEqual({ ok: false, reason: "missing" });
    });

    it("markConsumed() needs a verified, unconsumed claim and is single-use", async () => {
      const s = make();
      await s.start(start("acme", "fresh-poppy"));
      expect(await s.markConsumed("acme", "fresh-poppy", 1)).toBe(false);
      await s.markVerified("acme", "fresh-poppy", "dns", 2);
      expect(await s.markConsumed("acme", "fresh-poppy", 3)).toBe(true);
      expect(await s.markConsumed("acme", "fresh-poppy", 4)).toBe(false);
      expect((await s.get("acme", "fresh-poppy"))?.consumedAt).toBe(3);
    });

    it("countStartsSince() counts every start by the account, across names", async () => {
      const s = make();
      await s.start(start("acme", "fresh-poppy", "a", 100));
      await s.start(start("acme", "fresh-poppy", "b", 200));
      await s.start(start("other", "fresh-poppy", "c", 300));
      await s.start(start("acme", "rapid-bison", "d", 300));
      expect(await s.countStartsSince("fresh-poppy", 150)).toBe(2);
      expect(await s.countStartsSince("fresh-poppy", 0)).toBe(3);
    });
  });
}

suite("InMemoryNameDibsClaimStorage", () => new InMemoryNameDibsClaimStorage());

let db: SqliteD1 | undefined;
suite(
  "D1NameDibsClaimStorage",
  () => {
    db = createSqliteD1();
    return new D1NameDibsClaimStorage(db);
  },
  () => {
    db?.close();
    db = undefined;
  },
);
