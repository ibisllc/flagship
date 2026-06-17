#!/usr/bin/env -S npx tsx
/**
 * The gym CLI (§12-G3) — one command, then wait: runs a suite and prints
 * pass/fail + the path to the results artifact (summary.json + summary.txt +
 * screenshots).
 *
 *   gym every-merge [--surface web|ios|android] [--tier every-merge|total]
 *   gym total       [--surface ...]
 *
 * `every-merge` / `total` select the suite (the tier). `--surface` narrows to
 * one (or more, comma-separated) surface; default = all surfaces with a
 * scenario. `--tier` can override the suite's implied tier.
 *
 * Exit code = the DETERMINISTIC verdict (0 = gate green, 1 = a scenario failed
 * or nothing ran). AI findings are advisory and never affect the exit code.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Surface, Tier } from "./scenario.js";
import { ALL_SCENARIOS } from "./suites.js";
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
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const suite = positional[0] ?? "every-merge";
  let tier: Tier = suite === "total" ? "total" : "every-merge";
  let surfaces: Surface[] | undefined;

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
  return surfaces ? { suite, tier, surfaces } : { suite, tier };
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

  const summary = await runGym(ALL_SCENARIOS, {
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
