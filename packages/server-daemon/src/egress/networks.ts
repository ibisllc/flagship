/**
 * The three sandbox bridges, each created with a fixed Linux interface name
 * (`com.docker.network.bridge.name`) so the firewall can name it. A network
 * left over from before (created without the option, bridge `br-<id>`) is
 * recreated: its containers are disconnected first, which is harmless at boot
 * because ServicePlatform.restore recreates every app container anyway. The
 * build bridge is also recreated when it isn't `--internal`, and any bridge
 * that still lets its containers reach each other (`enable_icc`). When recreating
 * fails, the existing bridge's real name is used instead.
 */
import type { CommandRunner } from "../serviceRunner.js";
import { EGRESS_NETWORKS, type EgressNetworkSpec } from "./policy.js";
import { PODMAN_ICC_LABEL, activeEngine } from "../engine/engine.js";
import { installIccIsolation, type FirewallBridge } from "./firewall.js";

export const BRIDGE_NAME_OPTION = "com.docker.network.bridge.name";
export const ICC_OPTION = "com.docker.network.bridge.enable_icc";

export interface NetworkInfo {
  id: string;
  name: string;
  /** The Linux bridge interface carrying it. */
  bridge: string;
  internal: boolean;
  /** Containers on it can reach each other (docker's default). */
  icc: boolean;
  subnets: string[];
  gateways: string[];
  containers: Array<{ name: string; ipv4: string }>;
}

/** `docker network create` args; a sandbox network gets its fixed bridge name. */
export function networkCreateArgs(
  network: string,
  spec: EgressNetworkSpec | undefined = EGRESS_NETWORKS.find((n) => n.network === network),
): string[] {
  if (!spec) return ["network", "create", network];
  return [
    "network",
    "create",
    "--driver",
    "bridge",
    ...(spec.internal ? ["--internal"] : []),
    "-o",
    `${BRIDGE_NAME_OPTION}=${spec.bridge}`,
    ...(spec.icc ? [] : ["-o", `${ICC_OPTION}=false`]),
    network,
  ];
}

interface RawNetwork {
  Id?: string;
  Name?: string;
  Internal?: boolean;
  Options?: Record<string, string> | null;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> | null } | null;
  Containers?: Record<string, { Name?: string; IPv4Address?: string }> | null;
}

/** `podman network inspect --format {{json .}}` (netavark's lower-case shape). */
interface RawPodmanNetwork {
  name?: string;
  id?: string;
  network_interface?: string;
  internal?: boolean;
  labels?: Record<string, string> | null;
  subnets?: Array<{ subnet?: string; gateway?: string }> | null;
  containers?: Record<string, { name?: string; interfaces?: Record<string, { subnets?: Array<{ ipnet?: string }> | null }> | null }> | null;
}

function parsePodmanNetwork(n: RawPodmanNetwork): NetworkInfo | null {
  if (!n.id || !n.name) return null;
  const subnets = n.subnets ?? [];
  return {
    id: n.id,
    name: n.name,
    bridge: n.network_interface ?? "",
    internal: n.internal === true,
    icc: n.labels?.[PODMAN_ICC_LABEL] !== "false",
    subnets: subnets.map((c) => c.subnet ?? "").filter((x) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(x)),
    gateways: subnets.map((c) => c.gateway ?? "").filter((g) => /^\d+\.\d+\.\d+\.\d+$/.test(g)),
    containers: Object.values(n.containers ?? {}).map((c) => {
      const first = Object.values(c.interfaces ?? {})[0]?.subnets?.[0]?.ipnet ?? "";
      return { name: c.name ?? "", ipv4: first.split("/")[0]! };
    }),
  };
}

