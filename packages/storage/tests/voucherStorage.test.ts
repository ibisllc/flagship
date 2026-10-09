import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import { D1VoucherStorage, InMemoryVoucherStorage } from "../src/index.js";
import type { VoucherStorage } from "../src/index.js";

// Parity: vouchers over D1 (sqlite, migrations 0052 + 0093) and in memory —
// kinds round-trip, redeem is single-use, and release only undoes the
// redeemer's own redemption.

function suite(name: string, make: () => VoucherStorage, teardown?: () => void) {
  describe(name, () => {
    afterEach(() => teardown?.());

    it("defaults to the tier kind and keeps an explicit kind", async () => {
      const s = make();
      await s.create({ codeHash: "a", tier: "hobby", durationDays: 30, createdAt: 1 });
      await s.create({ codeHash: "b", kind: "name-change", tier: "free", durationDays: 0, createdAt: 1 });
      await s.create({ codeHash: "c", kind: "dibs-claim", tier: "free", durationDays: 0, createdAt: 1 });
      expect((await s.get("a"))?.kind).toBe("tier");
      expect((await s.get("b"))?.kind).toBe("name-change");
      expect((await s.get("c"))?.kind).toBe("dibs-claim");
    });

    it("redeem is single-use and release only reverts the redeemer's own", async () => {
      const s = make();
      await s.create({ codeHash: "b", kind: "name-change", tier: "free", durationDays: 0, createdAt: 1 });
      expect(await s.redeem("b", "fresh-poppy", 5)).toBe(true);
      expect(await s.redeem("b", "rapid-bison", 6)).toBe(false);
      expect(await s.release("b", "rapid-bison")).toBe(false);
      expect(await s.release("b", "fresh-poppy")).toBe(true);
      expect((await s.get("b"))?.redeemedAt).toBeUndefined();
      expect(await s.redeem("b", "rapid-bison", 7)).toBe(true);
    });
  });
}

suite("InMemoryVoucherStorage", () => new InMemoryVoucherStorage());

let db: SqliteD1 | undefined;
suite(
  "D1VoucherStorage",
  () => {
    db = createSqliteD1();
    return new D1VoucherStorage(db);
  },
  () => {
    db?.close();
    db = undefined;
  },
);
