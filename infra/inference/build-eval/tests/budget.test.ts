import { describe, expect, it } from "vitest";
import { BudgetExceeded, BudgetGuard, RunEstimator } from "../src/budget.js";
import { planRuns, runMatrix } from "../src/matrix.js";
import { totalsOf } from "../src/accounting.js";
import type { RunResult } from "../src/runBuild.js";
import { loadScenarios } from "../src/scenarios.js";
import { upstreamMessage } from "../src/shimHost.js";

describe("BudgetGuard", () => {
  it("refuses to start a run whose estimate would pass the limit", () => {
    const g = new BudgetGuard(1);
    expect(g.tryStartRun("a", 0.6)).toBe(true);
    // a's reservation still counts while it runs
    expect(g.tryStartRun("b", 0.6)).toBe(false);
    expect(g.tripped()).toMatch(/stopped before the next run/);
  });

  it("frees a reservation when the run ends and counts what was spent", () => {
    const g = new BudgetGuard(1);
    expect(g.tryStartRun("a", 0.6)).toBe(true);
    g.beginCall(0.5);
    g.endCall(0.5, 0.2);
    g.endRun("a");
    expect(g.spentUsd()).toBeCloseTo(0.2, 9);
    expect(g.tryStartRun("b", 0.7)).toBe(true);
  });

  it("refuses a call whose worst case doesn't fit, counting calls in flight", () => {
    const g = new BudgetGuard(1);
    g.beginCall(0.4);
    g.beginCall(0.4);
    expect(() => g.beginCall(0.3)).toThrow(BudgetExceeded);
    expect(g.tripped()).toMatch(/stopped mid-run/);
    // once tripped, no run starts
    expect(g.tryStartRun("x", 0)).toBe(false);
  });

  it("rejects a limit that isn't positive", () => {
    expect(() => new BudgetGuard(0)).toThrow();
  });
});

describe("RunEstimator", () => {
  it("starts from twice the cost doc's per-build estimate per step", () => {
    const e = new RunEstimator();
    const build = (424_000 * 0.1 + 13_000 * 0.95) / 1e6;
    expect(e.estimate("low", "x", 3)).toBeCloseTo(build * 2 * 3, 9);
  });

  it("then uses the dearest run seen, with room", () => {
    const e = new RunEstimator();
    e.observe("low", "x", 2, 0.01);
    e.observe("low", "x", 2, 0.03);
    expect(e.estimate("low", "x", 2)).toBeCloseTo(0.0375, 9);
    // another scenario of the same model: never below the prior
    expect(e.estimate("low", "y", 1)).toBeCloseTo(e.prior("low", 1), 9);
    e.observe("low", "z", 1, 1);
    expect(e.estimate("low", "y", 2)).toBeCloseTo(2 * 1.25, 9);
  });
});

describe("runMatrix", () => {
  const fake = (runId: string, model: string, cost: number): RunResult => ({
    runId,
    model,
    modelLabel: model,
    multiplier: 1,
    scenario: "s",
    size: "small",
    repeat: 1,
    upstream: "mock",
    stage: "static",
    startedAt: "",
    wallMs: 0,
    pass: true,
    steps: [],
    totals: { ...totalsOf([]), costUsd: cost },
    calls: [],
  });

  it("orders runs repeat by repeat, and stops starting them when the budget can't cover the next", async () => {
    const scenarios = loadScenarios().slice(0, 2);
    const plan = planRuns(scenarios, ["low", "high"], 2);
    expect(plan.map((p) => p.runId).slice(0, 4)).toEqual([
      `${scenarios[0]!.id}-low-r1`,
      `${scenarios[0]!.id}-high-r1`,
      `${scenarios[1]!.id}-low-r1`,
      `${scenarios[1]!.id}-high-r1`,
    ]);
    const guard = new BudgetGuard(0.5);
    const ran: string[] = [];
    const skipped: string[] = [];
    const { results, notStarted } = await runMatrix({
      plan,
      guard,
      estimator: new RunEstimator(),
      concurrency: 1,
      run: async (p) => {
        ran.push(p.runId);
        guard.beginCall(0.01);
        guard.endCall(0.01, 0.01);
        return fake(p.runId, p.model, 0.01);
      },
      onSkip: (p) => skipped.push(p.runId),
    });
    expect(results.length).toBe(ran.length);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.length).toBeLessThan(plan.length);
    expect(skipped).toHaveLength(1);
    expect(notStarted).toBe(plan.length - ran.length);
    expect(guard.spentUsd()).toBeLessThanOrEqual(0.5);
  });
});

describe("account refusals", () => {
  it("halt stops new runs and keeps the first reason", () => {
    const g = new BudgetGuard(5);
    g.halt("stopped: DeepInfra refused the account (HTTP 402): no balance");
    g.halt("a later reason");
    expect(g.tripped()).toBe("stopped: DeepInfra refused the account (HTTP 402): no balance");
    expect(g.tryStartRun("a", 0.01)).toBe(false);
  });

  it("reads the upstream's own message out of an OpenAI-shaped error", () => {
    expect(upstreamMessage('{"error":{"message":"You need positive balance to do inference."}}')).toBe(
      "You need positive balance to do inference.",
    );
    expect(upstreamMessage("Bad Gateway")).toBe("Bad Gateway");
    expect(upstreamMessage("")).toBe("no detail");
  });
});
