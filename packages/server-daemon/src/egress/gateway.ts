/**
 * The box's egress gateway: the three sandbox bridges, the firewall that
 * fences them, and the proxies + filtering DNS everything they send goes
 * through. See docs/ai-privacy-and-staging.md §3 and policy.ts for who may
 * reach what.
 *
 * Boot: ensure the bridges (fixed names), install the firewall, bind the
 * proxies and DNS on each bridge's gateway IP, and (apps, staging) forward the
 * data-store ports from the gateway IP to the host's loopback-only data
 * services. Then publish the gateway IPs (sandboxNetworking.ts) so every
 * `docker run` gets `--dns <gw>` + the data alias on `<gw>`, and every
 * `docker build` its registry host pins. If any of that fails the box
 * keeps running with the previous behaviour (logged loudly, `status()` says
 * so) rather than breaking every installed app; an operator can turn the
 * gateway off on purpose with FLAGSHIP_EGRESS=off, which also removes the
 * rules.
 */
import { getServers } from "node:dns";
import type { AccessRule } from "@flagship/protocol";
import type { CommandRunner } from "../serviceRunner.js";
import { systemDnsUpstream, startDnsServer, type DnsServerHandle } from "./dnsFilter.js";
import { installFirewall, removeFirewall, type FirewallPorts } from "./firewall.js";
import { ensureSandboxNetwork, inspectNetwork, type NetworkInfo } from "./networks.js";
import {
  BUILD_REGISTRY_HOSTS,
  EGRESS_NETWORKS,
  classifySource,
  inSubnet,
  parseIpv4,
  decide,
  parseCidr,
  type EgressNetworkKind,
  type EgressPolicyState,
  type Ipv4Subnet,
} from "./policy.js";
import { startProxyServer, startTcpForwarder, type ProxyServerHandle } from "./proxy.js";
import { setSandboxNetworking } from "./sandboxNetworking.js";
import { outboundNet } from "../outboundProxy/outboundNet.js";

export const DEFAULT_EGRESS_PORTS: FirewallPorts = { tls: 15443, http: 15080, dns: 15053 };
/** Host data services an app or staging copy may reach (Postgres). */
export const DEFAULT_DATA_PORTS = [5432];

export interface EgressGatewayOptions {
  cmd: CommandRunner;
  /** The owner-signed access rules of a live service ([] = everything denied). */
  accessRules: (serviceId: string) => readonly AccessRule[];
  /**
   * A live app was denied a host because no rule in its list matched (an
   * explicit `deny` never calls this). Called on every such denial; the
   * caller dedupes and rate-limits.
   */
  onUnmatched?: (serviceId: string, host: string) => void;
  ports?: FirewallPorts;
  dataPorts?: number[];
  log?: (m: string) => void;
  dnsServers?: () => string[];
  /** Where the iptables-restore payloads are staged. Default /run. */
  rulesDir?: string;
  /** Container name → serviceId on flagship-apps. Default strips `flagship-`. */
  serviceIdOf?: (containerName: string) => string | null;
  now?: () => number;
}

export interface EgressStatus {
  enforced: boolean;
  reason?: string;
}

const APPS_PREFIX = "flagship-";

export class EgressGateway {
  private readonly ports: FirewallPorts;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private subnets: Partial<Record<EgressNetworkKind, Ipv4Subnet[]>> = {};
  private gateways: Partial<Record<EgressNetworkKind, string>> = {};
  private appByIp = new Map<string, string>();
  private handles: Array<DnsServerHandle | ProxyServerHandle> = [];
  private state: EgressStatus = { enforced: false, reason: "not started" };
  private refreshing: Promise<void> | null = null;
  private lastRefresh = 0;
  private readonly deniedAt = new Map<string, number>();
  private readonly live = new Set<{ src: string; host: string; close: () => void }>();

  constructor(private readonly opts: EgressGatewayOptions) {
    this.ports = opts.ports ?? DEFAULT_EGRESS_PORTS;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.now = opts.now ?? (() => Date.now());
  }

  status(): EgressStatus {
    return { ...this.state };
  }

  /** The DNS server an app container should be given (`--dns`), when enforcing. */
  dnsServerFor(kind: EgressNetworkKind): string | null {
    return this.state.enforced ? (this.gateways[kind] ?? null) : null;
  }

