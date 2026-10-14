// The MeterStore conformance suite: every behaviour the metering core relies
// on, as plain async cases that throw on failure. Any test runner drives it:
//
//   import { meterStoreConformance } from "@ibisllc/billing-metering/conformance";
//   for (const c of meterStoreConformance({ make: () => new MyStore() })) {
//     it(c.name, c.run);           // vitest, jest, node:test, mocha …
//   }
//
// `make` must return a store with NO counters and NO batch ids recorded
// (a fresh database, or fresh tables). Every adapter in this repository runs
// it; a third-party adapter that passes it can stand in for any of them.

import type { MeterBatchEntry, MeterStore } from "./store.js";

export interface MeterStoreConformanceOptions {
  /** A store with nothing recorded. Called once per case. */
  make: () => MeterStore | Promise<MeterStore>;
  /** Run the `addBatch` cases. Default: true. Pass false only for a store
   *  that deliberately omits `addBatch` (then batches with ids can't be
   *  reported to it). */
  batches?: boolean;
  /** How many concurrent writers the concurrency cases use. Default 20. */
  concurrency?: number;
}

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

class ConformanceError extends Error {
  override name = "ConformanceError";
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new ConformanceError(`${what}: expected ${e}, got ${a}`);
}

const P = "2026-10";
const R = "bandwidth";
const e = (account: string, amount: number, resource = R, period = P): MeterBatchEntry => ({
  account,
  resource,
  period,
  amount,
});
const id = (n: number) => `batch-${String(n).padStart(16, "0")}`;

/** The cases. `run` resolves on success and rejects with a message naming
 *  the expectation on failure. */
