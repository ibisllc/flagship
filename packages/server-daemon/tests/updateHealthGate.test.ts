/**
 * Boot-time health gate + auto-rollback for the in-place self-update
 * (docs/server-update-mechanism.md — the never-bricks guarantee).
 *
 * Coverage:
 *   - no marker → nothing happens;
 *   - marker + healthy boot → COMMIT: marker cleared, update-applied reported;
 *   - marker + unhealthy boot → attempt persisted + restart requested;
 *   - bootAttempts exceeds N → ROLLBACK: checkout previousCommit + rebuild +
 *     marker cleared + update-rolled-back reported + restart;
 *   - rollback failure keeps the marker (retries next boot);
 *   - the health-signal latch (both signals → true; timeout → false).
 */

import { describe, expect, it } from "vitest";
import type {
  PendingVerifyMarker,
  PendingVerifyStore,
  UpdateCommandRunner,
} from "../src/updateConsumer.js";
import {
  buildUpdateHealthSignal,
  runUpdateBootGate,
  type RunUpdateBootGateOptions,
  type UpdateReportEvent,
} from "../src/updateHealthGate.js";

const PREV = "1111111111111111111111111111111111111111";
const TARGET = "2222222222222222222222222222222222222222";

function inMemPending(
  initial: PendingVerifyMarker | null,
): PendingVerifyStore & { current: PendingVerifyMarker | null } {
  const store = {
    current: initial,
    async read() {
      return store.current;
    },
    async write(m: PendingVerifyMarker) {
      store.current = m;
    },
    async clear() {
      store.current = null;
    },
  };
  return store;
}

interface RunnerSpy {
  calls: string[][];
  failOn?: string;
}
function makeRunner(spy: RunnerSpy): UpdateCommandRunner {
  return async (cmd, args) => {
    const call = [cmd, ...args];
    spy.calls.push(call);
    if (spy.failOn && call.join(" ").includes(spy.failOn)) {
      throw new Error(`injected failure on ${spy.failOn}`);
    }
    return { stdout: "" };
  };
}

function baseOpts(
  marker: PendingVerifyMarker | null,
  over: Partial<RunUpdateBootGateOptions> = {},
): {
  opts: RunUpdateBootGateOptions;
  pending: ReturnType<typeof inMemPending>;
  runner: RunnerSpy;
  restarts: { count: number };
  reports: Array<{ event: UpdateReportEvent; info: unknown }>;
} {
  const pending = inMemPending(marker);
  const runner: RunnerSpy = { calls: [] };
  const restarts = { count: 0 };
  const reports: Array<{ event: UpdateReportEvent; info: unknown }> = [];
  const opts: RunUpdateBootGateOptions = {
    pendingStore: pending,
    repoPath: "/opt/flagship",
    runner: makeRunner(runner),
    awaitHealthy: async () => true,
    requestRestart: () => {
      restarts.count++;
    },
    report: (event, info) => {
      reports.push({ event, info });
    },
    ...over,
  };
  return { opts, pending, runner, restarts, reports };
}

describe("runUpdateBootGate", () => {
  it("does nothing when no update is pending", async () => {
    const { opts, runner, restarts } = baseOpts(null);
    expect(await runUpdateBootGate(opts)).toEqual({ action: "none" });
    expect(runner.calls).toEqual([]);
    expect(restarts.count).toBe(0);
  });

  it("COMMITS on a healthy boot: marker cleared + update-applied reported", async () => {
    const marker = { previousCommit: PREV, targetCommit: TARGET, bootAttempts: 0 };
    const { opts, pending, runner, restarts, reports } = baseOpts(marker);
    const out = await runUpdateBootGate(opts);
    expect(out).toEqual({ action: "committed", targetCommit: TARGET });
    expect(pending.current).toBeNull();
    expect(reports).toEqual([
      {
        event: "update-applied",
        info: { previousCommit: PREV, targetCommit: TARGET, bootAttempts: 1 },
      },
    ]);
    // A commit is pure bookkeeping — no git/npm commands, no restart.
    expect(runner.calls).toEqual([]);
    expect(restarts.count).toBe(0);
  });

  it("persists the boot attempt and restarts on an unhealthy boot", async () => {
    const marker = { previousCommit: PREV, targetCommit: TARGET, bootAttempts: 1 };
    const { opts, pending, restarts, reports } = baseOpts(marker, {
      awaitHealthy: async () => false,
    });
    const out = await runUpdateBootGate(opts);
    expect(out).toEqual({ action: "retry-restart", bootAttempts: 2 });
    expect(pending.current).toEqual({ ...marker, bootAttempts: 2 });
    expect(restarts.count).toBe(1);
    expect(reports).toEqual([]);
  });

  it("ROLLS BACK once the boot budget is spent: checkout prev + rebuild + clear + report + restart", async () => {
    const marker = { previousCommit: PREV, targetCommit: TARGET, bootAttempts: 3 };
    let healthProbes = 0;
    const { opts, pending, runner, restarts, reports } = baseOpts(marker, {
      maxBootAttempts: 3,
      awaitHealthy: async () => {
        healthProbes++;
        return true;
      },
    });
    const out = await runUpdateBootGate(opts);
    expect(out).toEqual({ action: "rolled-back", previousCommit: PREV, targetCommit: TARGET });
    expect(runner.calls).toEqual([
      ["git", "-C", "/opt/flagship", "checkout", PREV],
      ["npm", "ci", "--no-audit", "--no-fund"],
      ["npx", "tsc", "-b"],
    ]);
    expect(pending.current).toBeNull();
    expect(reports).toEqual([
      {
        event: "update-rolled-back",
        info: { previousCommit: PREV, targetCommit: TARGET, bootAttempts: 3 },
      },
    ]);
    expect(restarts.count).toBe(1);
    // Rollback never waits on health — the decision is already made.
    expect(healthProbes).toBe(0);
  });

  it("keeps the marker and restarts when the rollback itself fails (retries next boot)", async () => {
    const marker = { previousCommit: PREV, targetCommit: TARGET, bootAttempts: 3 };
    const { opts, pending, restarts, reports } = baseOpts(marker, {
      runner: makeRunner({ calls: [], failOn: "checkout" }),
    });
    const out = await runUpdateBootGate(opts);
    expect(out).toEqual({ action: "retry-restart", bootAttempts: 3 });
    expect(pending.current).toEqual(marker);
    expect(restarts.count).toBe(1);
    expect(reports).toEqual([]);
  });

  it("never throws — a broken pending store reads as no update", async () => {
    const { opts } = baseOpts(null, {
      pendingStore: {
        read: async () => {
          throw new Error("disk");
        },
        write: async () => {},
        clear: async () => {},
      },
    });
    expect(await runUpdateBootGate(opts)).toEqual({ action: "none" });
  });
});

describe("buildUpdateHealthSignal", () => {
  it("resolves true once BOTH tunnel-up and heartbeat fire", async () => {
    const sig = buildUpdateHealthSignal();
    const p = sig.whenHealthy(60_000);
    sig.markTunnelUp();
    sig.markHeartbeat();
    await expect(p).resolves.toBe(true);
    // Already-healthy resolves immediately.
    await expect(sig.whenHealthy(1)).resolves.toBe(true);
  });

  it("resolves false at the timeout when only one signal fired", async () => {
    const sig = buildUpdateHealthSignal();
    sig.markTunnelUp();
    await expect(sig.whenHealthy(10)).resolves.toBe(false);
  });
});
