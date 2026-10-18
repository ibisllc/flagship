/**
 * Cron budget (Workers Free plan): one cron invocation may spend 10 ms of CPU
 * and make 50 subrequests (every D1 call counts). apps/com/src/cronPlan.ts
 * spreads the jobs over ticks so each invocation fits; this walks a week of
 * ticks, measures every distinct plan with the real handlers over the
 * production D1 adapter at 75 accounts (scripts/cronHarness.ts), and fails when
 * a plan
 *
 *   - needs more than SUBREQUEST_BUDGET subrequests (exact; 10 under the limit
 *     for the work a busier day adds), or
 *   - spends more JS CPU than its share of a calibration loop run in the same
 *     process (so a slow CI runner does not trip it).
 *
 * The jobs that did not fit at all (the D1 backup, the OpenRouter table refresh)
 * left the Worker: they are GitHub Actions now, and a test below keeps them out.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calibrationMs } from "../../../scripts/cpuHarness.js";
import { buildCronWorld, measureInvocation, FREE_SUBREQUEST_LIMIT } from "../../../scripts/cronHarness.js";
import { distinctPlans } from "../src/cronPlan.js";

const SUBREQUEST_BUDGET = FREE_SUBREQUEST_LIMIT - 10;
/**
 * JS CPU of one invocation (D1 calls priced at the harness's 0.45 ms each) as a
 * multiple of the calibration loop, which takes about 2.3 ms on a dev laptop: 2.2
 * is about 5 ms, so the first request of a young isolate (about 1.6x) still has
 * the 10 ms.
 */
const RATIO_BUDGET = 2.2;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

describe("cron budget (Workers Free plan)", () => {
  it("every distinct cron plan fits one invocation", async () => {
    const calib = await calibrationMs();
    const w = await buildCronWorld({ accounts: 75 });
    const over: string[] = [];
    try {
      for (const d of distinctPlans()) {
        const m = await measureInvocation(w, d.label, d.cron, d.time, 3);
        const ratio = m.jsMs / calib;
        if (m.subrequests > SUBREQUEST_BUDGET) over.push(`${d.label}: ${m.subrequests} subrequests, budget ${SUBREQUEST_BUDGET}`);
        if (ratio > RATIO_BUDGET) over.push(`${d.label}: ${ratio.toFixed(2)} x calibration (${m.jsMs.toFixed(1)} ms), budget ${RATIO_BUDGET}`);
      }
    } finally {
      w.close();
    }
    expect(over).toEqual([]);
  }, 180_000);

  it("the CT scan stays inside the budget however many users there are", async () => {
    const w = await buildCronWorld({ accounts: 400 });
    try {
      const d = distinctPlans().find((p) => p.plan.jobs.includes("ct-scan"))!;
      const m = await measureInvocation(w, d.label, d.cron, d.time, 3);
      expect(m.subrequests).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    } finally {
      w.close();
    }
  }, 120_000);

  it("wrangler.toml declares exactly the two crons the plan knows, and no backup binding", () => {
    const toml = readFileSync(join(repo, "apps/com/wrangler.toml"), "utf8");
    const crons = toml.match(/^crons\s*=\s*\[(.*)\]/m)?.[1] ?? "";
    expect(crons.split(",").map((c) => c.trim().replace(/"/g, "")).sort()).toEqual(["*/10 * * * *", "0 */6 * * *"]);
    expect(toml).not.toMatch(/^\s*binding\s*=\s*"BACKUPS_BUCKET"/m);
  });

  it("the Worker no longer carries the D1 backup or the capability refresh", () => {
    const src = readFileSync(join(repo, "apps/com/src/scheduled.ts"), "utf8");
    expect(src).not.toMatch(/runBackup|CompressionStream|runModelCapabilityRefresh/);
  });
});
