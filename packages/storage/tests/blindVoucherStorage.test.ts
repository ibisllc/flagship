import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import { D1BlindVoucherStorage, InMemoryBlindVoucherStorage, type BlindVoucherStorage } from "../src/index.js";

// A spend is all its vouchers or none: every fresh nullifier in one call must come back as won. Production D1
// doesn't give each statement of a batch its own `meta.changes` (the live gym, 2026-11-17), so the D1 store is also
// run behind a wrapper that reports the batch's running total there.

/** D1 as the live gym showed it: in a batch, `meta.changes` is the running total of the batch's writes. */
function cumulativeChanges(db: SqliteD1): SqliteD1 {
  return {
    ...db,
    prepare: (q: string) => db.prepare(q),
    async batch(stmts) {
      const out = await db.batch(stmts);
      let total = 0;
      return out.map((r) => {
        total += r.meta?.changes ?? 0;
        return { ...r, meta: { ...r.meta, changes: total } };
      });
    },
  } as SqliteD1;
}

let db: SqliteD1 | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

const stores: Array<[string, () => BlindVoucherStorage]> = [
  ["in memory", () => new InMemoryBlindVoucherStorage()],
  ["D1 (sqlite)", () => new D1BlindVoucherStorage((db = createSqliteD1()))],
  ["D1 (batch changes as a running total)", () => new D1BlindVoucherStorage(cumulativeChanges((db = createSqliteD1())))],
];

describe.each(stores)("blind voucher nullifiers: %s", (_name, make) => {
  const item = (n: string) => ({ nullifier: n.repeat(64).slice(0, 64), keyId: "k1" });

  it("several fresh vouchers in one spend are all won", async () => {
    const s = make();
    expect(await s.spend([item("a"), item("b"), item("c")], "2026-11-17")).toEqual([true, true, true]);
  });

  it("only the one already spent is lost, wherever it sits in the call", async () => {
    const s = make();
    expect(await s.spend([item("b")], "2026-11-17")).toEqual([true]);
    expect(await s.spend([item("a"), item("b"), item("c")], "2026-11-17")).toEqual([true, false, true]);
    expect(await s.spend([item("a"), item("c")], "2026-11-17")).toEqual([false, false]);
  });

  it("unspend puts nullifiers back", async () => {
    const s = make();
    await s.spend([item("a"), item("b")], "2026-11-17");
    await s.unspend([item("a").nullifier]);
    expect(await s.spend([item("a"), item("b")], "2026-11-17")).toEqual([true, false]);
  });
});
