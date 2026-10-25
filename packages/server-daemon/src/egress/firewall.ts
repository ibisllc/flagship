/**
 * Host firewall for the egress gateway. Our own chains, hooked from
 * DOCKER-USER (forwarded traffic), INPUT (traffic to the host) and nat
 * PREROUTING (the redirects), so docker's rules are never edited:
 *
 *   nat  FLAGSHIP-EGRESS-NAT   -i <bridge> tcp/80, tcp/443, udp+tcp/53 → the gateway's ports
 *   filter FLAGSHIP-EGRESS-FWD -i <bridge>: only replies, and docker-published data ports; reject the rest
 *   filter FLAGSHIP-EGRESS-IN  -i <bridge>: replies, the gateway's ports, the data-service ports
 *                              (apps + staging only); reject the rest
 *   ip6 filter FLAGSHIP-EGRESS6 -i <bridge>: reject (the bridges are IPv4-only)
 *
 * The chains are written with one `iptables-restore --noflush` per table, so
 * they are replaced atomically (a restore flushes the chains it declares and
 * nothing else); re-running at boot is idempotent. The rules survive a daemon
 * restart, so while the gateway is down the bridges fail closed.
 */
import { writeFile } from "node:fs/promises";
import { privd, runDir, runsUnprivileged } from "../privileged.js";
import type { CommandRunner } from "../serviceRunner.js";
import type { EgressNetworkKind } from "./policy.js";
import { activeEngine, type EngineKind } from "../engine/engine.js";

export interface FirewallBridge {
  bridge: string;
  kind: EgressNetworkKind;
}

export interface FirewallPorts {
  tls: number;
  http: number;
  dns: number;
}

export interface FirewallPlan {
  bridges: readonly FirewallBridge[];
  ports: FirewallPorts;
  /** Host data-service ports apps and staging may reach (Postgres). */
  dataPorts: readonly number[];
}

export const CHAIN_NAT = "FLAGSHIP-EGRESS-NAT";
export const CHAIN_FWD = "FLAGSHIP-EGRESS-FWD";
export const CHAIN_IN = "FLAGSHIP-EGRESS-IN";
export const CHAIN_V6 = "FLAGSHIP-EGRESS6";

/** Parent chain → our chain, per table. */
export const HOOKS: ReadonlyArray<{ bin: "iptables" | "ip6tables"; table: string; parent: string; chain: string }> = [
  { bin: "iptables", table: "nat", parent: "PREROUTING", chain: CHAIN_NAT },
  { bin: "iptables", table: "filter", parent: "DOCKER-USER", chain: CHAIN_FWD },
  { bin: "iptables", table: "filter", parent: "INPUT", chain: CHAIN_IN },
  { bin: "ip6tables", table: "filter", parent: "FORWARD", chain: CHAIN_V6 },
  { bin: "ip6tables", table: "filter", parent: "INPUT", chain: CHAIN_V6 },
];

/**
 * Under Podman there is no DOCKER-USER: our forward chain hangs off FORWARD itself, ahead of
 * netavark's own rules (iptables or nftables driver, either way a separate accept that cannot
 * override our reject).
 */
export function hooksFor(engine: EngineKind): typeof HOOKS {
  if (engine === "docker") return HOOKS;
  return HOOKS.map((h) => (h.parent === "DOCKER-USER" ? { ...h, parent: "FORWARD" } : h));
}

/** The nft table that keeps containers on one bridge from reaching each other (Docker's enable_icc=false). */
export const ICC_TABLE = "flagship_icc";

/**
 * Podman has no enable_icc. Frames forwarded port to port on a sandbox bridge are dropped in the
 * bridge family's forward hook; traffic to the gateway (the bridge's own address) is delivered
 * locally and never passes this hook, so the egress gateway stays reachable.
 */
