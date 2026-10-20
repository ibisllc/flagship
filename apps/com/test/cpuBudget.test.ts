/**
 * Workers CPU budget (Free plan): docs/runbooks/final-deploy.md "Workers CPU
 * budget (Free plan)". `.com` runs on the Free plan, where a request may spend
 * 10 ms of CPU and a D1 binding call costs about half a millisecond of it. This
 * runs the real route handlers over the production D1 adapter
 * (scripts/cpuHarness.ts) and fails when a hot route
 *
 *   - makes more D1 round trips than its budget (exact and machine-independent:
 *     a new sequential read shows up here first), or
 *   - spends more JavaScript CPU than its budget, measured as a multiple of a
 *     calibration loop run in the same process so a slow machine does not trip
 *     it (the figure that moves when someone puts a signature check, a big
 *     JSON pass or a rebuild back on the request path).
 *
 * To add a route, add a scenario to scripts/cpuHarness.ts and a line below.
 */
import { describe, expect, it } from "vitest";
import { SCENARIOS, calibrationMs, measureScenario } from "../../../scripts/cpuHarness.js";

interface Budget {
  /** D1 round trips (a batch() counts once). */
  d1: number;
  /** JS-only CPU as a multiple of the calibration loop. */
  ratio: number;
}

const DEFAULT_RATIO = 0.3;

// Measured at the time of writing: d1 equals today's count; ratio is about four
// times today's smallest steady figure.
const BUDGETS: Record<string, Budget> = {
  directory: { d1: 4, ratio: DEFAULT_RATIO },
  "directory-member": { d1: 4, ratio: DEFAULT_RATIO },
  profile: { d1: 4, ratio: DEFAULT_RATIO },
  "device-grants": { d1: 2, ratio: DEFAULT_RATIO },
  "read-token-device": { d1: 2, ratio: DEFAULT_RATIO },
  "read-token-irk": { d1: 2, ratio: DEFAULT_RATIO },
  "read-token-box": { d1: 3, ratio: DEFAULT_RATIO },
  pods: { d1: 3, ratio: DEFAULT_RATIO },
  "stream-first": { d1: 3, ratio: DEFAULT_RATIO },
  "stream-stale": { d1: 4, ratio: DEFAULT_RATIO },
  // gate + the first check + four re-checks + the full answer (2 round trips)
  "stream-hold": { d1: 8, ratio: 0.4 },
  audit: { d1: 2, ratio: DEFAULT_RATIO },
  "account-resolve": { d1: 3, ratio: DEFAULT_RATIO },
  "users-check": { d1: 2, ratio: DEFAULT_RATIO },
  "username-lookup": { d1: 1, ratio: DEFAULT_RATIO },
  "edge-health": { d1: 0, ratio: DEFAULT_RATIO },
  "lane-swk-deposit": { d1: 3, ratio: DEFAULT_RATIO },
  "lane-cgk-deposit": { d1: 3, ratio: DEFAULT_RATIO },
  "lane-pairing-deposit": { d1: 3, ratio: DEFAULT_RATIO },
  "lane-update": { d1: 3, ratio: DEFAULT_RATIO },
  "lane-self-delete": { d1: 2, ratio: DEFAULT_RATIO },
  "lane-decommission": { d1: 0, ratio: DEFAULT_RATIO },
  "lane-migration-assignment": { d1: 2, ratio: DEFAULT_RATIO },
  "lane-transfer-rehome": { d1: 1, ratio: DEFAULT_RATIO },
  "apps-aliases": { d1: 2, ratio: DEFAULT_RATIO },
  notices: { d1: 0, ratio: DEFAULT_RATIO },
  "order-status": { d1: 5, ratio: DEFAULT_RATIO },
  "order-health": { d1: 3, ratio: DEFAULT_RATIO },
  "edge-account-resolve": { d1: 3, ratio: DEFAULT_RATIO },
  "ratelimit-counter": { d1: 0, ratio: DEFAULT_RATIO },
  // reads, then writes the beat, then reads the order and the doorbell together
  "daemon-status": { d1: 5, ratio: DEFAULT_RATIO },
  "edge-pods": { d1: 3, ratio: DEFAULT_RATIO },
  "edge-directory": { d1: 4, ratio: DEFAULT_RATIO },
  // session, then the eviction row it joins live
  "migration-read": { d1: 2, ratio: DEFAULT_RATIO },
  // the new box's registration, the account's sessions, then the eviction row
  "migration-assignment-live": { d1: 3, ratio: DEFAULT_RATIO },
};

describe("Workers CPU budget (Free plan)", () => {
  it("every harness scenario has a budget", () => {
    expect(SCENARIOS.map((s) => s.id).filter((id) => !BUDGETS[id])).toEqual([]);
    expect(Object.keys(BUDGETS).filter((id) => !SCENARIOS.some((s) => s.id === id))).toEqual([]);
  });

  it("stays within the D1 round-trip and CPU budgets", async () => {
    const calib = await calibrationMs();
    const over: string[] = [];
    for (const sc of SCENARIOS) {
      const budget = BUDGETS[sc.id];
      if (!budget) continue;
      const m = await measureScenario(sc, { warmup: 8, runs: 30 });
      const ratio = m.minJsNoDbMs / calib;
      if (m.d1Calls > budget.d1) over.push(`${sc.id}: ${m.d1Calls} D1 round trips, budget ${budget.d1}`);
      if (ratio > budget.ratio) {
        over.push(`${sc.id}: JS CPU ${ratio.toFixed(2)} x calibration (${m.minJsNoDbMs.toFixed(2)} ms), budget ${budget.ratio}`);
      }
    }
    expect(over).toEqual([]);
  }, 120_000);
});
