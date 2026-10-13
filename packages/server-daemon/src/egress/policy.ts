/**
 * Who may reach which internet host, decided per connection by the source
 * address. Three docker bridges feed the box's egress gateway:
 *   build   (`flagship-build`)   → package registries only (BUILD_REGISTRY_HOSTS)
 *   staging (`flagship-staging`) → nothing
 *   apps    (`flagship-apps`)    → per app, what the owner-signed access list allows
 * Anything else (an unknown source, a container the box doesn't know) gets
 * nothing. Pure: the gateway feeds it subnets, the container map and lists.
 */
import { isIP } from "node:net";
import { decideAccess, type AccessRule } from "@flagship/protocol";

export type EgressNetworkKind = "build" | "staging" | "apps";

export interface EgressNetworkSpec {
  kind: EgressNetworkKind;
  /** Docker network name. */
  network: string;
  /** Fixed Linux bridge name (`com.docker.network.bridge.name`, ≤ 15 chars). */
  bridge: string;
  /**
   * `docker network create --internal`: no default route and no DNS
   * forwarding by docker's embedded resolver. Only for the build bridge:
   * docker publishes no ports on an internal network, and the box reaches
   * staging and live apps through published loopback ports.
   */
  internal: boolean;
  /**
   * Containers on the bridge may reach each other. Always false: one app
   * must never reach another app's container (docs/app-runtimes.md §5), and
   * docker's own rule drops it whatever the host's br_netfilter state.
   */
  icc: boolean;
}

export const EGRESS_NETWORKS: readonly EgressNetworkSpec[] = [
  { kind: "build", network: "flagship-build", bridge: "fs-build", internal: true, icc: false },
  { kind: "staging", network: "flagship-staging", bridge: "fs-staging", internal: false, icc: false },
  { kind: "apps", network: "flagship-apps", bridge: "fs-apps", internal: false, icc: false },
];

/**
 * What a `docker build` RUN step may fetch: the language and distro package
 * registries, and GitHub for git dependencies and release downloads. Not a
 * container registry: dockerd pulls base images itself, on the host network
 * (dockerfilePolicy.ts limits which). Exact names only: the build bridge has
 * no DNS, so each is pinned to the gateway in the build's /etc/hosts.
 */
export const BUILD_REGISTRY_HOSTS: readonly string[] = [
  // npm / yarn
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // Distro mirrors
  "deb.debian.org",
  "security.debian.org",
  "dl-cdn.alpinelinux.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
  // GitHub (git deps, tarballs, release assets)
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  // Rust
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  // Ruby
  "rubygems.org",
  "index.rubygems.org",
];

/** `api.example.com` matches itself; `*.example.com` matches its subdomains only. */
export function hostMatches(entry: string, host: string): boolean {
  if (entry === host) return true;
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1);
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return false;
}

export function hostAllowed(list: readonly string[], host: string): boolean {
  return list.some((e) => hostMatches(e, host));
}

/** Lowercase, drop one trailing dot; null for anything that isn't a DNS name. */
export function normalizeHost(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return null;
  if (isIP(h)) return null;
  if (!/^[a-z0-9_]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*$/.test(h)) return null;
  return h;
}

export interface Ipv4Subnet {
  base: number;
  mask: number;
}

export function parseIpv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.replace(/^::ffff:/i, ""));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function parseCidr(cidr: string): Ipv4Subnet | null {
  const [ip, bitsRaw] = cidr.split("/");
  const base = parseIpv4(ip ?? "");
  const bits = Number(bitsRaw);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

export function inSubnet(ip: number, s: Ipv4Subnet): boolean {
  return ((ip & s.mask) >>> 0) === s.base;
}

const NON_PUBLIC_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((c) => parseCidr(c)!);

/**
 * Whether the gateway may connect to this resolved address. A name the owner
 * approved must not be a door into the box itself or the owner's LAN, so
 * loopback, private, link-local, CGNAT and multicast ranges are refused.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return !NON_PUBLIC_V4.some((s) => inSubnet(v4, s));
  if (isIP(ip) !== 6) return false;
  const l = ip.toLowerCase();
  if (l === "::" || l === "::1") return false;
  if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l)) return false;
  if (l.startsWith("64:ff9b:") || l.startsWith("2001:db8") || l.startsWith("100::")) return false;
  return true;
}

export type EgressSource =
  | { kind: "build" }
  | { kind: "staging" }
  | { kind: "apps"; serviceId: string | null }
  | { kind: "unknown" };

export interface EgressPolicyState {
  /** Subnet per network kind (from `docker network inspect`). */
  subnets: Partial<Record<EgressNetworkKind, Ipv4Subnet[]>>;
  /** Container IP on flagship-apps → serviceId. */
  appByIp: ReadonlyMap<string, string>;
  /** The owner-signed access rules of a live service ([] = everything denied). */
  accessRules: (serviceId: string) => readonly AccessRule[];
}

export function classifySource(state: EgressPolicyState, ip: string): EgressSource {
  const n = parseIpv4(ip);
  if (n === null) return { kind: "unknown" };
  for (const kind of ["build", "staging", "apps"] as const) {
    if ((state.subnets[kind] ?? []).some((s) => inSubnet(n, s))) {
      if (kind === "apps") return { kind, serviceId: state.appByIp.get(ip.replace(/^::ffff:/i, "")) ?? null };
      return { kind };
    }
  }
  return { kind: "unknown" };
}

export type EgressDecision =
  | { allow: true; who: string }
  | {
      allow: false;
      who: string;
      why: string;
      /** Set when a live app was denied because no rule in its list matched (not an explicit deny). */
      unmatched?: { serviceId: string; host: string };
    };

export function decide(state: EgressPolicyState, srcIp: string, rawHost: string): EgressDecision {
  const src = classifySource(state, srcIp);
  const who = src.kind === "apps" ? `app ${src.serviceId ?? "(unknown container)"}` : src.kind;
  const host = normalizeHost(rawHost);
  if (host === null) return { allow: false, who, why: "not a host name" };
  switch (src.kind) {
    case "build":
      return hostAllowed(BUILD_REGISTRY_HOSTS, host)
        ? { allow: true, who }
        : { allow: false, who, why: "builds reach package registries only" };
    case "staging":
      return { allow: false, who, why: "staging has no internet" };
    case "apps": {
      if (!src.serviceId) return { allow: false, who, why: "unknown app container" };
      const d = decideAccess(state.accessRules(src.serviceId), host);
      if (d.result === "allow") return { allow: true, who };
      if (d.rule !== null) return { allow: false, who, why: "the app's access list denies this host" };
      return {
        allow: false,
        who,
        why: "no rule in the app's access list allows this host",
        unmatched: { serviceId: src.serviceId, host },
      };
    }
    default:
      return { allow: false, who, why: "not a Flagship container" };
  }
}
