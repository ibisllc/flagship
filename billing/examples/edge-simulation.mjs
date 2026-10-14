// Three edges (proxies, relays, model servers …) meter one resource for the
// same accounts and report to one central counter. Everything runs in this
// process on a simulated clock, so the run is fast and repeatable:
//
//   npm run build && node examples/edge-simulation.mjs
//
// It prints, per account, what was served at full speed against what the plan
// allows, how far the edges together overshot the allowance before the
// throttle reached them, and how many reports they sent.

import { InMemoryMeterStore, LeaseBook } from "@ibisllc/billing-metering";
import { bearerAuth, createReportHandler, sendBatch } from "@ibisllc/billing-metering/http";

const MiB = 1024 * 1024;
const SECRET = "edge-secret";

// ── Central ─────────────────────────────────────────────────────────────
// The catalog is yours: resource names, plans, allowances and policies.
const catalog = {
  bandwidth: {
    unit: "bytes",
    period: "month",
    plans: {
      free: { allowance: 200 * MiB, over: "throttle" },
      team: { allowance: 2048 * MiB, over: "allow" },
    },
  },
};
const plans = new Map([["acme", "team"]]); // everyone else is on "free"
let clock = Date.UTC(2026, 9, 14, 9);
const store = new InMemoryMeterStore();
const central = createReportHandler({
  deps: { catalog, store, planOf: async (a) => plans.get(a) ?? "free", now: () => clock },
  lease: { fraction: 0.25, minGrant: 1 * MiB, maxGrant: 64 * MiB, ttlMs: 10 * 60_000, overTtlMs: 60_000 },
  authorize: bearerAuth(SECRET),
});
let reports = 0;
const fetchCentral = async (url, init) => {
  reports++;
  return central(new Request(url, init));
};

// ── Edges ───────────────────────────────────────────────────────────────
const edges = Array.from({ length: 3 }, () => new LeaseBook({ initialGrant: 4 * MiB, unknownPolicy: "throttle" }));
const send = (book, batch) =>
  sendBatch(book, batch, {
    url: "https://central.example/usage/report",
    resource: "bandwidth",
    headers: { authorization: `Bearer ${SECRET}` },
    fetch: fetchCentral,
    now: () => clock,
  });

// A seeded RNG, so every run prints the same numbers.
let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);

const accounts = ["ann", "bo", "acme", "dee"];
const demand = { ann: 0.02 * MiB, bo: 0.002 * MiB, acme: 0.1 * MiB, dee: 0.05 * MiB }; // per edge per tick, on average
const served = Object.fromEntries(accounts.map((a) => [a, 0]));
const fullSpeed = Object.fromEntries(accounts.map((a) => [a, 0]));
const throttledTicks = Object.fromEntries(accounts.map((a) => [a, 0]));

// 20 simulated minutes in 100 ms ticks. A throttled account is served at a
// trickle (here 1/64 of its demand); a stopped one would get nothing.
for (let tick = 0; tick < 12_000; tick++) {
  clock += 100;
  for (const book of edges) {
    for (const a of accounts) {
      const want = Math.round(demand[a] * 2 * rand());
      const action = book.action(a);
      const bytes = action === "allow" ? want : action === "throttle" ? Math.round(want / 64) : 0;
      if (action !== "allow") throttledTicks[a]++;
      else fullSpeed[a] += bytes;
      if (bytes > 0) {
        served[a] += bytes;
        book.use(a, bytes, clock);
      }
    }
    // Due accounts every 500 ms, everyone every 60 s.
    const mode = tick % 600 === 0 ? "all" : tick % 5 === 0 ? "due" : undefined;
    if (mode === "all" || (mode === "due" && book.hasDue(clock))) {
      const batch = book.takeBatch(clock, mode);
      if (batch) await send(book, batch);
    }
  }
}
for (const book of edges) {
  const batch = book.takeBatch(clock, "all");
  if (batch) await send(book, batch);
}

// ── Results ─────────────────────────────────────────────────────────────
const period = "2026-10";
console.log("account  plan  allowance  full speed  overshoot   throttled");
for (const a of accounts) {
  const plan = plans.get(a) ?? "free";
  const { allowance, over: policy } = catalog.bandwidth.plans[plan];
  const counted = (await store.get(a, "bandwidth", period))?.amount ?? 0;
  const overshoot = Math.max(0, fullSpeed[a] - allowance);
  console.log(
    [
      a.padEnd(8),
      plan.padEnd(5),
      `${(allowance / MiB).toFixed(0)} MiB`.padStart(9),
      `${(fullSpeed[a] / MiB).toFixed(1)} MiB`.padStart(11),
      policy === "allow" ? "(billed)".padStart(10) : `${(overshoot / MiB).toFixed(1)} MiB`.padStart(10),
      `${((throttledTicks[a] / (12_000 * edges.length)) * 100).toFixed(0)}% of the time`.padStart(17),
    ].join(" "),
  );
  if (counted !== served[a]) throw new Error(`${a}: served ${served[a]} but central counted ${counted}`);
}
console.log(`\n${reports} reports from ${edges.length} edges over 20 minutes; every byte served was counted once.`);
