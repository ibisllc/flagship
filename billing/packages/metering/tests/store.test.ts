import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { meterStoreConformance } from "../src/conformance.js";
import { InMemoryMeterStore, meterSchemaSql, meterTableNames } from "../src/index.js";

describe("InMemoryMeterStore conformance", () => {
  for (const c of meterStoreConformance({ make: () => new InMemoryMeterStore() })) it(c.name, c.run);
});

describe("InMemoryMeterStore", () => {
  it("forgets expired batch ids as new ones arrive", async () => {
    const s = new InMemoryMeterStore();
    await s.addBatch("batch-000000000000001", [], 1, 10);
    await s.addBatch("batch-000000000000002", [], 2, 10);
    expect(s.batchCount()).toBe(2);
    await s.addBatch("batch-000000000000003", [], 11, 100);
    expect(s.batchCount()).toBe(1);
  });
});

describe("the conformance kit", () => {
  it("fails a store that loses concurrent adds", async () => {
    class Racy extends InMemoryMeterStore {
      override async add(a: string, r: string, p: string, n: number, now: number) {
        const before = (await this.get(a, r, p))?.amount ?? 0;
        await new Promise((res) => setTimeout(res, 1));
        return super.add(a, r, p, before + n - ((await this.get(a, r, p))?.amount ?? 0), now);
      }
    }
    const c = meterStoreConformance({ make: () => new Racy() }).find((x) => x.name.startsWith("concurrent adds"))!;
    await expect(c.run()).rejects.toThrow(/final total/);
  });

  it("fails a store whose retried batch counts twice", async () => {
    class Leaky extends InMemoryMeterStore {
      override async addBatch(id: string, entries: Parameters<InMemoryMeterStore["addBatch"]>[1], now: number, keep: number) {
        return super.addBatch(`${id}-${now}`, entries, now, keep);
      }
    }
    const c = meterStoreConformance({ make: () => new Leaky() }).find((x) => x.name.includes("retried batch id"))!;
    await expect(c.run()).rejects.toThrow(/retry/);
  });

  it("can skip the batch cases", () => {
    const all = meterStoreConformance({ make: () => new InMemoryMeterStore() });
    const plain = meterStoreConformance({ make: () => new InMemoryMeterStore(), batches: false });
    expect(plain.length).toBeLessThan(all.length);
    expect(plain.every((c) => !c.name.startsWith("addBatch"))).toBe(true);
  });
});

describe("schema", () => {
  const file = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../schema", f), "utf8");
  const ddl = (sql: string) =>
    sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();

  it("schema/*.sql hold exactly the DDL meterSchemaSql() emits", () => {
    expect(ddl(file("meter_counters.sql") + file("meter_batches.sql"))).toBe(ddl(meterSchemaSql()));
  });

  it("names tables as asked and refuses anything but a plain identifier", () => {
    expect(meterSchemaSql({ counters: "usage_c", batches: "usage_b" })).toContain("CREATE TABLE IF NOT EXISTS usage_b (");
    expect(meterTableNames()).toEqual({ counters: "meter_counters", batches: "meter_batches" });
    for (const bad of ["x; DROP TABLE y", "a.b", "1abc", "", "x".repeat(53)]) {
      expect(() => meterTableNames({ counters: bad })).toThrow(RangeError);
    }
    expect(() => meterTableNames({ counters: "t", batches: "t" })).toThrow(RangeError);
  });
});