export function meterStoreConformance(opts: MeterStoreConformanceOptions): ConformanceCase[] {
  const n = opts.concurrency ?? 20;
  const make = async () => opts.make();
  const batching = async () => {
    const s = await make();
    if (!s.addBatch) throw new ConformanceError("store has no addBatch (pass batches: false to skip these cases)");
    return s as MeterStore & Required<Pick<MeterStore, "addBatch">>;
  };

  const cases: ConformanceCase[] = [
    {
      name: "add creates the counter at the delta and returns the running total",
      run: async () => {
        const s = await make();
        eq(await s.add("ann", R, P, 100, 1), 100, "first add");
        eq(await s.add("ann", R, P, 50, 2), 150, "second add");
        eq(await s.get("ann", R, P), { account: "ann", resource: R, period: P, amount: 150, updatedAt: 2 }, "get");
      },
    },
    {
      name: "get of an absent counter is undefined",
      run: async () => {
        eq(await (await make()).get("nobody", R, P), undefined, "get");
      },
    },
    {
      name: "keeps account, resource and period apart",
      run: async () => {
        const s = await make();
        await s.add("ann", R, P, 10, 1);
        await s.add("ann", "tokens", P, 20, 1);
        await s.add("ann", R, "2026-11", 30, 1);
        await s.add("bo", R, P, 40, 1);
        eq((await s.get("ann", R, P))?.amount, 10, "ann/bandwidth/2026-10");
        eq((await s.get("ann", "tokens", P))?.amount, 20, "ann/tokens/2026-10");
        eq((await s.get("ann", R, "2026-11"))?.amount, 30, "ann/bandwidth/2026-11");
        eq((await s.get("bo", R, P))?.amount, 40, "bo/bandwidth/2026-10");
      },
    },
    {
      name: "an id containing separators can't collide with another key",
      run: async () => {
        const s = await make();
        await s.add("a|b", "c", "d", 1, 1);
        await s.add("a:b", "c", "d", 2, 1);
        eq(await s.get("a", "b|c", "d"), undefined, "a / b|c / d");
        eq(await s.get("a", "b:c", "d"), undefined, "a / b:c / d");
        eq((await s.get("a|b", "c", "d"))?.amount, 1, "a|b / c / d");
      },
    },
    {
      name: "keeps any account id byte for byte (case, Unicode, quotes)",
      run: async () => {
        const s = await make();
        const ids = ["Ann", "ann", "zoë", "ünïcødé-✓", "o'brien", 'say "hi"', "a;DROP TABLE x", "  spaced  "];
        for (const [i, a] of ids.entries()) await s.add(a, R, P, i + 1, 1);
        for (const [i, a] of ids.entries()) eq(await s.get(a, R, P), { account: a, resource: R, period: P, amount: i + 1, updatedAt: 1 }, `get ${a}`);
      },
    },
    {
      name: "floors fractions and never lets a negative delta decrement",
      run: async () => {
        const s = await make();
        eq(await s.add("ann", R, P, 10.9, 1), 10, "fraction");
        eq(await s.add("ann", R, P, -5, 2), 10, "negative");
        eq(await s.add("ann", R, P, 0, 3), 10, "zero");
      },
    },
    {
      name: "a zero add creates the counter at 0",
      run: async () => {
        const s = await make();
        eq(await s.add("ann", R, P, 0, 7), 0, "add 0");
        eq(await s.get("ann", R, P), { account: "ann", resource: R, period: P, amount: 0, updatedAt: 7 }, "get");
      },
    },
    {
      name: "holds amounts past 32 bits as plain numbers",
      run: async () => {
        const s = await make();
        const big = 300 * 1024 ** 3;
        eq(await s.add("ann", R, P, big, 1), big, "add");
        eq(await s.add("ann", R, P, big, 2), 2 * big, "add again");
        const g = await s.get("ann", R, P);
        eq(typeof g?.amount, "number", "amount type");
        eq(typeof g?.updatedAt, "number", "updatedAt type");
        eq(g?.amount, 2 * big, "get");
        const t = Date.UTC(2026, 9, 14, 12);
        await s.add("bo", R, P, 1, t);
        eq((await s.get("bo", R, P))?.updatedAt, t, "a millisecond timestamp");
      },
    },
    {
      name: "concurrent adds to one counter all count",
      run: async () => {
        const s = await make();
        const totals = await Promise.all(Array.from({ length: n }, (_, i) => s.add("ann", R, P, 1, i + 1)));
        eq((await s.get("ann", R, P))?.amount, n, "final total");
        eq([...totals].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i + 1), "each add saw a distinct total");
      },
    },
  ];

  if (opts.batches === false) return cases;

  cases.push(
    {
      name: "addBatch adds every entry once and returns the new totals in entry order",
      run: async () => {
        const s = await batching();
        await s.add("ann", R, P, 5, 1);
        eq(await s.addBatch(id(1), [e("ann", 10), e("bo", 3), e("ann", 1, "tokens")], 2, 100), { duplicate: false, totals: [15, 3, 1] }, "addBatch");
        eq(await s.get("bo", R, P), { account: "bo", resource: R, period: P, amount: 3, updatedAt: 2 }, "get bo");
        eq((await s.get("ann", "tokens", P))?.amount, 1, "get ann/tokens");
      },
    },
    {
      name: "addBatch: a retried batch id changes nothing",
      run: async () => {
        const s = await batching();
        await s.addBatch(id(1), [e("ann", 10)], 1, 100);
        eq(await s.addBatch(id(1), [e("ann", 10), e("bo", 4)], 2, 100), { duplicate: true }, "retry");
        eq((await s.get("ann", R, P))?.amount, 10, "ann unchanged");
        eq(await s.get("bo", R, P), undefined, "bo never created");
        eq(await s.addBatch(id(2), [e("ann", 1)], 3, 100), { duplicate: false, totals: [11] }, "next id");
      },
    },
    {
      name: "addBatch: an id is remembered until keepUntil, then counts again",
      run: async () => {
        const s = await batching();
        await s.addBatch(id(1), [e("ann", 10)], 1, 50);
        eq(await s.addBatch(id(1), [e("ann", 10)], 50, 200), { duplicate: true }, "at keepUntil");
        eq(await s.addBatch(id(1), [e("ann", 10)], 51, 200), { duplicate: false, totals: [20] }, "after keepUntil");
        eq(await s.addBatch(id(1), [e("ann", 10)], 52, 300), { duplicate: true }, "re-claimed with the new keepUntil");
      },
    },
    {
      name: "addBatch: expiry works for an id among many expired ones",
      run: async () => {
        const s = await batching();
        for (let i = 1; i <= 40; i++) await s.addBatch(id(i), [], i, 100);
        eq(await s.addBatch(id(40), [e("ann", 1)], 1_000, 2_000), { duplicate: false, totals: [1] }, "expired id 40");
        eq(await s.addBatch(id(1), [e("ann", 1)], 1_001, 2_000), { duplicate: false, totals: [2] }, "expired id 1");
        eq(await s.addBatch(id(41), [e("ann", 1)], 1_002, 2_000), { duplicate: false, totals: [3] }, "new id");
      },
    },
    {
      name: "addBatch: an empty batch still claims its id",
      run: async () => {
        const s = await batching();
        eq(await s.addBatch(id(1), [], 1, 100), { duplicate: false, totals: [] }, "first");
        eq(await s.addBatch(id(1), [], 2, 100), { duplicate: true }, "retry");
      },
    },
    {
      name: "addBatch: repeated keys in one batch give running totals",
      run: async () => {
        const s = await batching();
        await s.add("ann", R, P, 100, 1);
        eq(await s.addBatch(id(1), [e("ann", 1), e("bo", 5), e("ann", 2), e("ann", 4)], 2, 100), { duplicate: false, totals: [101, 5, 103, 107] }, "addBatch");
        eq((await s.get("ann", R, P))?.amount, 107, "final");
      },
    },
    {
      name: "addBatch: floors fractions and ignores negative entries like add",
      run: async () => {
        const s = await batching();
        eq(await s.addBatch(id(1), [e("ann", 2.7), e("bo", -3)], 1, 100), { duplicate: false, totals: [2, 0] }, "addBatch");
      },
    },
    {
      name: "addBatch: concurrent sends of one batch id count it exactly once",
      run: async () => {
        const s = await batching();
        const rs = await Promise.all(Array.from({ length: n }, (_, i) => s.addBatch(id(7), [e("ann", 10), e("bo", 1)], i + 1, 10_000)));
        eq(rs.filter((r) => !r.duplicate).length, 1, "non-duplicate answers");
        eq((await s.get("ann", R, P))?.amount, 10, "ann");
        eq((await s.get("bo", R, P))?.amount, 1, "bo");
      },
    },
    {
      name: "addBatch: concurrent distinct batches on shared counters all count",
      run: async () => {
        const s = await batching();
        await Promise.all(Array.from({ length: n }, (_, i) => s.addBatch(id(100 + i), [e("ann", 1), e(`acct-${i}`, 1)], i + 1, 10_000)));
        eq((await s.get("ann", R, P))?.amount, n, "shared counter");
        eq((await s.get(`acct-${n - 1}`, R, P))?.amount, 1, "own counter");
      },
    },
    {
      name: "addBatch: a 500-entry batch is counted",
      run: async () => {
        const s = await batching();
        const entries = Array.from({ length: 500 }, (_, i) => e(`acct-${i}`, i));
        const r = await s.addBatch(id(1), entries, 1, 100);
        eq(r.duplicate ? undefined : r.totals, entries.map((x) => x.amount), "totals");
        eq((await s.get("acct-499", R, P))?.amount, 499, "last counter");
      },
    },
  );
  return cases;
}
