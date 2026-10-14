// Runs the conformance suite on PGlite (Postgres compiled to WASM, in
// process) always, and on a real PostgreSQL server when BILLING_TEST_PG_URL
// is set (CI starts one). Each store gets its own tables, so one database
// serves every case.
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { meterStoreConformance } from "@ibisllc/billing-metering/conformance";
import { PostgresMeterStore, type PgQueryable } from "../src/index.js";

let seq = 0;
const tables = () => {
  const n = `${process.pid}_${++seq}`;
  return { counters: `c_${n}`, batches: `b_${n}` };
};

const PG_URL = process.env.BILLING_TEST_PG_URL;
const lite = new PGlite();
const pool = PG_URL ? new pg.Pool({ connectionString: PG_URL, max: 10 }) : undefined;
afterAll(async () => {
  await lite.close();
  await pool?.end();
});

const targets: Array<[string, PgQueryable | undefined]> = [
  ["PGlite", lite],
  ["PostgreSQL server (BILLING_TEST_PG_URL)", pool],
];

for (const [name, db] of targets) {
  describe.skipIf(!db)(`PostgresMeterStore on ${name}`, () => {
    describe("conformance", () => {
      for (const c of meterStoreConformance({
        make: async () => {
          const s = new PostgresMeterStore(db!, { tables: tables() });
          await s.migrate();
          return s;
        },
      })) {
        it(c.name, c.run);
      }
    });

    it("migrate is idempotent and the default tables work", async () => {
      await db!.query("DROP SCHEMA IF EXISTS billing_test_default CASCADE");
      await db!.query("CREATE SCHEMA billing_test_default");
      const s = new PostgresMeterStore(db!, { schema: "billing_test_default" });
      await s.migrate();
      await s.migrate();
      expect(await s.add("ann", "r", "p", 3, 1)).toBe(3);
      const { rows } = await db!.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'billing_test_default' ORDER BY tablename",
      );
      expect(rows).toEqual([{ tablename: "meter_batches" }, { tablename: "meter_counters" }]);
      await db!.query("DROP SCHEMA billing_test_default CASCADE");
    });

    it("refuses unsafe identifiers", () => {
      expect(() => new PostgresMeterStore(db!, { schema: "x; DROP" })).toThrow(RangeError);
      expect(() => new PostgresMeterStore(db!, { tables: { batches: "a.b" } })).toThrow(RangeError);
    });
  });
}

it.runIf(process.env.BILLING_REQUIRE_ALL_DRIVERS === "1")("a real PostgreSQL server was tested", () => {
  expect(PG_URL).toBeTruthy();
});