  async start(): Promise<EgressStatus> {
    const infos: Array<{ kind: EgressNetworkKind; info: NetworkInfo }> = [];
    try {
      for (const spec of EGRESS_NETWORKS) {
        infos.push({ kind: spec.kind, info: await ensureSandboxNetwork(this.opts.cmd, spec, this.log) });
      }
      await installFirewall(
        this.opts.cmd,
        {
          bridges: infos.map(({ kind, info }) => ({ kind, bridge: info.bridge })),
          ports: this.ports,
          dataPorts: this.opts.dataPorts ?? DEFAULT_DATA_PORTS,
        },
        { rulesDir: this.opts.rulesDir, log: this.log },
      );
    } catch (e) {
      this.state = { enforced: false, reason: (e as Error).message };
      this.log(`[egress] NOT ENFORCED: ${(e as Error).message}. Containers keep their previous network access.`);
      return this.status();
    }
    for (const { kind, info } of infos) {
      this.subnets[kind] = info.subnets.map((c) => parseCidr(c)).filter((s): s is Ipv4Subnet => s !== null);
      if (info.gateways[0]) this.gateways[kind] = info.gateways[0];
      if (kind === "apps") this.setApps(info);
    }
    const upstream = systemDnsUpstream(this.opts.dnsServers ?? getServers);
    const listenErrors: string[] = [];
    for (const kind of Object.keys(this.gateways) as EgressNetworkKind[]) {
      const ip = this.gateways[kind]!;
      try {
        if (kind !== "build") {
          for (const p of this.opts.dataPorts ?? DEFAULT_DATA_PORTS) {
            try {
              this.handles.push(
                await startTcpForwarder(ip, p, { host: "127.0.0.1", port: p }, (src) => this.fromBridge(kind, src)),
              );
            } catch (e) {
              this.log(`[egress] data port ${p} not forwarded on ${ip} (${(e as Error).message})`);
            }
          }
        }
        this.handles.push(
          await startDnsServer(
            { allow: (src, name) => this.allowSync(src, name), upstream, onDenied: (s, n) => this.denied(s, n, "dns") },
            ip,
            this.ports.dns,
          ),
          await startProxyServer(this.proxyDeps(), "tls", ip, this.ports.tls),
          await startProxyServer(this.proxyDeps(), "http", ip, this.ports.http),
        );
      } catch (e) {
        listenErrors.push(`${kind} ${ip}: ${(e as Error).message}`);
      }
    }
    // The firewall already fences the bridges; a listener that failed just
    // means that bridge has no internet at all, which is the safe side.
    if (listenErrors.length) this.log(`[egress] gateway listeners failed (${listenErrors.join("; ")}); those bridges have no internet`);
    this.state = { enforced: true };
    const byNetwork = new Map<string, string>();
    for (const spec of EGRESS_NETWORKS) {
      const gw = this.gateways[spec.kind];
      if (gw) byNetwork.set(spec.network, gw);
    }
    setSandboxNetworking({ gateways: byNetwork, buildHosts: BUILD_REGISTRY_HOSTS });
    this.log(
      `[egress] enforcing: ${infos.map(({ kind, info }) => `${kind}=${info.bridge}(${info.subnets.join(",")})`).join(" ")}`,
    );
    return this.status();
  }

  /** Re-read which app container holds which IP (after a container starts or stops). */
  refreshApps(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const spec = EGRESS_NETWORKS.find((n) => n.kind === "apps")!;
      const info = await inspectNetwork(this.opts.cmd, spec.network).catch(() => null);
      if (info) {
        this.setApps(info);
        this.recheck();
      }
      this.lastRefresh = this.now();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async stop(): Promise<void> {
    setSandboxNetworking(null);
    const hs = this.handles;
    this.handles = [];
    await Promise.all(hs.map((h) => h.close().catch(() => {})));
  }

  /**
   * Re-judge every open proxied connection (after an access list changes) and
   * cut the ones no longer allowed, so a removed rule also ends keep-alive streams.
   */
  recheck(): number {
    let cut = 0;
    const state = this.policyState();
    for (const c of [...this.live]) {
      if (!decide(state, c.src, c.host).allow) {
        this.live.delete(c);
        c.close();
        cut++;
      }
    }
    return cut;
  }

  private proxyDeps() {
    return {
      allow: (s: string, h: string) => this.allowSync(s, h),
      onDenied: (s: string, h: string | null, k: string) => this.denied(s, h, k),
      dialViaProxy: (h: string, p: number) => (outboundNet.current() ? outboundNet.connectTcp(h, p) : null),
      track: (c: { src: string; host: string; close: () => void }) => {
        this.live.add(c);
        return () => {
          this.live.delete(c);
        };
      },
    };
  }

  /** The policy view, for tests and diagnostics. */
  policyState(): EgressPolicyState {
    return { subnets: this.subnets, appByIp: this.appByIp, accessRules: this.opts.accessRules };
  }

  private fromBridge(kind: EgressNetworkKind, src: string): boolean {
    const n = parseIpv4(src);
    return n !== null && (this.subnets[kind] ?? []).some((s) => inSubnet(n, s));
  }

  private setApps(info: NetworkInfo): void {
    const next = new Map<string, string>();
    const idOf = this.opts.serviceIdOf ?? ((n: string) => (n.startsWith(APPS_PREFIX) ? n.slice(APPS_PREFIX.length) : null));
    for (const c of info.containers) {
      const id = idOf(c.name);
      if (id && c.ipv4) next.set(c.ipv4, id);
    }
    this.appByIp = next;
  }

  /** Exposed for tests: the decision a proxy or the DNS filter gets. */
  allowSync(src: string, host: string): boolean | Promise<boolean> {
    const state = this.policyState();
    const s = classifySource(state, src);
    if (s.kind === "apps" && s.serviceId === null && this.now() - this.lastRefresh > 1000) {
      return this.refreshApps().then(() => decide(this.policyState(), src, host).allow);
    }
    return decide(state, src, host).allow;
  }

  private denied(src: string, host: string | null, via: string): void {
    const d = decide(this.policyState(), src, host ?? "-");
    const who = d.who;
    if (!d.allow && d.unmatched) {
      try {
        this.opts.onUnmatched?.(d.unmatched.serviceId, d.unmatched.host);
      } catch {
        // recording a request must never break the denial itself
      }
    }
    const key = `${who}|${host}`;
    const t = this.now();
    if ((this.deniedAt.get(key) ?? 0) > t - 60_000) return;
    if (this.deniedAt.size > 1000) this.deniedAt.clear();
    this.deniedAt.set(key, t);
    this.log(`[egress] blocked ${who} → ${host ?? "(no host)"} (${via})`);
  }
}

/** FLAGSHIP_EGRESS=off: take the rules out and run without the gateway. */
export async function disableEgress(cmd: CommandRunner, log: (m: string) => void = console.warn): Promise<void> {
  await removeFirewall(cmd);
  log("[egress] FLAGSHIP_EGRESS=off: gateway disabled and its firewall rules removed; containers have unfiltered internet");
}
