#!/usr/bin/env node
// Release-readiness scoreboard: runs every gate the owner re-checks after a
// batch of fixes and writes gym-results/ready-<ts>/report.{md,json}, with a
// delta against the previous run. Exit 1 when any phase is red.
//
//   npm run ready                         branches, tsc, vitest, e2e, gym (web), parity
//   npm run ready -- --native --live      + gym on ios/android, + the live gym
//   npm run ready -- --only parity,branches
//   npm run ready -- --skip e2e
//   --no-fetch                            don't `git fetch origin` before the branch phase
//
// See docs/runbooks/release-readiness.md.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_VERSION = "4.149.0";
const E2E_PORT = 8787;

/** Each feature branch and the branch it is built on (AGENTS.md). */
export const BRANCHES = [
  { branch: "feat/marketplace", parent: "main" },
  { branch: "feat/custom-names", parent: "feat/marketplace" },
  { branch: "feat/custom-domains", parent: "feat/marketplace" },
  { branch: "feat/retail", parent: "main" },
  { branch: "feat/browser-extension", parent: "main" },
  { branch: "feat/phone-usb-burn", parent: "main" },
  { branch: "alpine", parent: "main" },
  { branch: "gym", parent: "main" },
];

export const PHASES = ["branches", "tsc", "vitest", "e2e", "gym", "parity", "live"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
}

/** Runs a command with its output in `log`; returns { status, out, ms }. */
function run(cmd, args, { cwd = ROOT, env = {}, log, timeoutMs = 60 * 60_000 } = {}) {
  const start = Date.now();
  const fd = openSync(log, "a");
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd], timeout: timeoutMs });
  closeSync(fd);
  const out = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { status: r.status ?? (r.signal ? 124 : 1), out, ms: Date.now() - start, error: r.error?.message };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** `git merge-tree --write-tree --name-only` output → conflicted paths. */
export function parseMergeTree(stdout) {
  const lines = String(stdout ?? "").split("\n");
  const out = [];
  for (const l of lines.slice(1)) {
    if (!l.trim()) break;
    out.push(l.trim());
  }
  return [...new Set(out)];
}

const ref = (name) => (git(["rev-parse", "--verify", "-q", `origin/${name}`]).status === 0 ? `origin/${name}` : git(["rev-parse", "--verify", "-q", name]).status === 0 ? name : null);

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function phaseBranches(ctx) {
  if (!ctx.noFetch) git(["fetch", "-q", "origin"], { timeout: 120_000 });
  const rows = [];
  for (const { branch, parent } of BRANCHES) {
    const b = ref(branch);
    const p = ref(parent);
    if (!b || !p) {
      rows.push({ branch, parent, missing: !b ? branch : parent });
      continue;
    }
    const counts = git(["rev-list", "--left-right", "--count", `${p}...${b}`]).stdout.trim().split(/\s+/).map(Number);
    const mt = git(["merge-tree", "--write-tree", "--name-only", "--no-messages", p, b]);
    const conflicts = mt.status === 1 ? parseMergeTree(mt.stdout) : [];
    rows.push({ branch, parent, behind: counts[0] ?? 0, ahead: counts[1] ?? 0, conflicts: conflicts.length, conflictFiles: conflicts.slice(0, 20), mergeTreeError: mt.status > 1 ? mt.stderr.trim() : undefined });
  }
  const red = rows.filter((r) => r.missing || r.conflicts > 0 || r.mergeTreeError);
  const behind = rows.filter((r) => r.behind > 0);
  writeFileSync(join(ctx.out, "branches.json"), JSON.stringify(rows, null, 2));
  return {
    status: red.length ? "red" : behind.length ? "amber" : "green",
    summary: red.length
      ? `${red.length}/${rows.length} conflict or missing: ${red.map((r) => r.missing ? `${r.branch} (no ${r.missing})` : `${r.branch} (${r.conflicts})`).join(", ")}`
      : `${rows.length} merge clean${behind.length ? `; ${behind.length} behind their parent` : ""}`,
    metrics: { conflicts: rows.reduce((n, r) => n + (r.conflicts ?? 0), 0), behindTotal: rows.reduce((n, r) => n + (r.behind ?? 0), 0) },
    detail: rows,
  };
}

