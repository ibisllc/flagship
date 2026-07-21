#!/usr/bin/env -S npx tsx
/**
 * The gym CLI (§12-G3) — one command, then wait: runs a suite and prints
 * pass/fail + the path to the results artifact (summary.json + summary.txt +
 * screenshots).
 *
 *   gym every-merge [--surface web|ios|android] [--tier every-merge|total]
 *   gym total       [--surface ...] [--mock-only]
 *   gym live        [--surface ...]   # ONLY the live Tier-2 slice (§12-G6)
 *
 * `every-merge` / `total` select the suite (the tier). `total` also folds in the
 * LIVE Tier-2 slice, which SKIPS cleanly when the `gym.` env isn't reachable
 * (`gym:total` stays green with no env). `live` runs ONLY the live slice.
 * `--mock-only` EXCLUDES the live slice entirely — the run is purely the
 * deterministic fixture matrix with NO backend + NO env probe (this is what the
 * `gym:locked` one-liner uses for the fast, no-cloud comprehensive gate).
 * `--surface` narrows to one (or more, comma-separated) surface; default = all
 * surfaces with a scenario. `--tier` can override the suite's implied tier.
 *
 * Exit code = the DETERMINISTIC verdict (0 = gate green, 1 = a scenario failed
 * or nothing ran). AI findings are advisory and never affect the exit code.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Scenario, Surface, Tier } from "./scenario.js";
import { ALL_SCENARIOS } from "./suites.js";
import { LIVE_SCENARIOS, liveEnvReachable } from "./live.js";
import { runGym } from "./runner.js";
import { WebAdapter } from "./adapters/web.js";
import { IosAdapter } from "./adapters/ios.js";
import { AndroidAdapter } from "./adapters/android.js";
import { resolveAiHooks } from "./ai/byokSeam.js";
import { renderText } from "./results.js";

/** Walk up from this file to the repo root (the dir holding package.json + tools/). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "tools"))) return dir;
    dir = dirname(dir);
  }
  // Fallback: tools/gym/src → repo root is three up.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

interface ParsedArgs {
  suite: string;
  tier: Tier;
  surfaces?: Surface[];
  mockOnly: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const suite = positional[0] ?? "every-merge";
  // `live` and `total` both imply the `total` tier (the live slice is tier:total);
  // `live` additionally narrows the SELECTION to live-only (see main()).
  let tier: Tier = suite === "total" || suite === "live" ? "total" : "every-merge";
  let surfaces: Surface[] | undefined;
  // --mock-only drops the live slice entirely (no backend, no env probe) — the
  // `gym:locked` no-cloud gate. Ignored for `live` (which IS the live slice).
  const mockOnly = argv.includes("--mock-only");

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--tier") {
      const v = argv[++i];
      if (v === "total" || v === "every-merge") tier = v;
    } else if (a.startsWith("--tier=")) {
      const v = a.slice("--tier=".length);
      if (v === "total" || v === "every-merge") tier = v;
    } else if (a === "--surface") {
      surfaces = parseSurfaces(argv[++i]);
    } else if (a.startsWith("--surface=")) {
      surfaces = parseSurfaces(a.slice("--surface=".length));
    }
  }
  return surfaces ? { suite, tier, surfaces, mockOnly } : { suite, tier, mockOnly };
}

function parseSurfaces(v: string | undefined): Surface[] | undefined {
  if (!v) return undefined;
  const valid: Surface[] = ["web", "ios", "android"];
  const out = v
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Surface => (valid as string[]).includes(s));
  return out.length ? out : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();

  // Scenario set per suite:
  //  - live: ONLY the live slice.
  //  - --mock-only: the fixture tranches ALONE (no live slice → no backend, no env
  //    probe). The `gym:locked` no-cloud comprehensive gate.
  //  - every-merge / total: the fixture tranches (ALL_SCENARIOS) + the live slice,
  //    which the runner SKIPS cleanly when the `gym.` env is unreachable (§12-G6).
  const scenarios: readonly Scenario[] =
    args.suite === "live"
      ? LIVE_SCENARIOS
      : args.mockOnly
        ? [...ALL_SCENARIOS]
        : [...ALL_SCENARIOS, ...LIVE_SCENARIOS];

  const summary = await runGym(scenarios, {
    repoRoot,
    suite: args.suite,
    tier: args.tier,
    ...(args.surfaces ? { surfaces: args.surfaces } : {}),
    adapters: {
      web: new WebAdapter(),
      ios: new IosAdapter(),
      android: new AndroidAdapter(),
    },
    aiHooks: resolveAiHooks(),
    // The live-env gate: ping <control-apex>/api/health (default gym.flagshipserver.com).
    // Resolved at most once, only when a live scenario is selected.
    liveEnvCheck: async () => {
      const probe = await liveEnvReachable();
      return { reachable: probe.reachable, reason: probe.reason };
    },
  });

  // One command, then wait → the summary + the artifact path.
  console.log("\n" + renderText(summary)); // eslint-disable-line no-console
  console.log(`\nartifact: ${summary.runDir}`); // eslint-disable-line no-console
  console.log(`  summary.json + summary.txt + screenshots/`); // eslint-disable-line no-console

  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("gym runner crashed:", e); // eslint-disable-line no-console
  process.exit(2);
});
