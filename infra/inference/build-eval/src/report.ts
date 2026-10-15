/**
 * The markdown summary of a measurement: per model and per scenario
 * medians and p90s, a first build against an edit, the cost doc's 474k
 * estimate, and what the free allowance buys.
 */

import { ALLOWANCE, ESTIMATED_BUILD_WEIGHTED, round } from "./accounting.js";
import { PRICES_CHECKED } from "./prices.js";
import type { RunResult, StepResult } from "./runBuild.js";

/** Linear-interpolated percentile (p in 0..100) of `xs`; NaN when empty. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = ((s.length - 1) * p) / 100;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

export const median = (xs: readonly number[]) => percentile(xs, 50);
export const p90 = (xs: readonly number[]) => percentile(xs, 90);

export interface ReportMeta {
  generatedAt: string;
  upstream: "deepinfra" | "mock";
  stage: "static" | "docker";
  models: string[];
  scenarios: string[];
  repeat: number;
  planned: number;
  maxUsd: number;
  spentUsd: number;
  stopped: string | null;
  /** "off": the shim's thinking switch; "model-default": stripped on the way out (`--model-thinking`). */
  thinking?: "off" | "model-default";
}

const fmt = (n: number, places = 1): string => (Number.isFinite(n) ? round(n, places).toLocaleString("en-US") : "–");
const usd = (n: number): string => (Number.isFinite(n) ? `$${n < 0.1 ? n.toFixed(4) : n.toFixed(3)}` : "–");
const pair = (xs: number[], places = 1): string => (xs.length ? `${fmt(median(xs), places)} / ${fmt(p90(xs), places)}` : "–");

function done(steps: StepResult[]): StepResult[] {
  return steps.filter((s) => !s.skipped && s.totals.calls > 0);
}

function stepsOf(runs: readonly RunResult[], kind: "build" | "edit"): StepResult[] {
  return done(runs.flatMap((r) => r.steps.filter((s) => s.kind === kind)));
}

/** Charged weighted tokens of a step (credits × 1,000, multiplier included). */
const charged = (s: StepResult) => s.totals.credits * 1000;

