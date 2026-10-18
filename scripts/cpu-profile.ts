// Workers CPU profile of the hot `.com` routes (docs/runbooks/final-deploy.md,
// "Workers CPU budget (Free plan)").
//
//   npx tsc -b && npx tsx scripts/cpu-profile.ts                 # table
//   npx tsx scripts/cpu-profile.ts --only directory,pods --runs 60
//   npx tsx scripts/cpu-profile.ts --json > cpu.json
//   node --cpu-prof --cpu-prof-dir=/tmp/cpu --import tsx scripts/cpu-profile.ts --only directory --runs 200
//       then open the .cpuprofile in Chrome DevTools (Performance > Load profile)
//
// Needs `npx tsc -b` first: the workspace packages are read from dist/.
// Nothing here touches the network or any real account.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SCENARIOS,
  WORKERS_FREE_CPU_LIMIT_MS,
  calibrationMs,
  measureScenario,
  type Measure,
} from "./cpuHarness.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const only = value("--only")?.split(",");
const runs = Number(value("--runs") ?? 25);
const warmup = Number(value("--warmup") ?? 6);
const json = flag("--json");
const coldRuns = Number(value("--cold") ?? 0);

const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
if (scenarios.length === 0) {
  console.error(`no scenario matches ${only?.join(",")}; known: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}

const calib = await calibrationMs();
const rows: Measure[] = [];
for (const sc of scenarios) rows.push(await measureScenario(sc, { runs, warmup }));

// Cold: the FIRST request a fresh process serves (lazy compilation, cold
// inline caches), one child per sample. A Free-plan Worker serves most of its
// requests from isolates this young, so this is the number that meets the limit.
const cold = new Map<string, { cpu: number; js: number }>();
if (coldRuns > 0) {
  const self = fileURLToPath(import.meta.url);
  for (const sc of scenarios) {
    const cpu: number[] = [];
    const js: number[] = [];
    for (let i = 0; i < coldRuns; i++) {
      const out = spawnSync(
        process.execPath,
        ["--import", "tsx", self, "--only", sc.id, "--runs", "1", "--warmup", "0", "--json"],
        { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
      );
      const parsed = JSON.parse(out.stdout) as { rows: Measure[] };
      cpu.push(parsed.rows[0]!.cpuMs);
      js.push(parsed.rows[0]!.jsMs);
    }
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    cold.set(sc.id, { cpu: med(cpu), js: med(js) });
  }
}

if (json) {
  console.log(
    JSON.stringify(
      {
        calibrationMs: calib,
        limitMs: WORKERS_FREE_CPU_LIMIT_MS,
        rows: rows.map((r) => ({ ...r, cold: cold.get(r.id) ?? null })),
      },
      null,
      2,
    ),
  );
} else {
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`calibration loop: ${calib.toFixed(2)} ms   Workers Free CPU limit: ${WORKERS_FREE_CPU_LIMIT_MS} ms/request`);
  if (flag("--sql")) {
    for (const r of rows) {
      console.log(`\n== ${r.id}: ${r.d1Calls} D1 calls`);
      r.sql.forEach((q, i) => console.log(`  ${i + 1}. ${q.replace(/\s+/g, " ").slice(0, 180)}`));
    }
    console.log();
  }
  console.log(
    `${pad("scenario", 20)} ${pad("warm js", 8)} ${pad("warm cpu", 9)} ${pad("cold js", 8)} ${pad("d1", 4)}  route`,
  );
  for (const r of rows) {
    const c = cold.get(r.id);
    const flagged = Math.max(r.jsMs, c?.js ?? 0) > 7 ? "  <-- over 7 ms" : "";
    console.log(
      `${pad(r.id, 20)} ${pad(r.jsMs.toFixed(2), 8)} ${pad(r.cpuMs.toFixed(2), 9)} ${pad(c ? c.js.toFixed(2) : "-", 8)} ${pad(String(r.d1Calls), 4)}  ${r.label}${flagged}`,
    );
  }
}
