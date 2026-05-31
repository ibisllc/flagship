/**
 * B4 — RepairScheduler is the production caller for RepairDaemon.
 *
 * Coverage:
 *   - no-daemon case: start() is a no-op, snapshot stays idle/zero.
 *   - daemon wired + start(): the injected setInterval is armed; each
 *     tick drives accumulator.wrapTick → daemon.repairOnce.
 *   - stop() cancels the interval.
 *   - late-bind via setDaemon() — start() before setDaemon is a no-op;
 *     setDaemon + a second start() arms the interval.
 *   - tickOnce() forces a single tick without waiting for the interval.
 *   - errors thrown by repairOnce flow through accumulator.failTick and
 *     surface in the accumulator's snapshot as state:"error".
 */

import { describe, expect, it } from "vitest";
import type { RepairDaemon, RepairResult } from "../src/peerBackup/repairDaemon.js";
import { RepairScheduler } from "../src/peerBackup/repairScheduler.js";
import { RepairStatsAccumulator } from "../src/peerBackup/repairStatsAccumulator.js";

function fakeDaemon(impl: () => Promise<RepairResult>): RepairDaemon {
  // Reach past the constructor by casting — we only need the
  // repairOnce method on the test path.
  return { repairOnce: impl } as unknown as RepairDaemon;
}

function fakeTimers() {
  let cb: (() => void) | null = null;
  let cleared = false;
  const setI = ((fn: () => void) => {
    cb = fn;
    return { __id: 1 } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const clearI = ((_h: ReturnType<typeof setInterval>) => {
    cleared = true;
    cb = null;
  }) as unknown as typeof clearInterval;
  return {
    setI,
    clearI,
    armed: () => cb !== null,
    cleared: () => cleared,
    fire: async () => {
      if (cb) cb();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("RepairScheduler", () => {
  it("no daemon wired → start() is a no-op + snapshot stays idle/zero", async () => {
    let now = 1_000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    const t = fakeTimers();
    const sched = new RepairScheduler({
      accumulator: acc, daemon: null,
      setInterval: t.setI, clearInterval: t.clearI,
    });
    sched.start();
    expect(t.armed()).toBe(false);
    expect(sched.isRunning()).toBe(false);
    expect(acc.snapshot()).toEqual({
      state: "idle", lastTickMs: null, queued: 0, completed24h: 0,
    });
  });

  it("daemon wired + start() arms the interval; each tick drives repairOnce → accumulator", async () => {
    let now = 1_000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    let calls = 0;
    const daemon = fakeDaemon(async () => {
      calls += 1;
      return { attempted: 5, replaced: 3, proactivelyBoosted: 1, criticalAlerts: 0 };
    });
    const t = fakeTimers();
    const sched = new RepairScheduler({
      accumulator: acc, daemon,
      setInterval: t.setI, clearInterval: t.clearI,
    });
    sched.start();
    expect(t.armed()).toBe(true);
    expect(sched.isRunning()).toBe(true);

    now = 2_000;
    await t.fire();
    expect(calls).toBe(1);
    expect(acc.snapshot()).toMatchObject({
      state: "idle", lastTickMs: 2_000, queued: 0, completed24h: 3,
    });

    now = 3_000;
    await t.fire();
    expect(calls).toBe(2);
    expect(acc.snapshot()).toMatchObject({
      state: "idle", lastTickMs: 3_000, completed24h: 6,
    });
  });

  it("stop() cancels the interval", async () => {
    const acc = new RepairStatsAccumulator();
    const daemon = fakeDaemon(async () =>
      ({ attempted: 0, replaced: 0, proactivelyBoosted: 0, criticalAlerts: 0 }));
    const t = fakeTimers();
    const sched = new RepairScheduler({
      accumulator: acc, daemon,
      setInterval: t.setI, clearInterval: t.clearI,
    });
    sched.start();
    expect(sched.isRunning()).toBe(true);
    sched.stop();
    expect(sched.isRunning()).toBe(false);
    expect(t.cleared()).toBe(true);
    // Subsequent stop() is idempotent.
    sched.stop();
  });

  it("late-bind via setDaemon — start() before bind is a no-op; setDaemon + start arms", async () => {
    let now = 1_000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    let calls = 0;
    const daemon = fakeDaemon(async () => {
      calls += 1;
      return { attempted: 1, replaced: 1, proactivelyBoosted: 0, criticalAlerts: 0 };
    });
    const t = fakeTimers();
    const sched = new RepairScheduler({
      accumulator: acc, daemon: null,
      setInterval: t.setI, clearInterval: t.clearI,
    });
    sched.start();
    expect(t.armed()).toBe(false);

    sched.setDaemon(daemon);
    sched.start();
    expect(t.armed()).toBe(true);

    now = 2_500;
    await t.fire();
    expect(calls).toBe(1);
    expect(acc.snapshot().lastTickMs).toBe(2_500);
  });

  it("tickOnce() forces a tick without waiting for the interval", async () => {
    let now = 1_000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    let calls = 0;
    const daemon = fakeDaemon(async () => {
      calls += 1;
      return { attempted: 1, replaced: 1, proactivelyBoosted: 0, criticalAlerts: 0 };
    });
    const sched = new RepairScheduler({ accumulator: acc, daemon });
    now = 4_000;
    const r = await sched.tickOnce();
    expect(r?.replaced).toBe(1);
    expect(calls).toBe(1);
    expect(acc.snapshot().completed24h).toBe(1);
  });

  it("tickOnce() with no daemon returns null without crashing", async () => {
    const acc = new RepairStatsAccumulator();
    const sched = new RepairScheduler({ accumulator: acc, daemon: null });
    const r = await sched.tickOnce();
    expect(r).toBeNull();
    expect(acc.snapshot().state).toBe("idle");
  });

  it("errors from repairOnce surface as state:error in the accumulator", async () => {
    let now = 1_000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    let logged: unknown = null;
    const daemon = fakeDaemon(async () => {
      throw new Error("peer-link RST");
    });
    const sched = new RepairScheduler({
      accumulator: acc, daemon,
      onError: (e) => { logged = e; },
    });
    now = 7_000;
    const r = await sched.tickOnce();
    expect(r).toBeNull();
    expect(acc.snapshot()).toMatchObject({
      state: "error", lastTickMs: 7_000, lastError: "peer-link RST",
    });
    expect(logged).toBeInstanceOf(Error);
  });

  it("intervalMs floors at 1s to avoid a tight spin from a bad config", () => {
    const acc = new RepairStatsAccumulator();
    const daemon = fakeDaemon(async () =>
      ({ attempted: 0, replaced: 0, proactivelyBoosted: 0, criticalAlerts: 0 }));
    const t = fakeTimers();
    const captured: number[] = [];
    const setI = ((fn: () => void, ms?: number) => {
      captured.push(ms ?? 0);
      return t.setI(fn);
    }) as unknown as typeof setInterval;
    const sched = new RepairScheduler({
      accumulator: acc, daemon, intervalMs: 10,
      setInterval: setI, clearInterval: t.clearI,
    });
    sched.start();
    expect(captured[0]).toBe(1_000);
  });
});
