import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryMeterStore, type MeterCounter, type MeterStore } from "../src/index.js";

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../schema/meter_counters.sql"), "utf8");

// The statements schema/meter_counters.sql documents, run for real.
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: unknown[]): unknown };
}
function sqliteStore(): MeterStore {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
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

describe.each<[string, () => MeterStore]>([
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
});
