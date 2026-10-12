/**
 * What docker invocations need from a running egress gateway, set once it
 * enforces (null until then, so a box without it keeps the old arguments).
 * serviceRunner reads it for every `docker run` and `docker build`, so every
 * AppRunner (live apps, staging copies) gets it without being told.
 */
export interface SandboxNetworkingState {
  /** Docker network name → its bridge gateway IP (where the gateway listens). */
  gateways: ReadonlyMap<string, string>;
  /** Registry hosts a build may fetch from, pinned to the build gateway. */
  buildHosts: readonly string[];
}

let state: SandboxNetworkingState | null = null;
let containersChanged: (() => Promise<void>) | null = null;

export function setSandboxNetworking(s: SandboxNetworkingState | null): void {
  state = s;
}

export function sandboxGateway(network: string): string | null {
  return state?.gateways.get(network) ?? null;
}

/**
 * `docker run` args for a container on `network`: DNS through the gateway's
 * filter (an explicit non-loopback --dns makes docker's embedded resolver
 * forward from the container's own namespace, where the firewall redirects
 * it), and the data-store alias on the gateway, which forwards the data ports
 * to the host's loopback-only services. Null when the gateway isn't enforcing.
 */
export function sandboxRunArgs(network: string, dataHostAlias: string): string[] | null {
  const gw = sandboxGateway(network);
  if (!gw) return null;
  return ["--dns", gw, "--add-host", `${dataHostAlias}:${gw}`];
}

/** `docker build` args: the build bridge has no DNS, so pin each registry host. */
export function sandboxBuildArgs(network: string): string[] {
  const gw = sandboxGateway(network);
  if (!gw || !state) return [];
  return state.buildHosts.filter((h) => !h.startsWith("*.")).flatMap((h) => ["--add-host", `${h}:${gw}`]);
}

/** The gateway re-reads which container holds which IP when this fires. */
export function setContainersChangedHook(fn: (() => Promise<void>) | null): void {
  containersChanged = fn;
}

/**
 * A container was started or removed. AppRunner awaits this before and after
 * `docker run`, so an IP a stopped app left behind is never judged by that
 * app's approvals once another container holds it.
 */
export async function notifyContainersChanged(): Promise<void> {
  if (!containersChanged) return;
  await containersChanged().catch(() => {});
}
