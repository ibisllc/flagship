#!/usr/bin/env -S npx tsx
// The live backend e2e is the `core` group of the shared-fleet runner
// (tools/live-e2e/shared-run.ts), which provisions on UpCloud and always tears
// down. This entry point stays for scripts and habits that call it.
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["tsx", "tools/live-e2e/shared-run.ts", "--groups", "core", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 2);
