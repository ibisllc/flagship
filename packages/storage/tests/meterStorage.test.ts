/**
 * MeterStorage contract (migration 0069) — the metering core's counters.
 *
 * Every case runs against the InMemory adapter AND the real D1 adapter over
 * a fully-migrated node:sqlite, so the two can't drift. The last blocks check
 * 0069's one-time copy of the old egress counters, and that 0069 matches the
 * portable schema @ibisllc/billing-metering ships.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  D1MeterStorage,
  D1TierStorage,
  InMemoryMeterStorage,
  InMemoryTierStorage,
  type MeterStorage,
  type TierStorage,
} from "../src/index.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";

const handles: SqliteD1[] = [];
afterAll(() => {
  for (const h of handles) h.close();
});

function d1(): { store: D1MeterStorage; sqlite: SqliteD1 } {
  const sqlite = createSqliteD1();
  handles.push(sqlite);
  return { store: new D1MeterStorage(sqlite), sqlite };
}

const adapters: Array<[string, () => MeterStorage]> = [
  ["InMemory", () => new InMemoryMeterStorage()],
  ["D1", () => d1().store],
];

describe.each(adapters)("MeterStorage (%s)", (_name, make) => {
  it("add creates the counter at the delta and returns the running total", async () => {
    const s = make();
    expect(await s.add("alice", "egress", "2026-10", 100, 1)).toBe(100);
    expect(await s.add("alice", "egress", "2026-10", 50, 2)).toBe(150);
    expect(await s.get("alice", "egress", "2026-10")).toEqual({
      account: "alice",
      resource: "egress",
      period: "2026-10",
      amount: 150,
      updatedAt: 2,
    });
  });

  it("keeps account, resource and period apart", async () => {
    const s = make();
    await s.add("alice", "egress", "2026-10", 10, 1);
    await s.add("alice", "ai-tokens", "2026-10", 20, 1);
    await s.add("alice", "egress", "2026-11", 30, 1);
    await s.add("bob", "egress", "2026-10", 40, 1);
    expect((await s.get("alice", "egress", "2026-10"))?.amount).toBe(10);
    expect((await s.get("alice", "ai-tokens", "2026-10"))?.amount).toBe(20);
    expect((await s.get("alice", "egress", "2026-11"))?.amount).toBe(30);
    expect((await s.get("bob", "egress", "2026-10"))?.amount).toBe(40);
  });

  it("floors fractions and never lets a negative delta decrement", async () => {
    const s = make();
    await s.add("alice", "egress", "2026-10", 10.9, 1);
    expect(await s.add("alice", "egress", "2026-10", -5, 2)).toBe(10);
  });

  it("get of an absent counter is undefined", async () => {
    expect(await make().get("nobody", "egress", "2026-10")).toBeUndefined();
  });
});

describe("migration 0069 — copies the old egress counters", () => {
  const sql = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../migrations/0069_meter_counters.sql"),
    "utf8",
  );

  it("moves usage_counters rows to resource 'egress', and a re-run never double-counts", async () => {
    const { store, sqlite } = d1();
    sqlite.raw.exec(
      `INSERT INTO usage_counters (username, period, bytes_egress, updated_at) VALUES ('alice','2026-10',500,7)`,
    );
    sqlite.raw.exec(sql);
    expect(await store.get("alice", "egress", "2026-10")).toEqual({
      account: "alice",
      resource: "egress",
      period: "2026-10",
      amount: 500,
      updatedAt: 7,
    });
    await store.add("alice", "egress", "2026-10", 100, 9);
    sqlite.raw.exec(sql);
    expect((await store.get("alice", "egress", "2026-10"))?.amount).toBe(600);
  });
});

describe("migration 0069 — the billing package's portable schema", () => {
  it("has the same columns and key as billing/packages/metering/schema/meter_counters.sql", () => {
    const { sqlite } = d1();
    const portable = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../billing/packages/metering/schema/meter_counters.sql"),
      "utf8",
    );
    sqlite.raw.exec(portable.replaceAll("meter_counters", "portable_meter_counters"));
    const shape = (table: string) =>
      (sqlite.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; pk: number }>).map(
        (c) => [c.name, c.notnull, c.pk],
      );
    expect(shape("meter_counters")).toEqual(shape("portable_meter_counters"));
  });
});

describe.each(adapters)("MeterStorage.addBatch (%s)", (_name, make) => {
  const e = (account: string, amount: number) => ({ account, resource: "egress", period: "2026-10", amount });

  it("adds every entry once and returns the new totals in order", async () => {
    const s = make();
    await s.add("alice", "egress", "2026-10", 5, 1);
    expect(await s.addBatch!("0123456789abcdef0123456789abcdef", [e("alice", 10), e("bob", 3)], 2, 100)).toEqual({
      duplicate: false,
      totals: [15, 3],
    });
  });

  it("a retried batch id changes nothing until it expires", async () => {
    const s = make();
    const id = "0123456789abcdef0123456789abcdef";
    await s.addBatch!(id, [e("alice", 10)], 1, 100);
    expect(await s.addBatch!(id, [e("alice", 10)], 50, 150)).toEqual({ duplicate: true });
    expect((await s.get("alice", "egress", "2026-10"))?.amount).toBe(10);
    expect(await s.addBatch!(id, [e("alice", 10)], 101, 200)).toEqual({ duplicate: false, totals: [20] });
  });
});

describe("migration 0070 — meter_batches", () => {
  it("holds only an id, a claim and an expiry, like the billing package's portable schema", () => {
    const { sqlite } = d1();
    const portable = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../billing/packages/metering/schema/meter_batches.sql"),
      "utf8",
    );
    sqlite.raw.exec(portable.replaceAll("meter_batches", "portable_meter_batches"));
    const shape = (table: string) =>
      (sqlite.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; pk: number }>).map(
        (c) => [c.name, c.notnull, c.pk],
      );
    expect(shape("meter_batches")).toEqual([
      ["batch_id", 1, 1],
      ["claim", 1, 0],
      ["keep_until", 1, 0],
    ]);
    expect(shape("meter_batches")).toEqual(shape("portable_meter_batches"));
  });

  it("prunes expired ids as later batches arrive", async () => {
    const { store, sqlite } = d1();
    for (let i = 0; i < 40; i++) {
      await store.addBatch(`batch-${String(i).padStart(12, "0")}`, [], i, i + 10);
    }
    const n = (sqlite.raw.prepare("SELECT COUNT(*) AS n FROM meter_batches").get() as { n: number }).n;
    expect(n).toBeLessThanOrEqual(11);
  });

  it("a batch that fails part-way adds nothing (one transaction)", async () => {
    const { store, sqlite } = d1();
    sqlite.raw.exec("CREATE TRIGGER boom BEFORE INSERT ON meter_counters WHEN NEW.account = 'bad' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(
      store.addBatch("0123456789abcdef0123456789abcdef", [{ account: "alice", resource: "egress", period: "2026-10", amount: 1 }, { account: "bad", resource: "egress", period: "2026-10", amount: 1 }], 1, 100),
    ).rejects.toThrow(/boom/);
    expect(await store.get("alice", "egress", "2026-10")).toBeUndefined();
    expect((sqlite.raw.prepare("SELECT COUNT(*) AS n FROM meter_batches").get() as { n: number }).n).toBe(0);
  });
});

describe.each<[string, () => TierStorage]>([
  ["InMemory", () => new InMemoryTierStorage()],
  ["D1", () => new D1TierStorage(d1().sqlite)],
])("TierStorage.getMany (%s) — one lookup per relay batch", (_name, make) => {
  it("returns only the usernames with a record, across D1's 100-parameter chunks", async () => {
    const t = make();
    for (const u of ["alice", "u150"]) await t.put({ username: u, tier: "hobby", updatedAt: 1 });
    const names = ["alice", "bob", "alice", ...Array.from({ length: 200 }, (_, i) => `u${i}`)];
    const got = await t.getMany!(names);
    expect([...got.keys()].sort()).toEqual(["alice", "u150"]);
    expect(got.get("u150")?.tier).toBe("hobby");
    expect((await t.getMany!([])).size).toBe(0);
  });
});
