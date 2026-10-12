/**
 * What an app's container is doing, for the owner's status pill
 * (docs/app-placement.md §6). Read for every app at once with one
 * `docker ps`, cached briefly, so a list of many apps costs one call.
 * Owner-facing only: nothing here is ever handed to a model.
 */

import type { CommandRunner } from "./serviceRunner.js";

export type AppRunState = "running" | "starting" | "stopped" | "unknown";

const DOCKER_PS_ARGS = [
  "ps",
  "-a",
  "--filter",
  "name=flagship-",
  "--format",
  "{{.Names}}\t{{.State}}\t{{.Status}}",
];

/** A container's `{{.State}}` and `{{.Status}}` as the pill reads them. */
export function runStateOf(state: string, status: string): AppRunState {
  switch (state.trim().toLowerCase()) {
    case "running":
      return /\(health: starting\)/i.test(status) ? "starting" : "running";
    case "restarting":
      return "starting";
    default:
      return "stopped";
  }
}

/** `docker ps` output → state per container name. */
export function parseDockerPs(stdout: string): Map<string, AppRunState> {
  const out = new Map<string, AppRunState>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [names = "", state = "", status = ""] = line.split("\t");
    const s = runStateOf(state, status);
    for (const n of names.split(",")) if (n.trim()) out.set(n.trim().replace(/^\//, ""), s);
  }
  return out;
}

export interface AppStatusSource {
  statuses(serviceIds: readonly string[]): Promise<Map<string, AppRunState>>;
}

/**
 * `statuses` asks Docker at most once per `ttlMs` (callers in that window,
 * and callers while a call is under way, share its answer). Docker not
 * answering within `timeoutMs`, or not at all, makes every app `unknown`;
 * an app with no container while Docker answered is `stopped`.
 */
export function buildAppStatusReader(opts: {
  cmd: CommandRunner;
  containerName: (serviceId: string) => string;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}): AppStatusSource {
  const ttlMs = opts.ttlMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? (() => Date.now());
  let cached: { at: number; states: Map<string, AppRunState> | null } | null = null;
  let inFlight: Promise<Map<string, AppRunState> | null> | null = null;

  const ask = async (): Promise<Map<string, AppRunState> | null> => {
    if (!opts.cmd.capture) return null;
    try {
      const { stdout } = await opts.cmd.capture("docker", DOCKER_PS_ARGS, { timeoutMs });
      return parseDockerPs(stdout);
    } catch {
      return null;
    }
  };

  const snapshot = (): Promise<Map<string, AppRunState> | null> => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.states);
    if (inFlight) return inFlight;
    inFlight = ask().then((states) => {
      cached = { at: now(), states };
      inFlight = null;
      return states;
    });
    return inFlight;
  };

  return {
    async statuses(serviceIds) {
      const out = new Map<string, AppRunState>();
      if (serviceIds.length === 0) return out;
      const states = await snapshot();
      for (const id of serviceIds) {
        out.set(id, states ? states.get(opts.containerName(id)) ?? "stopped" : "unknown");
      }
      return out;
    },
  };
}
