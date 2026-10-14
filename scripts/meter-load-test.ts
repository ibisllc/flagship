// Metering load test: how many relay usage reports, and counter rows, the
// `.com` side can take, and what the relay's hot path costs.
//
//   npx tsc -b && npx tsx scripts/meter-load-test.ts [--quick]
//
// Central: the real /api/usage/report handler (batch ids + leases) over
// (a) the in-memory store and (b) the production D1 adapter on node:sqlite
// with every migration applied (packages/storage/tests/support/sqliteD1.ts),
// with tier lookups in the same database. Real D1 adds a network hop and
// durable commits per batch, so the sqlite numbers are the CPU/SQL ceiling of
// our code, not D1's: billing/docs/scaling.md reads them that way.
// Edge: LeaseBook.use + action per buffer, the relay's per-chunk cost.
//
// Numbers and an account pool only; nothing here touches the network.

import { performance } from "node:perf_hooks";
import { LeaseBook } from "@ibisllc/billing-metering";
import {
  D1MeterStorage,
  D1TierStorage,
  InMemoryMeterStorage,
  InMemoryTierStorage,
  type D1Database,
  type D1PreparedStatement,
  type MeterStorage,
  type TierStorage,
} from "@flagship/storage";
import { handleUsageReport } from "@flagship/control-plane";
import { createSqliteD1 } from "../packages/storage/tests/support/sqliteD1.js";

const quick = process.argv.includes("--quick");
const SECRET = "load";
const ACCOUNTS = 10_000;
const names = Array.from({ length: ACCOUNTS }, (_, i) => `user${i}`);

function hex(n: number): string {
  return n.toString(16).padStart(32, "0");
}

interface CentralResult {
  store: string;
  wire: string;
  batchItems: number;
  /** D1 calls per report (each one a network round trip in prod). */
  d1CallsPerReport: number | "-";
  batches: number;
  batchesPerSec: number;
  rowsPerSec: number;
  p50Ms: number;
  p99Ms: number;
}

/** Counts D1 round trips: each batch() or standalone first/all/run. */
function counted(db: D1Database): { db: D1Database; calls: () => number } {
  let calls = 0;
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => ({
    bind: (...v) => wrap(st.bind(...v)),
    first: (...a) => (calls++, st.first(...a)),
    all: (...a) => (calls++, st.all(...a)),
    run: () => (calls++, st.run()),
    __inner: st,
  }) as D1PreparedStatement;
  return {
    db: {
      prepare: (q) => wrap(db.prepare(q)),
      batch: (stmts) => (calls++, db.batch(stmts.map((s) => (s as unknown as { __inner: D1PreparedStatement }).__inner))),
    },
    calls: () => calls,
  };
}

async function central(
  label: string,
  make: () => { meter: MeterStorage; tiers: TierStorage; calls?: () => number },
  batchItems: number,
  seconds: number,
  withIds: boolean,
): Promise<CentralResult> {
  const deps = make();
  const lat: number[] = [];
  let n = 0;
  const end = performance.now() + seconds * 1000;
  const start = performance.now();
  while (performance.now() < end) {
    const items = Array.from({ length: batchItems }, (_, i) => ({
      username: names[(n * batchItems + i) % ACCOUNTS]!,
      bytes: 1_000_000 + i,
    }));
    const t = performance.now();
    const res = await handleUsageReport(deps, SECRET, SECRET, withIds ? { batchId: hex(++n), items } : (++n, { items }));
    lat.push(performance.now() - t);
    if (res.status !== 200) throw new Error(`report failed: ${JSON.stringify(res.body)}`);
  }
  const elapsed = (performance.now() - start) / 1000;
  lat.sort((a, b) => a - b);
  return {
    store: label,
    wire: withIds ? "batchId" : "legacy",
    batchItems,
    d1CallsPerReport: deps.calls ? +(deps.calls() / n).toFixed(1) : "-",
    batches: n,
    batchesPerSec: Math.round(n / elapsed),
    rowsPerSec: Math.round((n * batchItems) / elapsed),
    p50Ms: +lat[Math.floor(lat.length * 0.5)]!.toFixed(3),
    p99Ms: +lat[Math.floor(lat.length * 0.99)]!.toFixed(3),
  };
}

function edge(seconds: number) {
  const book = new LeaseBook({ initialGrant: 32 * 2 ** 20, unknownPolicy: "throttle" });
  const lease = { action: "allow" as const, grant: 256 * 2 ** 20, policy: "throttle" as const, ttlMs: 600_000 };
  for (const a of names) book.use(a, 1, 0);
  for (let b = book.takeBatch(0, "all"); b; b = book.takeBatch(0, "all")) {
    book.settle(b, new Map(b.items.map((i) => [i.account, lease])), 0);
  }
  let ops = 0;
  const end = performance.now() + seconds * 1000;
  const start = performance.now();
  while (performance.now() < end) {
    for (let i = 0; i < 10_000; i++) {
      const a = names[(ops + i) % ACCOUNTS]!;
      book.use(a, 16_384, 1);
      if (book.action(a) !== "allow") book.settle(book.takeBatch(1, "all")!, new Map([[a, lease]]), 1);
    }
    ops += 10_000;
  }
  const elapsed = (performance.now() - start) / 1000;
  return { accounts: ACCOUNTS, chunkBytes: 16_384, opsPerSec: Math.round(ops / elapsed), nsPerOp: Math.round((elapsed * 1e9) / ops) };
}

const seconds = quick ? 0.5 : 3;
const sqlite = () => {
  const { db, calls } = counted(createSqliteD1());
  return { meter: new D1MeterStorage(db), tiers: new D1TierStorage(db), calls };
};
const memory = () => ({ meter: new InMemoryMeterStorage(), tiers: new InMemoryTierStorage() });

const results: CentralResult[] = [];
for (const items of [1, 50, 500]) {
  results.push(await central("in-memory", memory, items, seconds, true));
  results.push(await central("D1 adapter on node:sqlite", sqlite, items, seconds, true));
}
results.push(await central("D1 adapter on node:sqlite", sqlite, 500, seconds, false));

console.log(`node ${process.version}, ${ACCOUNTS} accounts, ${seconds}s per run\n`);
console.log("central: POST /api/usage/report (handler + store, no network)");
console.table(results);
console.log("edge: LeaseBook.use + action per 16 KiB chunk");
console.table([edge(seconds)]);
