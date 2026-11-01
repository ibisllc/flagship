/**
 * The executor wired to this box (runtime.ts): core's socket, the engine's containers, the app
 * and model-server networks, and the removal of exactly one generation of a workload.
 */
import type { AppRunner, CommandRunner } from "../serviceRunner.js";
import { stopEndpoint } from "../serviceRunner.js";
import { CoreOwnership, networksFor, observeContainers, observeEngine, type ReconcilerMode } from "./coreOwnership.js";

export function createBoxCoreOwnership(o: { cmd: CommandRunner; runner: AppRunner; mode: () => ReconcilerMode; log?: (m: string) => void }): CoreOwnership {
  let occupied: Array<{ network: string; ip: string }> = [];
  const core = new CoreOwnership({
    mode: o.mode,
    observe: async () => {
      const r = await observeEngine(o.cmd);
      occupied = r.occupied;
      return r.observed;
    },
    occupied: async () => occupied,
    networks: () => networksFor(o.cmd, ["flagship-apps", "flagship-staging"]),
    removeContainer: async (w) => {
      if (w.installation !== "local-ai") return o.runner.removeOwned(w);
      // The model server's name changes with every start: find the one of this generation.
      const c = (await observeContainers(o.cmd)).find((x) => x.installation === "local-ai" && x.generation === w.generation);
      if (!c) return;
      stopEndpoint("local-ai", "staging", w.component);
      await o.cmd.run("docker", ["rm", "-f", c.name]);
    },
    ...(o.log ? { log: o.log } : {}),
  });
  core.start();
  return core;
}
