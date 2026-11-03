/**
 * What root looks at itself to decide the owner's switch on trial (archV2Switch.ts
 * settleSwitchAsRoot): systemd's numbering of the daemon's runs, the engines' own container
 * lists, root's engine record and its own attempt at the engine move, and the Rust units' state.
 * None of it is a file the daemon writes as a verdict (review 2026-10-25 #5).
 */
import { existsSync } from "node:fs";
import type { RootTrialProbes } from "./archV2Switch.js";
import { LABEL_SERVICE } from "./endpoints.js";
import { loadArchV2Config, rootEngine } from "./engine/engine.js";
import { migrateDockerToPodman, readMigrationMarker, rollbackToDocker } from "./engine/migrate.js";
import { rustStackRegressions } from "./rustStack/install.js";
import type { CommandRunner } from "./serviceRunner.js";

export const DAEMON_UNIT = "flagship-daemon.service";
/** The network live apps join (staging copies use flagship-staging and never come back after a move). */
export const LIVE_APP_NETWORK = "flagship-apps";

export function rootTrialProbes(o: { cmd: Required<CommandRunner>; log?: (m: string) => void }): RootTrialProbes {
  const deps = { cmd: o.cmd, exists: existsSync, ...(o.log ? { log: o.log } : {}) };
  return {
    daemonStart: async () => {
      const id = (await o.cmd.capture("systemctl", ["show", "-p", "InvocationID", "--value", DAEMON_UNIT])).stdout.trim();
      return /^[0-9a-f]{32}$/.test(id) ? id : null;
    },
    listApps: async (engine) =>
      (await o.cmd.capture(engine, ["ps", "--filter", `label=${LABEL_SERVICE}`, "--filter", `network=${LIVE_APP_NETWORK}`, "--format", "{{.Names}}"])).stdout
        .split("\n")
        .map((n) => n.trim())
        .filter(Boolean)
        .sort(),
    activeEngine: async () => rootEngine(),
    ensureEngine: async (engine) => {
      if (engine === "podman") {
        const m = await migrateDockerToPodman(deps);
        return m.ok ? { ok: true } : { ok: false, reason: m.reason };
      }
      const marker = await readMigrationMarker(deps);
      return marker?.result === "migrated" ? rollbackToDocker(deps) : { ok: true };
    },
    stackProblems: async (target) => (target === "arch-v2" ? rustStackRegressions({ config: loadArchV2Config() }) : []),
  };
}
