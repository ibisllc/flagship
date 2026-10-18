// Prints what each `.com` cron invocation costs against the Workers Free
// limits. `npx tsx scripts/cron-profile.ts [--accounts 75]`.
import { buildCronWorld, measure, measureInvocation, FREE_CRON_CPU_MS, FREE_SUBREQUEST_LIMIT } from "./cronHarness.js";
import * as sched from "../apps/com/src/scheduled.js";
import { pruneRateLimitLog } from "../apps/com/src/rateLimitLog.js";
import { runAdapterPublish } from "../apps/com/src/adapterPublish.js";
import { runAdapterInsights } from "../apps/com/src/adapterInsights.js";

const argv = process.argv.slice(2);
const accounts = Number(argv[argv.indexOf("--accounts") + 1]) || 75;
const w = await buildCronWorld({ accounts });
const day = Date.UTC(2026, 9, 19, 0, 0, 0); // a Monday, 00:00 UTC
const at = (h: number, m = 0) => new Date(day + (h * 60 + m) * 60_000);
const rows = [] as Awaited<ReturnType<typeof measure>>[];
const job = async (label: string, fn: () => Promise<unknown>) => {
  await fn().catch(() => undefined);
  let best;
  for (let i = 0; i < 4; i++) {
    const m = await measure(w, label, () => fn().catch((e) => console.error(label, (e as Error).message)));
    if (!best || m.jsMs < best.jsMs) best = m;
  }
  rows.push(best!);
};
const now = at(0);
await job("customDomainVerify", () => sched.runCustomDomainVerify(w.env, now));
await job("ctMonitor (all users)", () => sched.runCtMonitor(w.env, now));
await job("ctMonitor (4-user window)", () => sched.runCtMonitor(w.env, now, { start: 8, count: 4 }));
await job("suggestions (cold queue)", () => sched.runSuggestionQueueCron(w.env, now));
await job("evictionGc", () => sched.runEvictionGcCron(w.env, now));
await job("caLeaseWarning", () => sched.runCaLeaseWarning(w.env, now));
await job("pruneRateLimitLog", () => pruneRateLimitLog(w.env.DB!, now));
await job("adapterPublish (idle)", () => runAdapterPublish(w.env as never, now));
await job("adapterInsights", () => runAdapterInsights(w.env as never, now));
await job("demoCron", () => sched.runDemoCron(w.env, now));
await job("rePairAlerts", () => sched.runRePairAlertsCron(w.env, now));
await job("quarantineAlerts", () => sched.runQuarantineAlertsCron(w.env, now));
await job("dnsChallengeGc", () => sched.runDnsChallengeGcCron(w.env, now));
import { distinctPlans } from "../apps/com/src/cronPlan.js";
const inv: Awaited<ReturnType<typeof measure>>[] = [];
for (const d of distinctPlans()) inv.push(await measureInvocation(w, d.label, d.cron, d.time));
const p = (m: (typeof rows)[number]) =>
  console.log(`${m.label.padEnd(46)} d1 ${String(m.d1).padStart(4)}  fetch ${String(m.fetches).padStart(4)}  subreq ${String(m.subrequests).padStart(4)}  js ${m.jsMs.toFixed(1).padStart(6)} ms`);
console.log(`accounts=${accounts}  limits: ${FREE_SUBREQUEST_LIMIT} subrequests, ${FREE_CRON_CPU_MS} ms CPU`);
rows.forEach(p);
console.log("--");
inv.forEach(p);
w.close();
