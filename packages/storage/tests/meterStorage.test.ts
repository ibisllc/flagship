/**
 * MeterStorage contract (migration 0069) — the metering core's counters.
 *
 * Every case runs against the InMemory adapter AND the real D1 adapter over
 * a fully-migrated node:sqlite, so the two can't drift. The last block checks
 * 0069's one-time copy of the old egress counters.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { D1MeterStorage, InMemoryMeterStorage, type MeterStorage } from "../src/index.js";
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
