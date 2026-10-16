/**
 * End to end with the mock model: no network, no key. Runs scenarios
 * through the box's build loop and checks the accounting it produces.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BudgetGuard } from "../src/budget.js";
import { runOne } from "../src/runBuild.js";
import { loadScenarios } from "../src/scenarios.js";
import { ShimHost } from "../src/shimHost.js";
import { StaticStaging, STATIC_CHECK_BODY } from "../src/staticStaging.js";
import { findPython } from "../src/staticCheck.js";
import { renderReport } from "../src/report.js";
import { totalsOf } from "../src/accounting.js";

const python = await findPython();
const scenarios = loadScenarios();
const byId = (id: string) => scenarios.find((s) => s.id === id)!;
const hosts: ShimHost[] = [];
afterAll(() => hosts.forEach((h) => h.close()));

async function run(id: string, model = "low", maxUsd = 5) {
  const guard = new BudgetGuard(maxUsd);
  const host = new ShimHost({ upstream: "mock", guard, redact: (s) => s });
  hosts.push(host);
  const r = await runOne({
    runId: `${id}-${model}-t`,
    scenario: byId(id),
    model,
    repeat: 1,
    host,
    guard,
    upstream: "mock",
    stage: "static",
    staging: (onStage) => new StaticStaging({ python, onStage }),
    workDir: join(tmpdir(), "build-eval-test"),
  });
  return { r, guard, host };
}

describe("a mock run through the box's build loop", () => {
  it("builds, answers the owner's questions, sets an env var, and makes every edit", async () => {
    const { r } = await run("club-manager");
    expect(r.pass).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(["build", "edit-1", "edit-2"]);
    const build = r.steps[0]!;
    // one talkToUser question, one requestEnvVar
    expect(build.ownerAnswers).toBe(2);
    expect(build.fixLoop).toBe(false);
    expect(build.stages).toBe(1);
    expect(r.steps.every((s) => s.pass)).toBe(true);
    // the chat turns all streamed
    expect(r.calls.every((c) => c.phase === "chat" && c.stream)).toBe(true);
    expect(r.totals.turns).toBe(r.calls.length);
  });

  it("runs the fix loop when the first test copy fails, and counts it", async () => {
    const { r } = await run("booking-form");
    expect(r.pass).toBe(true);
    const build = r.steps[0]!;
    expect(build.fixLoop).toBe(true);
    expect(build.fixRounds).toBe(1);
    expect(build.failedStages).toBe(1);
    expect(build.stages).toBe(2);
    const fix = r.calls.filter((c) => c.phase === "fix");
    // read, write, validate, deploy, check, finish
    expect(fix).toHaveLength(6);
    expect(fix.every((c) => !c.stream)).toBe(true);
  });

  it("charges what the provider reported, and the shim reported the same usage", async () => {
    const { r } = await run("todo-list", "high");
    expect(r.multiplier).toBe(3.5);
    const t = totalsOf(r.calls);
    expect(r.totals).toEqual(t);
    expect(r.shimReported).toEqual({ inputTokens: t.inputTokens, outputTokens: t.outputTokens });
    expect(r.totals.credits).toBeCloseTo((t.inputTokens + 4 * t.outputTokens) * 3.5 / 1000, 0);
    const stepSum = r.steps.reduce((n, s) => n + s.totals.inputTokens, 0);
    expect(stepSum).toBe(t.inputTokens);
    expect(r.totals.cachedTokens).toBeGreaterThan(0);
  });

  it("stops a run cleanly when the next model call could pass the budget", async () => {
    const { r, guard } = await run("kanban-realtime", "high", 0.003);
    expect(r.pass).toBe(false);
    expect(r.stoppedByBudget).toBe(true);
    expect(guard.tripped()).toMatch(/stopped mid-run/);
    expect(guard.spentUsd()).toBeLessThanOrEqual(0.003);
    expect(r.steps.filter((s) => s.skipped).length).toBeGreaterThan(0);
  });

  it("renders a report", async () => {
    const { r } = await run("static-page");
    const md = renderReport([r], {
      generatedAt: "now",
      upstream: "mock",
      stage: "static",
      models: ["low"],
      scenarios: ["static-page"],
      repeat: 1,
      planned: 1,
      maxUsd: 5,
      spentUsd: r.totals.costUsd,
      stopped: null,
    });
    expect(md).toMatch(/Mock run/);
    expect(md).toMatch(/\| Low 3× \(Qwen3\.6-35B-A3B\) \| 1\/1 \|/);
    expect(md).toMatch(/first builds per starter/);
    expect(STATIC_CHECK_BODY).toMatch(/not started/);
  });
});