export function renderIccTable(bridges: readonly FirewallBridge[]): string {
  for (const b of bridges) {
    if (!IFACE.test(b.bridge)) throw new Error(`bad bridge interface name ${JSON.stringify(b.bridge)}`);
  }
  const rules = bridges.map((b) => `    meta ibrname "${b.bridge}" meta obrname "${b.bridge}" counter drop`);
  return [
    `table bridge ${ICC_TABLE}`,
    `delete table bridge ${ICC_TABLE}`,
    `table bridge ${ICC_TABLE} {`,
    "  chain forward {",
    "    type filter hook forward priority -100; policy accept;",
    ...rules,
    "  }",
    "}",
    "",
  ].join("\n");
}

const IFACE = /^[a-zA-Z0-9_.-]{1,15}$/;

/** The iptables-restore payloads (IPv4 and IPv6). Pure, for tests. */
export function renderFirewall(plan: FirewallPlan): { v4: string; v6: string } {
  for (const b of plan.bridges) {
    if (!IFACE.test(b.bridge)) throw new Error(`bad bridge interface name ${JSON.stringify(b.bridge)}`);
  }
  const { tls, http, dns } = plan.ports;
  const data = plan.dataPorts.join(",");
  const nat: string[] = [];
  const fwd: string[] = [];
  const inp: string[] = [];
  const v6: string[] = [];
  for (const { bridge: b, kind } of plan.bridges) {
    const reachesData = kind !== "build" && plan.dataPorts.length > 0;
    nat.push(
      `-A ${CHAIN_NAT} -i ${b} -p tcp --dport 443 -j REDIRECT --to-ports ${tls}`,
      `-A ${CHAIN_NAT} -i ${b} -p tcp --dport 80 -j REDIRECT --to-ports ${http}`,
      `-A ${CHAIN_NAT} -i ${b} -p udp --dport 53 -j REDIRECT --to-ports ${dns}`,
      `-A ${CHAIN_NAT} -i ${b} -p tcp --dport 53 -j REDIRECT --to-ports ${dns}`,
    );
    fwd.push(`-A ${CHAIN_FWD} -i ${b} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`);
    if (reachesData) {
      fwd.push(`-A ${CHAIN_FWD} -i ${b} -p tcp -m multiport --dports ${data} -m conntrack --ctstate DNAT -j RETURN`);
    }
    fwd.push(
      `-A ${CHAIN_FWD} -i ${b} -p tcp -j REJECT --reject-with tcp-reset`,
      `-A ${CHAIN_FWD} -i ${b} -j REJECT --reject-with icmp-admin-prohibited`,
    );
    inp.push(
      `-A ${CHAIN_IN} -i ${b} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
      `-A ${CHAIN_IN} -i ${b} -p tcp -m multiport --dports ${tls},${http},${dns} -j ACCEPT`,
      `-A ${CHAIN_IN} -i ${b} -p udp --dport ${dns} -j ACCEPT`,
    );
    if (reachesData) inp.push(`-A ${CHAIN_IN} -i ${b} -p tcp -m multiport --dports ${data} -j ACCEPT`);
    inp.push(
      `-A ${CHAIN_IN} -i ${b} -p tcp -j REJECT --reject-with tcp-reset`,
      `-A ${CHAIN_IN} -i ${b} -j REJECT --reject-with icmp-admin-prohibited`,
    );
    v6.push(`-A ${CHAIN_V6} -i ${b} -j REJECT`);
  }
  fwd.push(`-A ${CHAIN_FWD} -j RETURN`);
  inp.push(`-A ${CHAIN_IN} -j RETURN`);
  v6.push(`-A ${CHAIN_V6} -j RETURN`);
  const v4 = [
    "*nat",
    `:${CHAIN_NAT} - [0:0]`,
    ...nat,
    "COMMIT",
    "*filter",
    `:${CHAIN_FWD} - [0:0]`,
    `:${CHAIN_IN} - [0:0]`,
    ...fwd,
    ...inp,
    "COMMIT",
    "",
  ].join("\n");
  const v6s = ["*filter", `:${CHAIN_V6} - [0:0]`, ...v6, "COMMIT", ""].join("\n");
  return { v4, v6: v6s };
}

async function ok(cmd: CommandRunner, bin: string, args: string[]): Promise<boolean> {
  try {
    if (cmd.capture) await cmd.capture(bin, ["-w", ...args]);
    else await cmd.run(bin, ["-w", ...args]);
    return true;
  } catch {
    return false;
  }
}

export interface InstallFirewallOptions {
  /** Where to stage the restore payloads (tmpfs). */
  rulesDir?: string;
  log?: (m: string) => void;
  engine?: EngineKind;
}

/**
 * Install (or refresh) the chains and their hooks. Throws when the IPv4 rules
 * can't be installed; IPv6 is best-effort (a host without ip6tables has no
 * IPv6 forwarding to fence).
 */
export async function installFirewall(cmd: CommandRunner, plan: FirewallPlan, opts: InstallFirewallOptions = {}): Promise<void> {
  const dir = opts.rulesDir ?? runDir();
  const engine = opts.engine ?? activeEngine();
  const hooks = hooksFor(engine);
  const { v4, v6 } = renderFirewall(plan);
  // DOCKER-USER exists once dockerd has started; create it if we're first
  // (dockerd keeps an existing DOCKER-USER and only adds its FORWARD jump).
  if (engine === "docker") await ok(cmd, "iptables", ["-t", "filter", "-N", "DOCKER-USER"]);
  const v4Path = `${dir}/flagship-egress.v4.rules`;
  await writeFile(v4Path, v4, { mode: 0o600 });
  await cmd.run("iptables-restore", ["-w", "--noflush", v4Path]);
  for (const h of hooks.filter((x) => x.bin === "iptables")) {
    if (!(await ok(cmd, h.bin, ["-t", h.table, "-C", h.parent, "-j", h.chain]))) {
      await cmd.run(h.bin, ["-w", "-t", h.table, "-I", h.parent, "1", "-j", h.chain]);
    }
  }
  const v6Path = `${dir}/flagship-egress.v6.rules`;
  try {
    await writeFile(v6Path, v6, { mode: 0o600 });
    await cmd.run("ip6tables-restore", ["-w", "--noflush", v6Path]);
    for (const h of hooks.filter((x) => x.bin === "ip6tables")) {
      if (!(await ok(cmd, h.bin, ["-t", h.table, "-C", h.parent, "-j", h.chain]))) {
        await cmd.run(h.bin, ["-w", "-t", h.table, "-I", h.parent, "1", "-j", h.chain]);
      }
    }
  } catch (e) {
    opts.log?.(`[egress] IPv6 rules not installed (${(e as Error).message}); the bridges are IPv4-only`);
  }
  // Fail closed like the IPv4 rules: without this table containers could reach each other.
  if (engine === "podman") await installIccIsolation(cmd, plan.bridges, dir);
}

/** Podman only (Docker's bridges carry enable_icc=false themselves). Throws when nft refuses. */
export async function installIccIsolation(cmd: CommandRunner, bridges: readonly FirewallBridge[], dir = "/run"): Promise<void> {
  // Unprivileged, the broker renders this same table from the bridge names alone (privd iccTable).
  if (runsUnprivileged()) {
    for (const b of bridges) if (!IFACE.test(b.bridge)) throw new Error(`bad bridge interface name ${JSON.stringify(b.bridge)}`);
    await privd().host("icc", bridges.map((b) => b.bridge));
    return;
  }
  const iccPath = `${dir}/flagship-icc.nft`;
  await writeFile(iccPath, renderIccTable(bridges), { mode: 0o600 });
  await cmd.run("nft", ["-f", iccPath]);
}

/** Remove every hook and chain. Safe to run when nothing is installed. */
export async function removeFirewall(cmd: CommandRunner, engine: EngineKind = activeEngine()): Promise<void> {
  for (const h of hooksFor(engine)) {
    for (let i = 0; i < 8; i++) {
      if (!(await ok(cmd, h.bin, ["-t", h.table, "-D", h.parent, "-j", h.chain]))) break;
    }
  }
  const chains = new Map<string, { bin: string; table: string }>();
  for (const h of HOOKS) chains.set(`${h.bin}/${h.table}/${h.chain}`, h);
  for (const [key, h] of chains) {
    const chain = key.split("/")[2]!;
    await ok(cmd, h.bin, ["-t", h.table, "-F", chain]);
    await ok(cmd, h.bin, ["-t", h.table, "-X", chain]);
  }
}