export function renderReport(runs: readonly RunResult[], meta: ReportMeta): string {
  const out: string[] = [];
  const models = meta.models.filter((m) => runs.some((r) => r.model === m));
  const label = (m: string) => runs.find((r) => r.model === m)?.modelLabel ?? m;
  out.push(`# AI build cost measurement`, "");
  if (meta.upstream === "mock") {
    out.push(
      "> **Mock run.** The model was the harness's scripted stand-in (`--mock`), so every number below measures the harness, not a model. Run without `--mock` for real figures.",
      "",
    );
  }
  out.push(
    `- Generated ${meta.generatedAt}; upstream **${meta.upstream === "mock" ? "mock" : "DeepInfra"}**, build check **${meta.stage}**, thinking **${meta.thinking === "model-default" ? "the model's own default (`--model-thinking`, not what production sends)" : "off (the shim's switch)"}**.`,
    `- ${runs.length} of ${meta.planned} planned runs (${meta.models.join(", ")} × ${meta.scenarios.length} scenarios × ${meta.repeat} repeat${meta.repeat === 1 ? "" : "s"}).`,
    `- Spent ${usd(meta.spentUsd)} of the $${meta.maxUsd} limit, at DeepInfra's prices checked ${PRICES_CHECKED}.${meta.stopped ? ` **${meta.stopped}.**` : ""}`,
    `- Credits are what \`.com\` charges: (input × 1 + output × 4) × the model's multiplier / 1,000. "median / p90" throughout.`,
    "",
  );

  out.push("## Per model", "");
  out.push("| model | runs passed | first build credits | edit credits | whole run credits | $ per run | build turns | fix loop ran | compactions |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const m of models) {
    const rs = runs.filter((r) => r.model === m);
    const builds = stepsOf(rs, "build");
    const edits = stepsOf(rs, "edit");
    out.push(
      `| ${label(m)} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${pair(builds.map((s) => s.totals.credits))} | ${pair(edits.map((s) => s.totals.credits))} | ${pair(rs.map((r) => r.totals.credits))} | ${usd(median(rs.map((r) => r.totals.costUsd)))} / ${usd(p90(rs.map((r) => r.totals.costUsd)))} | ${pair(builds.map((s) => s.totals.turns), 0)} | ${builds.filter((s) => s.fixLoop).length}/${builds.length} | ${rs.reduce((n, r) => n + r.totals.compactions, 0)} |`,
    );
  }
  out.push("");

  out.push("## Against the estimate and the allowance", "");
  out.push(
    `The cost doc (§5) estimates one build at ${fmt(ESTIMATED_BUILD_WEIGHTED / 1000, 0)}k weighted tokens. The allowance is ${fmt(ALLOWANCE.starterTokens / 1e6, 1)}M starter + ${fmt(ALLOWANCE.weeklyTokens / 1000, 0)}k a week (weighted, before the multiplier).`,
    "",
  );
  out.push("| model | first build weighted tokens | vs 474k | first builds per starter | first builds per week | edits per week | runs (build + edits) per starter |");
  out.push("|---|---|---|---|---|---|---|");
  for (const m of models) {
    const rs = runs.filter((r) => r.model === m);
    const builds = stepsOf(rs, "build");
    const edits = stepsOf(rs, "edit");
    const b = median(builds.map((s) => s.totals.weightedTokens));
    const bc = median(builds.map(charged));
    const ec = median(edits.map(charged));
    const rc = median(rs.map((r) => r.totals.credits * 1000));
    const per = (allow: number, x: number) => (Number.isFinite(x) && x > 0 ? fmt(allow / x, 1) : "–");
    out.push(
      `| ${label(m)} | ${fmt(b / 1000, 0)}k | ${Number.isFinite(b) ? `${fmt((b / ESTIMATED_BUILD_WEIGHTED) * 100, 0)}%` : "–"} | ${per(ALLOWANCE.starterTokens, bc)} | ${per(ALLOWANCE.weeklyTokens, bc)} | ${per(ALLOWANCE.weeklyTokens, ec)} | ${per(ALLOWANCE.starterTokens, rc)} |`,
    );
  }
  out.push("");

  out.push("## Per scenario", "");
  out.push("| scenario | size | model | passed | first build credits | edit credits | fix rounds per run | owner answers per run | $ per run |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const sc of meta.scenarios) {
    for (const m of models) {
      const rs = runs.filter((r) => r.scenario === sc && r.model === m);
      if (rs.length === 0) continue;
      const builds = stepsOf(rs, "build");
      const edits = stepsOf(rs, "edit");
      out.push(
        `| ${sc} | ${rs[0]!.size} | ${m} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${pair(builds.map((s) => s.totals.credits))} | ${pair(edits.map((s) => s.totals.credits))} | ${pair(rs.map((r) => r.steps.reduce((n, s) => n + s.fixRounds, 0)), 0)} | ${pair(rs.map((r) => r.steps.reduce((n, s) => n + s.ownerAnswers, 0)), 0)} | ${usd(median(rs.map((r) => r.totals.costUsd)))} |`,
      );
    }
  }
  out.push("");

  out.push("## Tokens", "");
  out.push("| model | input per first build | output per first build | cached share of input | wall time per first build |");
  out.push("|---|---|---|---|---|");
  for (const m of models) {
    const builds = stepsOf(runs.filter((r) => r.model === m), "build");
    const input = builds.reduce((n, s) => n + s.totals.inputTokens, 0);
    const cached = builds.reduce((n, s) => n + s.totals.cachedTokens, 0);
    out.push(
      `| ${label(m)} | ${pair(builds.map((s) => s.totals.inputTokens), 0)} | ${pair(builds.map((s) => s.totals.outputTokens), 0)} | ${input > 0 ? `${fmt((cached / input) * 100, 0)}%` : "–"} | ${pair(builds.map((s) => s.wallMs / 1000), 0)} s |`,
    );
  }
  out.push("");

  const failures = runs.filter((r) => !r.pass);
  if (failures.length > 0) {
    out.push("## Failures", "");
    for (const r of failures) out.push(`- \`${r.runId}\`: ${(r.failure ?? "").split("\n").slice(0, 3).join(" ⏎ ").slice(0, 400)}`);
    out.push("");
  }

  out.push(
    "## Reading this",
    "",
    "- **First build** is the owner's first message through to the app live: the chat turns, the owner's scripted answers, and the AI fix loop when the first test copy wouldn't build or start. **Edit** is one follow-up change, a new chat on the live app's files.",
    "- **Fix rounds** count failures fed back to the model: the failed test copy that starts the loop, then each failed `deploy` inside it.",
    "- **Builds per starter / week** divide the allowance by the median charged tokens (multiplier included), so a 3.5× model buys fewer.",
    "- Per-run detail, every model call with the provider's own token counts, is in `runs/*.json`; the apps the model wrote are in `apps/`.",
    "",
  );
  return out.join("\n");
}
