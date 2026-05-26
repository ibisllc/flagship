/**
 * Gap 3 — cross-tick stats accumulator for RepairDaemon.
 */

import { describe, expect, it } from "vitest";
import { RepairStatsAccumulator } from "../src/peerBackup/repairStatsAccumulator.js";

describe("RepairStatsAccumulator", () => {
  it("starts idle with zero counters", () => {
    const acc = new RepairStatsAccumulator({ now: () => 1000 });
    expect(acc.snapshot()).toEqual({
      state: "idle",
      lastTickMs: null,
      queued: 0,
      completed24h: 0,
    });
  });

  it("wrapTick transitions running → idle and bumps completed24h", async () => {
    let now = 1000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    const states: string[] = [];

    const tick = async () => {
      states.push(acc.snapshot().state);
      return { replaced: 3 };
    };
    now = 2000;
    await acc.wrapTick(tick);
    const snap = acc.snapshot();
    expect(states).toEqual(["running"]);
    expect(snap.state).toBe("idle");
    expect(snap.lastTickMs).toBe(2000);
    expect(snap.completed24h).toBe(3);
  });

  it("wrapTick with no replacements still stamps lastTickMs but doesn't add a completion entry", async () => {
    let now = 5000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    await acc.wrapTick(async () => ({ replaced: 0 }));
    expect(acc.snapshot().lastTickMs).toBe(5000);
    expect(acc.snapshot().completed24h).toBe(0);
  });

  it("rolls completions out of the 24h window", async () => {
    let now = 1_000_000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    await acc.wrapTick(async () => ({ replaced: 5 }));
    expect(acc.snapshot().completed24h).toBe(5);
    // Advance ~23h, add 2 more — window still includes both.
    now += 23 * 60 * 60_000;
    await acc.wrapTick(async () => ({ replaced: 2 }));
    expect(acc.snapshot().completed24h).toBe(7);
    // Advance another 2h — the original 5 falls out, only the 2 remains.
    now += 2 * 60 * 60_000;
    expect(acc.snapshot().completed24h).toBe(2);
  });

  it("captures the error and re-throws", async () => {
    const acc = new RepairStatsAccumulator({ now: () => 9000 });
    await expect(acc.wrapTick(async () => {
      throw new Error("peer-7 timeout");
    })).rejects.toThrow("peer-7 timeout");
    const snap = acc.snapshot();
    expect(snap.state).toBe("error");
    expect(snap.lastError).toBe("peer-7 timeout");
    expect(snap.lastTickMs).toBe(9000);
  });

  it("setQueued surfaces in the snapshot; finishTick clears it", async () => {
    const acc = new RepairStatsAccumulator({ now: () => 1000 });
    acc.setQueued(4);
    expect(acc.snapshot().queued).toBe(4);
    await acc.wrapTick(async () => ({ replaced: 1 }));
    expect(acc.snapshot().queued).toBe(0);
  });

  it("clearError flips state back to idle", () => {
    const acc = new RepairStatsAccumulator({ now: () => 1000 });
    acc.recordError(new Error("boom"));
    expect(acc.snapshot().state).toBe("error");
    acc.clearError();
    expect(acc.snapshot().state).toBe("idle");
    expect(acc.snapshot().lastError).toBeUndefined();
  });

  it("recordCompleted bumps the rolling window manually", () => {
    let now = 500_000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    acc.recordCompleted(2);
    acc.recordCompleted(3);
    expect(acc.snapshot().completed24h).toBe(5);
    // Past the 24h cutoff.
    now += 25 * 60 * 60_000;
    expect(acc.snapshot().completed24h).toBe(0);
  });

  it("custom windowMs is respected", async () => {
    let now = 100;
    const acc = new RepairStatsAccumulator({
      now: () => now,
      windowMs: 1000,
    });
    await acc.wrapTick(async () => ({ replaced: 4 }));
    expect(acc.snapshot().completed24h).toBe(4);
    now += 2000;
    expect(acc.snapshot().completed24h).toBe(0);
  });

  it("serializes a string error verbatim", async () => {
    const acc = new RepairStatsAccumulator({ now: () => 1 });
    await expect(acc.wrapTick(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "raw string failure";
    })).rejects.toBe("raw string failure");
    expect(acc.snapshot().lastError).toBe("raw string failure");
  });
});
