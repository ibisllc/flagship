#!/usr/bin/env node
// Thin shell wrapper — the real CLI lives in src/cli.ts.
//
// We always re-launch via the workspace's `tsx` so the TS-aware
// resolver follows the `@flagship/*` workspace package `main:./src/*.ts`
// entrypoints without any explicit build step. (Plain `node` with its
// experimental type-stripping does not rewrite the `.js` extensions our
// TS source files use to point at sibling `.ts` modules, so it cannot
// resolve `@flagship/protocol` here without a build artifact.)

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const srcMain = resolve(here, "..", "src", "cli.ts");

// Walk upward looking for a `node_modules/.bin/tsx` — works from this
// repo's worktrees and from a hoisted npm install.
function findTsx(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const tsx = findTsx(here);
if (!tsx) {
  process.stderr.write(
    "personalize-iso: could not locate `tsx` in any parent `node_modules/.bin/`.\n" +
      "Run `npm install` at the repo root and try again.\n",
  );
  process.exit(127);
}

const child = spawn(tsx, [srcMain, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
