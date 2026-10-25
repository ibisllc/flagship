/**
 * Runs the GPU live groups on their own (they need no fleet box and no gym Worker):
 *
 *   npx tsx tools/live-e2e/gpu-group-cli.ts gpu-sim [out dir]
 *   npx tsx tools/live-e2e/gpu-group-cli.ts gpu-real [out dir]
 *
 * The same groups run inside `shared-run.ts --groups gpu-sim,gpu-real`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Recorder } from "./lib/harness.js";
import { gpuReal } from "./groups/release03/gpuReal.js";
import { gpuSim } from "./groups/release03/gpuSim.js";
import type { GroupCtx } from "./groups/types.js";

const name = process.argv[2] ?? "gpu-sim";
const group = name === "gpu-real" ? gpuReal : gpuSim;
const dir = process.argv[3] ?? join(tmpdir(), `gpu-group-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const rec = new Recorder(group.name);
const unused = () => {
  throw new Error("the GPU groups use no fleet box");
};
const ctx = { rec, dir, box: unused, groupOk: () => false, adopt: unused } as unknown as GroupCtx;
await group.run(ctx);
writeFileSync(join(dir, "results.json"), JSON.stringify(rec.results, null, 2));
process.stdout.write(`${group.name}: ${rec.passed} passed, ${rec.failed} failed, ${rec.skipped} skipped (results in ${dir})\n`);
process.exit(rec.failed ? 1 : 0);