function phaseTsc(ctx) {
  const r = run("npx", ["tsc", "-b"], { log: join(ctx.out, "tsc.log") });
  const errors = (r.out.match(/error TS\d+/g) ?? []).length;
  return { status: r.status === 0 ? "green" : "red", summary: r.status === 0 ? "clean" : `${errors || "?"} errors`, metrics: { errors }, ms: r.ms };
}

function phaseVitest(ctx) {
  const json = join(ctx.out, "vitest.json");
  const r = run("npx", ["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${json}`], { log: join(ctx.out, "vitest.log") });
  const j = readJson(json);
  if (!j) return { status: "red", summary: `no result (exit ${r.status})`, metrics: {}, ms: r.ms };
  const failedFiles = (j.testResults ?? []).filter((t) => t.status === "failed").map((t) => t.name.replace(`${ROOT}/`, ""));
  const metrics = { total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, skipped: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0), failedFiles: failedFiles.length };
  const ok = r.status === 0 && metrics.failed === 0 && failedFiles.length === 0;
  return {
    status: ok ? "green" : "red",
    summary: `${metrics.passed}/${metrics.total} passed${metrics.failed ? `, ${metrics.failed} failed` : ""}${failedFiles.length ? ` (${failedFiles.length} files failed)` : ""}`,
    metrics,
    detail: { failedFiles: failedFiles.slice(0, 40) },
    ms: r.ms,
  };
}

async function healthy(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.ok && (await r.text()).includes('"ok"');
  } catch {
    return false;
  }
}

async function phaseE2e(ctx) {
  const health = `http://localhost:${E2E_PORT}/api/health`;
  const log = join(ctx.out, "e2e.log");
  let worker = null;
  const start = Date.now();
  if (!(await healthy(health))) {
    const mig = run("npx", ["--yes", `wrangler@${WRANGLER_VERSION}`, "d1", "migrations", "apply", "flagship-state", "--local"], { cwd: join(ROOT, "apps/com"), log, env: { CI: "1" } });
    if (mig.status !== 0) return { status: "red", summary: "local D1 migrations failed (see e2e.log)", metrics: {} };
    const fd = openSync(join(ctx.out, "wrangler-dev.log"), "a");
    worker = spawn("npx", ["--yes", `wrangler@${WRANGLER_VERSION}`, "dev", "--port", String(E2E_PORT), "--var", "RATE_LIMIT_SCALE:100"], { cwd: join(ROOT, "apps/com"), stdio: ["ignore", fd, fd], detached: true });
    closeSync(fd);
    let up = false;
    for (let i = 0; i < 180 && !up; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      up = await healthy(health);
    }
    if (!up) {
      stopWorker(worker);
      return { status: "red", summary: `wrangler dev never answered ${health} (see wrangler-dev.log)`, metrics: {} };
    }
  }
  try {
    const json = join(ctx.out, "playwright.json");
    const r = run("npx", ["playwright", "test", "--reporter=line,json"], { cwd: join(ROOT, "apps/web/e2e"), log, env: { PLAYWRIGHT_JSON_OUTPUT_NAME: json, CI: "1" } });
    const s = readJson(json)?.stats;
    if (!s) return { status: "red", summary: `no Playwright result (exit ${r.status})`, metrics: {}, ms: Date.now() - start };
    const metrics = { passed: s.expected, failed: s.unexpected, flaky: s.flaky, skipped: s.skipped };
    return {
      status: r.status === 0 && !s.unexpected ? (s.flaky ? "amber" : "green") : "red",
      summary: `${s.expected} passed${s.unexpected ? `, ${s.unexpected} failed` : ""}${s.flaky ? `, ${s.flaky} flaky` : ""}${s.skipped ? `, ${s.skipped} skipped` : ""}`,
      metrics,
      ms: Date.now() - start,
    };
  } finally {
    stopWorker(worker);
  }
}

