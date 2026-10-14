import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { meterStoreConformance } from "@ibisllc/billing-metering/conformance";
import { SqliteMeterStore, type SqliteDatabaseLike } from "../src/index.js";

const require = createRequire(import.meta.url);
type Db = SqliteDatabaseLike & { close(): void };

function tryLoad<T>(id: string): T | undefined {
  try {
    return require(id) as T;
  } catch {
    return undefined;
  }
}
// node:sqlite through createRequire: Vite's resolver doesn't know the builtin.
const nodeSqlite = tryLoad<{ DatabaseSync: new (path: string) => Db }>("node:sqlite");
const BetterSqlite3 = tryLoad<new (path: string) => Db>("better-sqlite3");

const drivers: Array<[string, ((path: string) => Db) | undefined]> = [
  ["node:sqlite", nodeSqlite && ((p) => new nodeSqlite.DatabaseSync(p))],
  ["better-sqlite3", BetterSqlite3 && ((p) => new BetterSqlite3(p))],
];

const open: Db[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const d of open) d.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

for (const [name, openDb] of drivers) {
  describe.skipIf(!openDb)(`SqliteMeterStore on ${name}`, () => {
    const connect = (path = ":memory:") => {
      const db = openDb!(path);
      open.push(db);
      return db;
    };

    describe("conformance", () => {
      for (const c of meterStoreConformance({
        make: () => {
          const s = new SqliteMeterStore(connect());
          s.migrate();
          return s;
        },
      })) {
        it(c.name, c.run);
      }
    });

    describe("conformance with custom table names", () => {
      for (const c of meterStoreConformance({
        make: () => {
          const s = new SqliteMeterStore(connect(), { tables: { counters: "acct_usage", batches: "acct_usage_batches" } });
          s.migrate();
          return s;
        },
      })) {
        it(c.name, c.run);
      }
    });

    it("two connections to one file count a batch id once", async () => {
      const dir = mkdtempSync(join(tmpdir(), "billing-sqlite-"));
      dirs.push(dir);
      const file = join(dir, "meter.db");
      const a = connect(file);
      a.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      const b = connect(file);
      b.exec("PRAGMA busy_timeout = 5000;");
      const sa = new SqliteMeterStore(a);
      const sb = new SqliteMeterStore(b);
      sa.migrate();
      sb.migrate();
      const entries = [{ account: "ann", resource: "r", period: "p", amount: 5 }];
      expect(await sa.addBatch("batch-0000000000000001", entries, 1, 100)).toEqual({ duplicate: false, totals: [5] });
      expect(await sb.addBatch("batch-0000000000000001", entries, 2, 100)).toEqual({ duplicate: true });
      expect(await sb.add("ann", "r", "p", 1, 3)).toBe(6);
      expect((await sa.get("ann", "r", "p"))?.amount).toBe(6);
    });

    it("rolls a failed batch back completely", async () => {
      const db = connect();
      const s = new SqliteMeterStore(db);
      s.migrate();
      db.exec(`CREATE TRIGGER no_bo BEFORE INSERT ON meter_counters WHEN NEW.account = 'bo'
               BEGIN SELECT RAISE(ABORT, 'no bo'); END`);
      const entries = [
        { account: "ann", resource: "r", period: "p", amount: 5 },
        { account: "bo", resource: "r", period: "p", amount: 1 },
      ];
      await expect(s.addBatch("batch-0000000000000001", entries, 1, 100)).rejects.toThrow(/no bo/);
      expect(await s.get("ann", "r", "p")).toBeUndefined();
      db.exec("DROP TRIGGER no_bo");
      expect(await s.addBatch("batch-0000000000000001", entries, 2, 100)).toEqual({ duplicate: false, totals: [5, 1] });
    });
  });
}

it("at least one SQLite driver is available", () => {
  expect(drivers.some(([, d]) => d !== undefined)).toBe(true);
});

it.runIf(process.env.BILLING_REQUIRE_ALL_DRIVERS === "1")("both node:sqlite and better-sqlite3 were tested", () => {
  expect(drivers.every(([, d]) => d !== undefined)).toBe(true);
});