export function parseNetworkInspect(json: string): NetworkInfo | null {
  let raw: RawNetwork | RawNetwork[];
  try {
    raw = JSON.parse(json) as RawNetwork | RawNetwork[];
  } catch {
    return null;
  }
  const n = Array.isArray(raw) ? raw[0] : raw;
  if (n && !n.Id && typeof (n as RawPodmanNetwork).id === "string") return parsePodmanNetwork(n as RawPodmanNetwork);
  if (!n?.Id || !n.Name) return null;
  const configs = n.IPAM?.Config ?? [];
  return {
    id: n.Id,
    name: n.Name,
    bridge: n.Options?.[BRIDGE_NAME_OPTION] ?? `br-${n.Id.slice(0, 12)}`,
    internal: n.Internal === true,
    icc: n.Options?.[ICC_OPTION] !== "false",
    subnets: configs.map((c) => c.Subnet ?? "").filter((s) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s)),
    gateways: configs.map((c) => c.Gateway ?? "").filter((g) => /^\d+\.\d+\.\d+\.\d+$/.test(g)),
    containers: Object.values(n.Containers ?? {}).map((c) => ({
      name: c.Name ?? "",
      ipv4: (c.IPv4Address ?? "").split("/")[0]!,
    })),
  };
}

export async function inspectNetwork(cmd: CommandRunner, network: string): Promise<NetworkInfo | null> {
  if (!cmd.capture) throw new Error("CommandRunner.capture is required");
  try {
    const { stdout } = await cmd.capture("docker", ["network", "inspect", network, "--format", "{{json .}}"]);
    return parseNetworkInspect(stdout.trim());
  } catch {
    return null;
  }
}

/** Create or migrate one sandbox network; returns what it ended up as. */
export async function ensureSandboxNetwork(
  cmd: CommandRunner,
  spec: EgressNetworkSpec,
  log: (m: string) => void = () => {},
): Promise<NetworkInfo> {
  let info = await inspectNetwork(cmd, spec.network);
  if (info && (info.bridge !== spec.bridge || info.internal !== spec.internal || info.icc !== spec.icc)) {
    const old = info;
    log(
      `[egress] recreating ${spec.network} on bridge ${spec.bridge}${spec.internal ? " (internal)" : ""}${spec.icc ? "" : " (containers isolated)"} (was ${old.bridge}${old.internal ? ", internal" : ""}${old.icc ? ", containers connected" : ""})`,
    );
    try {
      for (const c of old.containers) {
        if (c.name) await cmd.run("docker", ["network", "disconnect", "-f", spec.network, c.name]).catch(() => {});
      }
      await cmd.run("docker", ["network", "rm", spec.network]);
    } catch (e) {
      log(`[egress] could not recreate ${spec.network} (${(e as Error).message}); fencing its current bridge ${old.bridge}`);
      return old;
    }
    info = null;
  }
  if (!info) {
    await cmd.run("docker", networkCreateArgs(spec.network, spec)).catch(() => {});
    info = await inspectNetwork(cmd, spec.network);
    if (!info) throw new Error(`docker network ${spec.network} could not be created`);
  }
  return info;
}

/**
 * Without the gateway (FLAGSHIP_EGRESS=off, or it couldn't start) the bridges
 * keep their fixed names but nothing is internal, so builds can still fetch
 * packages: the old, unfenced behaviour.
 */
export async function ensureUnfencedNetworks(cmd: CommandRunner, log: (m: string) => void = () => {}): Promise<void> {
  const isolated: FirewallBridge[] = [];
  for (const spec of EGRESS_NETWORKS) {
    const info = await ensureSandboxNetwork(cmd, { ...spec, internal: false }, log).catch((e) => {
      log(`[egress] could not ensure ${spec.network}: ${(e as Error).message}`);
      return null;
    });
    if (info && !spec.icc && info.bridge) isolated.push({ kind: spec.kind, bridge: info.bridge });
  }
  if (activeEngine() === "podman" && isolated.length > 0) {
    await installIccIsolation(cmd, isolated).catch((e) => log(`[egress] containers on one bridge are NOT isolated: ${(e as Error).message}`));
  }
}