function stopWorker(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

function gymResult(r, label) {
  const dir = /artifact:\s*(\S+)/.exec(r.out)?.[1];
  const s = dir ? readJson(join(dir, "summary.json")) : null;
  if (!s) return { status: "red", summary: `${label}: no gym summary (exit ${r.status})`, metrics: {}, ms: r.ms };
  const t = s.totals;
  return {
    status: s.ok ? "green" : "red",
    summary: `${label}: ${t.passed}/${t.total} passed${t.failed ? `, ${t.failed} failed` : ""}${t.skipped ? `, ${t.skipped} skipped` : ""}`,
    metrics: { ...t },
    detail: { runDir: s.runDir, failed: (s.results ?? []).filter((x) => !x.passed && !x.skipped).map((x) => `${x.surface}/${x.id}`).slice(0, 40) },
    ms: r.ms,
  };
}

function phaseGym(ctx) {
  const surfaces = ctx.native ? "web,ios,android" : "web";
  const r = run("npm", ["run", "gym:locked", "--", "--surface", surfaces], { log: join(ctx.out, "gym.log") });
  return gymResult(r, surfaces);
}

function phaseParity(ctx) {
  const jsonPath = join(ctx.out, "parity.json");
  const fd = openSync(jsonPath, "w");
  const r = spawnSync("node", [join(ROOT, "scripts/parity-check.mjs"), "--json"], { cwd: ROOT, stdio: ["ignore", fd, "pipe"], encoding: "utf8" });
  closeSync(fd);
  const j = readJson(jsonPath);
  if (!j) return { status: "red", summary: `parity check crashed: ${(r.stderr ?? "").slice(0, 200)}`, metrics: {} };
  const md = openSync(join(ctx.out, "parity.md"), "w");
  spawnSync("node", [join(ROOT, "scripts/parity-check.mjs"), "--report"], { cwd: ROOT, stdio: ["ignore", md, "ignore"] });
  closeSync(md);
  const metrics = Object.fromEntries(j.checks.map((c) => [c.id, c.red]));
  metrics.featureAnchors = j.features.errors.length;
  const missing = Object.values(j.features.statusCounts ?? {}).reduce((n, s) => n + s.missing + s.partial, 0);
  metrics.missingOrPartialSurfaces = missing;
  const red = j.checks.filter((c) => c.red).map((c) => `${c.id} ${c.red}`);
  if (j.features.errors.length) red.push(`anchors ${j.features.errors.length}`);
  return {
    status: j.red ? "red" : "green",
    summary: `${j.red} red${red.length ? ` (${red.join(", ")})` : ""}; ${missing} feature surfaces missing/partial`,
    metrics,
  };
}

function phaseLive(ctx) {
  const refresh = join(ROOT, "scripts/gym-refresh.sh");
  if (!existsSync(refresh)) return { status: "na", summary: "not available (no scripts/gym-refresh.sh yet)", metrics: {} };
  const log = join(ctx.out, "live.log");
  const r1 = run("bash", [refresh], { log });
  if (r1.status !== 0) return { status: "red", summary: `gym-refresh.sh failed (exit ${r1.status})`, metrics: {}, ms: r1.ms };
  const surfaces = ctx.native ? "web,ios,android" : "web";
  return gymResult(run("npm", ["run", "gym:live", "--", "--surface", surfaces], { log }), `live ${surfaces}`);
}

const RUNNERS = { branches: phaseBranches, tsc: phaseTsc, vitest: phaseVitest, e2e: phaseE2e, gym: phaseGym, parity: phaseParity, live: phaseLive };
const TITLES = {
  branches: "Feature-branch drift",
  tsc: "Typecheck (tsc -b)",
  vitest: "Unit suite (vitest)",
  e2e: "Webapp e2e (Playwright + pod-sim)",
  gym: "Locked gym (mock-only)",
  parity: "Cross-client parity",
  live: "Live gym",
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function previousReport(resultsDir, current) {
  if (!existsSync(resultsDir)) return null;
  const dirs = readdirSync(resultsDir).filter((d) => d.startsWith("ready-") && d !== current).sort();
  for (const d of dirs.reverse()) {
    const j = readJson(join(resultsDir, d, "report.json"));
    if (j) return { dir: d, report: j };
  }
  return null;
}

/** Numeric metric changes since the previous report, e.g. "failed 3→1". */
export function delta(prev, cur) {
  if (!prev) return "new";
  const parts = [];
  if (prev.status !== cur.status) parts.push(`${prev.status}→${cur.status}`);
  for (const [k, v] of Object.entries(cur.metrics ?? {})) {
    const was = prev.metrics?.[k];
    if (typeof v === "number" && typeof was === "number" && was !== v) parts.push(`${k} ${was}→${v}`);
  }
  return parts.join(", ") || "same";
}

function table(results, prev) {
  const rows = results.map((r) => {
    const p = prev?.report.phases.find((x) => x.id === r.id);
    return [r.id, r.status.toUpperCase(), r.summary, r.status === "skipped" ? "" : delta(p, r)];
  });
  const head = ["Phase", "Status", "Result", `Delta vs ${prev?.dir ?? "(none)"}`];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function markdown(results, prev, meta) {
  const lines = [`# Release readiness ${meta.startedAt}`, "", `main at \`${meta.head}\`; phases: ${meta.phases.join(", ")}${meta.native ? " (native)" : ""}${meta.live ? " (live)" : ""}.`, ""];
  lines.push(`| Phase | Status | Result | Delta vs ${prev?.dir ?? "(none)"} |`, "|---|---|---|---|");
  for (const r of results) {
    const p = prev?.report.phases.find((x) => x.id === r.id);
    lines.push(`| ${TITLES[r.id]} | ${r.status.toUpperCase()} | ${r.summary.replace(/\|/g, "\\|")} | ${r.status === "skipped" ? "" : delta(p, r)} |`);
  }
  const branches = results.find((r) => r.id === "branches")?.detail;
  if (branches) {
    lines.push("", "## Branch drift", "", "| Branch | Parent | Behind | Ahead | Conflicts |", "|---|---|---:|---:|---:|");
    for (const b of branches) {
      lines.push(b.missing ? `| ${b.branch} | ${b.parent} | - | - | missing ${b.missing} |` : `| ${b.branch} | ${b.parent} | ${b.behind} | ${b.ahead} | ${b.conflicts}${b.conflicts ? `: ${b.conflictFiles.join(", ")}` : ""} |`);
    }
  }
  const vitest = results.find((r) => r.id === "vitest")?.detail?.failedFiles;
  if (vitest?.length) lines.push("", "## Failing test files", "", ...vitest.map((f) => `- ${f}`));
  for (const id of ["gym", "live"]) {
    const d = results.find((r) => r.id === id)?.detail;
    if (d?.failed?.length) lines.push("", `## ${TITLES[id]} failures (${d.runDir})`, "", ...d.failed.map((f) => `- ${f}`));
  }
  if (results.some((r) => r.id === "parity")) lines.push("", "Parity detail: `parity.md` in this folder (`npm run parity -- --report`).");
  lines.push("", "Logs for every phase are in this folder.");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function selectPhases(args) {
  const list = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? String(args[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;
  };
  const only = list("--only");
  const skip = list("--skip") ?? [];
  for (const p of [...(only ?? []), ...skip]) if (!PHASES.includes(p)) throw new Error(`unknown phase "${p}" (phases: ${PHASES.join(", ")})`);
  const live = args.includes("--live");
  const base = only ?? PHASES.filter((p) => p !== "live" || live);
  return base.filter((p) => !skip.includes(p));
}

async function main() {
  const args = process.argv.slice(2);
  const phases = selectPhases(args);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const resultsDir = join(ROOT, "gym-results");
  const dirName = `ready-${stamp}`;
  const out = join(resultsDir, dirName);
  mkdirSync(out, { recursive: true });
  const ctx = { out, native: args.includes("--native"), live: args.includes("--live"), noFetch: args.includes("--no-fetch") };
  const head = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
  const results = [];
  for (const id of PHASES) {
    if (!phases.includes(id)) continue;
    process.stderr.write(`[ready] ${id}…\n`);
    const t0 = Date.now();
    let r;
    try {
      r = await RUNNERS[id](ctx);
    } catch (e) {
      r = { status: "red", summary: `crashed: ${e.message}`, metrics: {} };
    }
    results.push({ id, title: TITLES[id], ms: Date.now() - t0, ...r });
    process.stderr.write(`[ready] ${id}: ${r.status} ${r.summary}\n`);
  }
  const prev = previousReport(resultsDir, dirName);
  const meta = { startedAt, head, phases, native: ctx.native, live: ctx.live };
  const report = { ...meta, finishedAt: new Date().toISOString(), red: results.filter((r) => r.status === "red").map((r) => r.id), phases: results };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "report.md"), markdown(results, prev, meta));
  console.log(`\n${table(results, prev)}\n\nreport: ${join(out, "report.md")}`);
  process.exitCode = report.red.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });
}
