/**
 * Which cron jobs run at which tick. Pure: (cron string, scheduled time) in,
 * job list out, so a test can walk a whole week of ticks and measure each
 * distinct plan against the Workers Free limits (10 ms CPU and 50 subrequests
 * for ONE invocation: every `waitUntil` job of a tick shares them).
 *
 * Two crons exist in wrangler.toml (a Free account has 5 cron triggers in all,
 * and the gym Worker uses two):
 *
 *   `0 *\/6 * * *`  every six hours: custom-domain verification, the CA lease
 *                  warning, log pruning. Cheap and constant.
 *   `*\/10 * * * *` every ten minutes: the demo poller every tick, plus ONE
 *                  more thing, rotated:
 *                    even ticks      a window of the CT scan (CT_USERS_PER_TICK
 *                                    users, so every user in turn)
 *                    odd ticks       one of two small groups, each every 40 minutes
 *                    00:30 UTC       the daily adapter publish (alone)
 *                    Monday 01:30    the weekly adapter insight (alone)
 *
 * Cadence changes against the single big invocation this replaced: the CT scan
 * visits each user every (users / CT_USERS_PER_TICK) x 20 minutes (about 6 hours
 * at 75 accounts, as before); the re-pair and quarantine ladders, the
 * suggestion queue refill (two candidate names a time), the eviction GC and
 * the stale ACME TXT sweep run every 40 minutes instead of every ten (their thresholds are hours or days; the
 * TXT sweep only removes records older than an hour).
 */

export type CronJobId =
  | "custom-domain-verify"
  | "ca-lease-warning"
  | "prune-rate-limit-log"
  | "prune-late-logs"
  | "demo"
  | "ct-scan"
  | "repair-alerts"
  | "quarantine-alerts"
  | "suggestions"
  | "eviction-gc"
  | "dns-gc"
  | "legacy-dns-sweep"
  | "adapter-publish"
  | "adapter-insights";

export interface CronPlan {
  jobs: CronJobId[];
  /** For "ct-scan": the window of users this tick scans. */
  ctWindow?: { start: number; count: number };
}

export const SIX_HOURLY_CRON = "0 */6 * * *";
export const TEN_MINUTE_CRON = "*/10 * * * *";

/** Users the CT scan queries per tick: 2 crt.sh queries and a few D1 reads each. */
export const CT_USERS_PER_TICK = 4;
/** Candidate names the suggestion queue tries per tick (2 subrequests each). */
export const SUGGESTION_ATTEMPTS_PER_TICK = 2;

const TEN_MIN_MS = 10 * 60_000;

const MINOR_GROUPS: CronJobId[][] = [
  ["repair-alerts", "quarantine-alerts", "dns-gc", "legacy-dns-sweep"],
  ["suggestions", "eviction-gc"],
];

export function cronPlan(cron: string, scheduledTime: number): CronPlan {
  if (cron === SIX_HOURLY_CRON) {
    return { jobs: ["custom-domain-verify", "ca-lease-warning", "prune-rate-limit-log", "prune-late-logs"] };
  }
  if (cron === TEN_MINUTE_CRON) {
    const d = new Date(scheduledTime);
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    if (hour === 0 && minute >= 30 && minute < 40) return { jobs: ["adapter-publish"] };
    if (hour === 1 && minute >= 30 && minute < 40 && d.getUTCDay() === 1) return { jobs: ["adapter-insights"] };
    const tick = Math.floor(scheduledTime / TEN_MIN_MS);
    const pair = Math.floor(tick / 2);
    if (tick % 2 === 0) {
      return { jobs: ["demo", "ct-scan"], ctWindow: { start: pair * CT_USERS_PER_TICK, count: CT_USERS_PER_TICK } };
    }
    return { jobs: ["demo", ...MINOR_GROUPS[pair % MINOR_GROUPS.length]!] };
  }
  // Unknown cron string: do nothing rather than mis-dispatch (a cron cannot be
  // added without a deploy).
  return { jobs: [] };
}

/** Every distinct plan over a week of ticks, for the budget test. */
export function distinctPlans(week = Date.UTC(2026, 9, 19)): { label: string; cron: string; time: number; plan: CronPlan }[] {
  const seen = new Map<string, { label: string; cron: string; time: number; plan: CronPlan }>();
  for (const cron of [SIX_HOURLY_CRON, TEN_MINUTE_CRON]) {
    const step = cron === SIX_HOURLY_CRON ? 6 * 3_600_000 : TEN_MIN_MS;
    for (let t = week; t < week + 7 * 86_400_000; t += step) {
      const plan = cronPlan(cron, t);
      const key = `${cron}|${plan.jobs.join(",")}`;
      if (!seen.has(key)) seen.set(key, { label: `${cron} -> ${plan.jobs.join("+")}`, cron, time: t, plan });
    }
  }
  return [...seen.values()];
}
