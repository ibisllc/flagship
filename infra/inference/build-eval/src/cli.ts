/**
 * build-eval: measure what an AI app build costs on Flagship Inference.
 * See README.md. Run with tsx after `npx tsc -b` (the daemon's workspace
 * dependencies load from their built dist/).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { inferenceCatalog } from "@flagship/control-plane";
import { BudgetGuard, RunEstimator } from "./budget.js";
import { DockerStaging, dockerAvailable } from "./dockerStage.js";
import { keyRedactor, loadKey } from "./key.js";
import { planRuns, runMatrix } from "./matrix.js";
import { USAGE, parseOptions, type Options } from "./options.js";
import { renderReport } from "./report.js";
import { runOne, type RunResult } from "./runBuild.js";
import { loadScenarios, selectScenarios } from "./scenarios.js";
import { ShimHost } from "./shimHost.js";
import { findPython } from "./staticCheck.js";
import { StaticStaging } from "./staticStaging.js";
import { PRICES_CHECKED } from "./prices.js";

function shown(p: string): string {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
}

function log(m: string): void {
  process.stderr.write(`${m}\n`);
}

async function main(argv: string[]): Promise<number> {
  let o: Options;
  try {
    o = parseOptions(argv);
  } catch (e) {
    log((e as Error).message);
    return 2;
  }
  if (o.help) {
    log(USAGE);
    return 0;
  }
  const scenarios = selectScenarios(loadScenarios(), o.scenarios);
  const plan = planRuns(scenarios, o.models, o.repeat);
  const estimator = new RunEstimator();

  if (o.plan) {
    let total = 0;
    for (const p of plan) {
      const e = estimator.estimate(p.model, p.scenario.id, p.steps);
      total += e;
      log(`${p.runId.padEnd(36)} ${p.steps} step(s)  up to ~$${e.toFixed(3)} (prior)`);
    }
    log(`\n${plan.length} runs; the priors add up to ~$${total.toFixed(2)} (2× the cost doc's per-build estimate). --max-usd ${o.maxUsd} caps the spend.`);
    return 0;
  }

  const key = o.mock ? { key: null, reason: "mock" } : loadKey();
  if (!o.mock && !key.key) {
    log(`${"reason" in key ? key.reason : "no key"}\n(use --mock to run without one)`);
    return 2;
  }
  const redact = keyRedactor(key.key);
  const python = await findPython();
  const stage: "static" | "docker" = o.stage === "auto" ? ((await dockerAvailable()) ? "docker" : "static") : o.stage;
  if (stage === "docker" && !(await dockerAvailable())) {
    log("--stage docker: docker isn't running here");
    return 2;
  }
  const pgAdminUrl = process.env.BUILD_EVAL_PG_URL ?? null;

  const guard = new BudgetGuard(o.maxUsd);
  const host = new ShimHost({
    upstream: o.mock ? "mock" : "deepinfra",
    apiKey: key.key,
    guard,
    redact,
    ...(o.modelThinking ? { modelThinking: true } : {}),
  });
  await mkdir(join(o.out, "runs"), { recursive: true });
  const workDir = join(tmpdir(), `build-eval-${process.pid}`);
  log(
    `build-eval: ${plan.length} runs, upstream ${o.mock ? "mock" : `DeepInfra (key from ${"from" in key ? key.from : "?"})`}, ` +
      `build check ${stage}${stage === "docker" ? (pgAdminUrl ? " + Postgres" : " (no BUILD_EVAL_PG_URL: Postgres apps aren't started)") : ""}, ` +
      `python ${python ?? "not found (Python syntax checks skipped)"}, limit $${o.maxUsd}, prices ${PRICES_CHECKED}\n` +
      `results: ${shown(o.out)}`,
  );

  const started = Date.now();
  let results: RunResult[] = [];
  let notStarted = 0;
  try {
    ({ results, notStarted } = await runMatrix({
      plan,
      guard,
      estimator,
      concurrency: o.concurrency,
      run: async (p) => {
        const t0 = Date.now();
        try {
          return await runOne({
            runId: p.runId,
            scenario: p.scenario,
            model: p.model,
            repeat: p.repeat,
            host,
            guard,
            upstream: o.mock ? "mock" : "deepinfra",
            stage,
            staging: (onStage) =>
              stage === "docker" ? new DockerStaging({ pgAdminUrl, python, onStage }) : new StaticStaging({ python, onStage }),
            workDir,
            ...(o.saveApps ? { saveAppsDir: join(o.out, "apps") } : {}),
            ...(o.agentMaxTurns ? { agentMaxTurns: o.agentMaxTurns } : {}),
          });
        } catch (e) {
          return crashedRun(p, o, stage, redact((e as Error).stack ?? String(e)), Date.now() - t0);
        }
      },
      onDone: async (r, i) => {
        await writeFile(join(o.out, "runs", `${r.runId}.json`), `${redact(JSON.stringify(r, null, 2))}\n`);
        const fixes = r.steps.reduce((n, s) => n + s.fixRounds, 0);
        log(
          `[${i}/${plan.length}] ${r.runId}: ${r.pass ? "pass" : "FAIL"} ${r.totals.credits} credits ` +
            `$${r.totals.costUsd.toFixed(4)} (${r.totals.calls} calls, ${fixes} fix round${fixes === 1 ? "" : "s"}, ` +
            `${Math.round(r.wallMs / 1000)} s; spent $${guard.spentUsd().toFixed(4)})` +
            (r.pass ? "" : `\n    ${redact((r.failure ?? "").split("\n")[0]!.slice(0, 200))}`),
        );
      },
      onSkip: (p, why) => log(`stopping before ${p.runId}: ${why}`),
    }));
  } finally {
    host.close();
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    upstream: (o.mock ? "mock" : "deepinfra") as "mock" | "deepinfra",
    stage,
    models: o.models,
    scenarios: scenarios.map((s) => s.id),
    repeat: o.repeat,
    planned: plan.length,
    maxUsd: o.maxUsd,
    spentUsd: guard.spentUsd(),
    stopped: guard.tripped(),
    thinking: (o.modelThinking ? "model-default" : "off") as "off" | "model-default",
  };
  const report = redact(renderReport(results, meta));
  await writeFile(join(o.out, "summary.md"), report);
  await writeFile(
    join(o.out, "summary.json"),
    `${redact(JSON.stringify({ meta, catalog: inferenceCatalog(), runs: results.map(({ calls: _calls, ...r }) => r) }, null, 2))}\n`,
  );
  log(
    `\n${results.length} runs in ${Math.round((Date.now() - started) / 1000)} s` +
      `${notStarted ? `, ${notStarted} not started` : ""}; spent $${guard.spentUsd().toFixed(4)}.\n` +
      `summary: ${shown(join(o.out, "summary.md"))}`,
  );
  return 0;
}

function crashedRun(
  p: { runId: string; scenario: { id: string; size: RunResult["size"] }; model: string; repeat: number },
  o: Options,
  stage: "static" | "docker",
  why: string,
  wallMs: number,
): RunResult {
  const served = inferenceCatalog().find((m) => m.id === p.model);
  const zero = { calls: 0, turns: 0, compactions: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, weightedTokens: 0, credits: 0, creditsShown: 0, costUsd: 0 };
  return {
    runId: p.runId,
    model: p.model,
    modelLabel: served?.label ?? p.model,
    multiplier: served?.multiplier ?? 1,
    scenario: p.scenario.id,
    size: p.scenario.size,
    repeat: p.repeat,
    upstream: o.mock ? "mock" : "deepinfra",
    stage,
    startedAt: new Date().toISOString(),
    wallMs,
    pass: false,
    failure: `harness error: ${why.slice(0, 2000)}`,
    steps: [],
    totals: zero,
    calls: [],
  };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    log(`build-eval failed: ${keyRedactor(loadKey().key)((e as Error).message)}`);
    process.exit(1);
  },
);
