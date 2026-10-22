import { describe, expect, it } from "vitest";
import { runCustomDomainVerify, scheduled, type ScheduledEnv } from "../src/scheduled.js";
import {
  CT_USERS_PER_TICK,
  SIX_HOURLY_CRON,
  TEN_MINUTE_CRON,
  cronPlan,
  distinctPlans,
  type CronJobId,
} from "../src/cronPlan.js";

const MONDAY = Date.UTC(2026, 9, 19);
const at = (h: number, m: number, day = 0) => MONDAY + day * 86_400_000 + (h * 60 + m) * 60_000;

describe("cronPlan — who runs when", () => {
  it("the six-hourly cron runs the cheap constant jobs, and no backup", () => {
    const { jobs } = cronPlan(SIX_HOURLY_CRON, at(6, 0));
    expect([...jobs].sort()).toEqual(["ca-lease-warning", "custom-domain-verify", "prune-late-logs", "prune-rate-limit-log"]);
  });

  it("an unknown cron string runs nothing", () => {
    expect(cronPlan("5 4 * * *", at(0, 0)).jobs).toEqual([]);
  });

  it("every ten-minute tick runs the demo poller; no tick runs more than one other group", () => {
    for (let t = MONDAY; t < MONDAY + 86_400_000; t += 600_000) {
      const { jobs } = cronPlan(TEN_MINUTE_CRON, t);
      expect(jobs.length).toBeGreaterThan(0);
      const heavy = jobs.filter((j) => j === "ct-scan" || j === "adapter-publish" || j === "adapter-insights");
      expect(heavy.length).toBeLessThanOrEqual(1);
      if (!(jobs.length === 1 && (jobs[0] === "adapter-publish" || jobs[0] === "adapter-insights" || jobs[0] === "relay-probe"))) expect(jobs).toContain("demo");
    }
  });

  it("each rotated job runs at least every 40 minutes over a day, and the daily/weekly ones once", () => {
    const counts = new Map<CronJobId, number>();
    for (let t = MONDAY; t < MONDAY + 86_400_000; t += 600_000) {
      for (const j of cronPlan(TEN_MINUTE_CRON, t).jobs) counts.set(j, (counts.get(j) ?? 0) + 1);
    }
    for (const j of ["repair-alerts", "quarantine-alerts", "suggestions", "eviction-gc", "dns-gc", "legacy-dns-sweep"] as const) {
      expect(counts.get(j), j).toBeGreaterThanOrEqual(35);
    }
    expect(counts.get("adapter-publish")).toBe(1);
    expect(counts.get("adapter-insights")).toBe(1); // 2026-10-19 is a Monday
    expect(counts.get("demo")).toBeGreaterThanOrEqual(140);
  });

  it("adapter publish is at 00:30 UTC daily; the insight only on Monday 01:30", () => {
    expect(cronPlan(TEN_MINUTE_CRON, at(0, 30)).jobs).toEqual(["adapter-publish"]);
    expect(cronPlan(TEN_MINUTE_CRON, at(1, 30, 0)).jobs).toEqual(["adapter-insights"]);
    expect(cronPlan(TEN_MINUTE_CRON, at(1, 30, 1)).jobs).not.toContain("adapter-insights");
  });

  it("the CT scan walks every user: consecutive windows tile the user list", () => {
    const starts: number[] = [];
    for (let t = MONDAY; t < MONDAY + 86_400_000; t += 600_000) {
      const w = cronPlan(TEN_MINUTE_CRON, t).ctWindow;
      if (w) starts.push(w.start);
    }
    expect(starts.length).toBeGreaterThan(60);
    for (let i = 1; i < starts.length; i++) {
      // a skipped tick (the daily publish) leaves a gap of one window, never an overlap
      expect((starts[i]! - starts[i - 1]!) % CT_USERS_PER_TICK).toBe(0);
      expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    }
  });

  it("distinctPlans lists every shape once", () => {
    const labels = distinctPlans(MONDAY).map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.length).toBeGreaterThanOrEqual(6);
  });
});

describe("scheduled() dispatch", () => {
  it("hands every planned job to waitUntil and swallows a failing one", async () => {
    const waits: Promise<unknown>[] = [];
    // no DB, no tokens: every job no-ops; the point is that nothing throws and all are scheduled
    await scheduled({ cron: TEN_MINUTE_CRON, scheduledTime: at(0, 0) }, {} as ScheduledEnv, { waitUntil: (p) => void waits.push(p) });
    expect(waits.length).toBe(cronPlan(TEN_MINUTE_CRON, at(0, 0)).jobs.length);
    await expect(Promise.all(waits)).resolves.toBeDefined();
  });

  it("an unknown cron schedules nothing", async () => {
    const waits: Promise<unknown>[] = [];
    await scheduled({ cron: "1 2 3 4 5", scheduledTime: 0 }, {} as ScheduledEnv, { waitUntil: (p) => void waits.push(p) });
    expect(waits).toEqual([]);
  });
});

describe("runCustomDomainVerify — env guard (#79B Phase 4 C)", () => {
  it("no-ops (no throw) when DB / SERVICES_BASE_URL / secret are absent", async () => {
    await expect(runCustomDomainVerify({}, new Date(0))).resolves.toBeUndefined();
    await expect(
      runCustomDomainVerify({ SERVICES_BASE_URL: "https://x" } as ScheduledEnv, new Date(0)),
    ).resolves.toBeUndefined();
    await expect(
      runCustomDomainVerify(
        { SERVICES_BASE_URL: "https://x", SERVICES_CONTROL_SECRET: "s" } as ScheduledEnv,
        new Date(0),
      ),
    ).resolves.toBeUndefined(); // still skipped: no DB binding
  });
});
