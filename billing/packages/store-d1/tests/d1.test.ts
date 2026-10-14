import { afterAll, describe, expect, it } from "vitest";
import { meterStoreConformance } from "@ibisllc/billing-metering/conformance";
import { D1MeterStore, d1MeterSchema } from "../src/index.js";
import { sqliteD1, type SqliteD1 } from "./support/sqliteD1.js";

const open: SqliteD1[] = [];
afterAll(() => open.forEach((d) => d.close()));
function db(): SqliteD1 {
  const d = sqliteD1();
  open.push(d);
  return d;
}

describe("D1MeterStore conformance (node:sqlite D1 stand-in)", () => {
  for (const c of meterStoreConformance({
    make: async () => {
      const s = new D1MeterStore(db());
      await s.migrate();
      return s;
    },
  })) {
    it(c.name, c.run);
  }
});

describe("D1MeterStore conformance with custom table names", () => {
  for (const c of meterStoreConformance({
    make: () => {
      const d = db();
      d.exec(d1MeterSchema({ counters: "usage_counters", batches: "usage_batch_ids" }));
      return new D1MeterStore(d, { tables: { counters: "usage_counters", batches: "usage_batch_ids" } });
    },
  })) {
    it(c.name, c.run);
  }
});

describe("D1MeterStore", () => {
  it("costs one batch() per addBatch, whatever its size", async () => {
    const d = db();
    const s = new D1MeterStore(d);
    await s.migrate();
    const before = d.batches;
    const entries = Array.from({ length: 200 }, (_, i) => ({ account: `a${i}`, resource: "r", period: "p", amount: 1 }));
    await s.addBatch("batch-0000000000000001", entries, 1, 100);
    expect(d.batches - before).toBe(1);
  });

  it("refuses unsafe table names", () => {
    expect(() => new D1MeterStore(db(), { tables: { counters: "x; DROP TABLE y" } })).toThrow(RangeError);
  });
});
