import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryMeterStore, type MeterBatchResult, type MeterCounter, type MeterStore } from "../src/index.js";

const schema = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../schema", f), "utf8");
const SCHEMA = schema("meter_counters.sql") + schema("meter_batches.sql");

// The statements schema/meter_counters.sql documents, run for real.
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: unknown[]): unknown; run(...p: unknown[]): unknown };
}
type Store = MeterStore & Required<Pick<MeterStore, "addBatch">>;
function sqliteStore(): Store {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  let claims = 0;
  return {
    async addBatch(batchId, entries, now, keepUntil): Promise<MeterBatchResult> {
      const claim = `c${++claims}`;
      db.exec("BEGIN");
      try {
        db.prepare(
          `DELETE FROM meter_batches WHERE batch_id IN
             (SELECT batch_id FROM meter_batches WHERE keep_until < ? LIMIT 32)`,
        ).run(now);
        const claimed = db
          .prepare(
            `INSERT INTO meter_batches (batch_id, claim, keep_until) VALUES (?, ?, ?)
             ON CONFLICT (batch_id) DO NOTHING RETURNING batch_id`,
          )
          .get(batchId, claim, keepUntil);
        const totals: number[] = [];
        for (const e of entries) {
          const r = db
            .prepare(
              `INSERT INTO meter_counters (account, resource, period, amount, updated_at)
               SELECT ?, ?, ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM meter_batches WHERE batch_id = ? AND claim = ?)
               ON CONFLICT (account, resource, period) DO UPDATE SET
                 amount     = meter_counters.amount + excluded.amount,
                 updated_at = excluded.updated_at
               RETURNING amount`,
            )
            .get(e.account, e.resource, e.period, Math.max(0, Math.floor(e.amount)), now, batchId, claim) as
            | { amount: number }
            | undefined;
          if (r) totals.push(r.amount);
        }
        db.exec("COMMIT");
        return claimed ? { duplicate: false, totals } : { duplicate: true };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async add(account, resource, period, amount, now) {
      const r = db
        .prepare(
          `INSERT INTO meter_counters (account, resource, period, amount, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (account, resource, period) DO UPDATE SET
             amount     = meter_counters.amount + excluded.amount,
             updated_at = excluded.updated_at
           RETURNING amount`,
        )
        .get(account, resource, period, Math.max(0, Math.floor(amount)), now) as { amount: number };
      return r.amount;
    },
    async get(account, resource, period) {
      const r = db
        .prepare(
          `SELECT account, resource, period, amount, updated_at
           FROM meter_counters WHERE account = ? AND resource = ? AND period = ?`,
        )
        .get(account, resource, period) as
        | { account: string; resource: string; period: string; amount: number; updated_at: number }
        | undefined;
      return r
        ? ({ account: r.account, resource: r.resource, period: r.period, amount: r.amount, updatedAt: r.updated_at } satisfies MeterCounter)
        : undefined;
    },
  };
}

describe.each<[string, () => Store]>([
  ["InMemoryMeterStore", () => new InMemoryMeterStore()],
  ["SQL schema (SQLite)", sqliteStore],
])("%s", (_name, make) => {
  it("add creates the counter at the delta and returns the running total", async () => {
    const s = make();
    expect(await s.add("ann", "bandwidth", "2026-10", 100, 1)).toBe(100);
    expect(await s.add("ann", "bandwidth", "2026-10", 50, 2)).toBe(150);
    expect(await s.get("ann", "bandwidth", "2026-10")).toEqual({
      account: "ann",
      resource: "bandwidth",
      period: "2026-10",
      amount: 150,
      updatedAt: 2,
    });
  });

  it("keeps account, resource and period apart", async () => {
    const s = make();
    await s.add("ann", "bandwidth", "2026-10", 10, 1);
    await s.add("ann", "tokens", "2026-10", 20, 1);
    await s.add("ann", "bandwidth", "2026-11", 30, 1);
    await s.add("bo", "bandwidth", "2026-10", 40, 1);
    expect((await s.get("ann", "bandwidth", "2026-10"))?.amount).toBe(10);
    expect((await s.get("ann", "tokens", "2026-10"))?.amount).toBe(20);
    expect((await s.get("ann", "bandwidth", "2026-11"))?.amount).toBe(30);
    expect((await s.get("bo", "bandwidth", "2026-10"))?.amount).toBe(40);
  });

  it("floors fractions and never lets a negative delta decrement", async () => {
    const s = make();
    await s.add("ann", "bandwidth", "2026-10", 10.9, 1);
    expect(await s.add("ann", "bandwidth", "2026-10", -5, 2)).toBe(10);
  });

  it("holds amounts past 32 bits (bytes in a month)", async () => {
    const s = make();
    expect(await s.add("ann", "bandwidth", "2026-10", 300 * 1024 ** 3, 1)).toBe(300 * 1024 ** 3);
  });

  it("get of an absent counter is undefined", async () => {
    expect(await make().get("nobody", "bandwidth", "2026-10")).toBeUndefined();
  });

  it("an id containing separators can't collide with another key", async () => {
    const s = make();
    await s.add("a|b", "c", "d", 1, 1);
    expect(await s.get("a", "b|c", "d")).toBeUndefined();
  });

  describe("addBatch", () => {
    const e = (account: string, amount: number) => ({ account, resource: "bandwidth", period: "2026-10", amount });

    it("adds every entry once and returns the new totals in order", async () => {
      const s = make();
      await s.add("ann", "bandwidth", "2026-10", 5, 1);
      expect(await s.addBatch("b-0000000000000001", [e("ann", 10), e("bo", 3)], 2, 100)).toEqual({
        duplicate: false,
        totals: [15, 3],
      });
      expect((await s.get("bo", "bandwidth", "2026-10"))?.updatedAt).toBe(2);
    });

    it("a retried batch id changes nothing", async () => {
      const s = make();
      await s.addBatch("b-0000000000000001", [e("ann", 10)], 1, 100);
      expect(await s.addBatch("b-0000000000000001", [e("ann", 10)], 2, 100)).toEqual({ duplicate: true });
      expect((await s.get("ann", "bandwidth", "2026-10"))?.amount).toBe(10);
      expect(await s.addBatch("b-0000000000000002", [e("ann", 1)], 3, 100)).toEqual({ duplicate: false, totals: [11] });
    });

    it("forgets an id after keepUntil, so it would count again", async () => {
      const s = make();
      await s.addBatch("b-0000000000000001", [e("ann", 10)], 1, 50);
      expect(await s.addBatch("b-0000000000000001", [e("ann", 10)], 51, 200)).toEqual({ duplicate: false, totals: [20] });
    });

    it("an empty batch still claims its id", async () => {
      const s = make();
      expect(await s.addBatch("b-0000000000000001", [], 1, 100)).toEqual({ duplicate: false, totals: [] });
      expect(await s.addBatch("b-0000000000000001", [], 2, 100)).toEqual({ duplicate: true });
    });
  });
});
