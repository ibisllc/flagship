// Load test for the central report path: meterReport + meterLease over
// 10,000 accounts, on each store, at three report sizes, plus the edge hot
// path (LeaseBook.use + action per 16 KiB chunk).
//
//   npm run build && node bench/report-load.mjs [--seconds 3]
//
// The numbers measure this library and the database engine in process. A
// networked database adds a round trip per call (D1: one per report; the
// SQLite store: none; Postgres: one per report), which is what dominates in
// production; see docs/scaling.md.

import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { InMemoryMeterStore, LeaseBook, meterLease, meterReport } from "@ibisllc/billing-metering";
import { SqliteMeterStore } from "@ibisllc/billing-store-sqlite";
import { PostgresMeterStore } from "@ibisllc/billing-store-postgres";

const seconds = Number(process.argv[process.argv.indexOf("--seconds") + 1]) || 3;
const ACCOUNTS = 10_000;
const MiB = 1024 * 1024;
const catalog = {
  bandwidth: {
    unit: "bytes",
    period: "month",
    plans: { free: { allowance: 25 * 1024 * MiB, over: "throttle" }, pro: { allowance: 250 * 1024 * MiB, over: "allow" } },
  },
};
const policy = { fraction: 0.25, minGrant: MiB, maxGrant: 256 * MiB, ttlMs: 600_000, overTtlMs: 60_000 };

async function stores() {
  const out = [["in-memory", async () => new InMemoryMeterStore()]];
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    out.push([
      "SQLite (node:sqlite, :memory:)",
      async () => {
        const s = new SqliteMeterStore(new DatabaseSync(":memory:"));
        s.migrate();
        return s;
      },
    ]);
  } catch {}
  try {
    const { PGlite } = await import("@electric-sql/pglite");
    out.push([
      "PostgreSQL (PGlite, WASM)",
      async () => {
        const s = new PostgresMeterStore(new PGlite());
        await s.migrate();
        return s;
      },
    ]);
  } catch {}
  if (process.env.BILLING_TEST_PG_URL) {
    const { default: pg } = await import("pg");
    let n = 0;
    out.push([
      "PostgreSQL server",
      async () => {
        const pool = new pg.Pool({ connectionString: process.env.BILLING_TEST_PG_URL });
        const s = new PostgresMeterStore(pool, { tables: { counters: `bench_c_${process.pid}_${++n}`, batches: `bench_b_${process.pid}_${n}` } });
        await s.migrate();
        return s;
      },
    ]);
  }
  return out;
}

const hex = (i) => i.toString(16).padStart(32, "0");
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];

console.log(`${ACCOUNTS.toLocaleString()} accounts, ${seconds}s per row, Node ${process.version}\n`);
console.log("store                           | accounts/report | reports/s | counter rows/s | p50 ms | p99 ms");
console.log("------------------------------- | --------------- | --------- | -------------- | ------ | ------");
let batch = 0;
for (const [name, make] of await stores()) {
  for (const size of [1, 50, 500]) {
    const store = await make();
    const deps = { catalog, store, planOf: async (a) => (a.endsWith("7") ? "pro" : "free") };
    const times = [];
    const end = performance.now() + seconds * 1000;
    let next = 0;
    while (performance.now() < end) {
      const items = [];
      for (let i = 0; i < size; i++) items.push({ account: `acct-${next++ % ACCOUNTS}`, resource: "bandwidth", amount: 128 * MiB });
      const t = performance.now();
      const { verdicts } = await meterReport(deps, { batchId: hex(++batch), items });
      for (const v of verdicts) meterLease(v, policy, Date.now());
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const total = times.reduce((a, b) => a + b, 0) / 1000;
    console.log(
      `${name.padEnd(31)} | ${String(size).padStart(15)} | ${Math.round(times.length / total).toLocaleString().padStart(9)} | ${Math.round((times.length * size) / total).toLocaleString().padStart(14)} | ${pct(times, 0.5).toFixed(2).padStart(6)} | ${pct(times, 0.99).toFixed(2).padStart(6)}`,
    );
  }
}

const book = new LeaseBook({ initialGrant: 4 * MiB, unknownPolicy: "throttle" });
const N = 5_000_000;
const t = performance.now();
for (let i = 0; i < N; i++) {
  const a = `acct-${i % 1000}`;
  book.use(a, 16 * 1024, 0);
  book.action(a);
}
const ns = ((performance.now() - t) * 1e6) / N;
console.log(`\nedge hot path: ${Math.round(1e9 / ns).toLocaleString()} chunks/s on one core (${ns.toFixed(0)} ns per use + action)`);
process.exit(0);
