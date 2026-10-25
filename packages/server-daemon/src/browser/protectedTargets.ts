/**
 * What an app's browser may never reach on a live box (SECURITY-HARDENING-PLAN.md 10.4): this server
 * under any of its names, the control plane, the relay's own services, the server's own addresses (every
 * interface, the browser network's gateway) and the cloud metadata addresses. The judge refuses these
 * names and addresses before anything else, whatever the app was granted, even with a whole-network
 * grant; the pinning proxies never connect to the addresses.
 *
 * Other people's Flagship apps (`https://<app>.<user>.flagship.services`) are public sites like any
 * other (owner decision 2026-10-24): an app may open them with an approved start URL or a grant. Their
 * names resolve to the relay, which passes the TLS stream to the box that owns the name, so the relay's
 * addresses stay reachable on the public web ports and nothing else: its tunnel hub and API (8443) and
 * address echo (8444) are refused. The relay's own names (its host, the services apex, the gossip
 * fan-out names `broadcast--<user>.<apex>`, Fly's private suffixes) are refused by name. The relay's
 * addresses are looked up in the background; the control plane's are not, because it sits on a shared
 * edge whose addresses serve unrelated sites, so it is refused by name.
 */
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

/** Cloud metadata services, refused by address in every spelling the judge's classifier does not already cover. */
export const METADATA_ADDRESSES = ["169.254.169.254", "169.254.170.2", "fd00:ec2::254", "100.100.100.200"];

/** The only ports an app's browser may use on the relay's addresses: the public web ports boxes serve on. */
export const RELAY_PUBLIC_PORTS = [80, 443];

/** Names only the relay's own network answers (Fly private networking): never a public site. */
export const RELAY_PRIVATE_ZONES = ["internal", "flycast"];

/** The first label of the relay's gossip fan-out names (`broadcast--<user>.<apex>`), which the hub itself serves. */
export const RELAY_GOSSIP_PREFIX = "broadcast--";

export interface BrowserProtectedOptions {
  /** This server's name (`home.alice.flagship.services`): it and every name under it. */
  serverFqdn?: string;
  /** `https://flagshipserver.com`: its host and every name under it. */
  controlPlaneBaseUrl?: string;
  /** The tunnel hub (`wss://flagship-services.fly.dev:8443/tunnel`): the relay, by name and address. */
  relayUrl?: string;
  /** Further addresses of this server (the browser network's gateway, the browser itself). */
  extraAddresses?: string[];
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  resolve?: (host: string) => Promise<string[]>;
}

/**
 * Destinations reachable only on some ports: the relay's addresses, and every name under the services
 * apex (which resolve to it), pass on its web ports; its own services on the other ports do not.
 */
export interface PortLimited {
  addresses: string[];
  /** A name and every name under it. */
  zones: string[];
  ports: number[];
}

export interface ProtectedHosts {
  /** Exact names. */
  names: string[];
  /** Addresses refused on every port. */
  addresses: string[];
  /** A name and every name under it. */
  zones: string[];
  /** Names whose first label starts with `prefix`, directly under `zone`. */
  labelPrefixes: Array<{ prefix: string; zone: string }>;
  portLimited: PortLimited;
}

export interface BrowserProtected {
  /** For the judge (`protectedHosts`). */
  hosts: () => ProtectedHosts;
  /** For the pinning proxies (`protectedAddresses`): refused on every port. */
  addresses: () => string[];
  /** For the pinning proxies (`portLimited`): the relay's addresses and the only ports open on them. */
  portLimited: () => PortLimited;
  /** Look the relay's names up again (also done on a timer by {@link startRefresh}). */
  refresh: () => Promise<void>;
  startRefresh: (everyMs?: number) => () => void;
}

const hostOfUrl = (u: string | undefined): string | null => {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "") || null;
  } catch {
    return null;
  }
};

export function buildBrowserProtected(o: BrowserProtectedOptions): BrowserProtected {
  const server = o.serverFqdn?.toLowerCase().replace(/\.+$/, "") || null;
  const control = hostOfUrl(o.controlPlaneBaseUrl);
  const relay = hostOfUrl(o.relayUrl);
  // The services apex the box's name lives under (`flagship.services`): the relay itself answers for it.
  const apex = server && server.split(".").length >= 2 ? server.split(".").slice(-2).join(".") : null;
  const relayNames = [...new Set([relay, apex].filter((x): x is string => !!x))];
  const zones = [...new Set([server, control, ...RELAY_PRIVATE_ZONES].filter((x): x is string => !!x))];
  const labelPrefixes = apex ? [{ prefix: RELAY_GOSSIP_PREFIX, zone: apex }] : [];
  let relayAddresses: string[] = [];
  const resolve = o.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));

  const own = (): string[] => {
    const out: string[] = [];
    const ifs = (o.interfaces ?? networkInterfaces)();
    for (const list of Object.values(ifs)) for (const a of list ?? []) out.push(a.address.replace(/%.*$/, ""));
    return out;
  };
  const addresses = (): string[] => [...new Set([...own(), ...(o.extraAddresses ?? []), ...METADATA_ADDRESSES])];
  const portLimited = (): PortLimited => ({ addresses: [...relayAddresses], zones: apex ? [apex] : [], ports: [...RELAY_PUBLIC_PORTS] });

  const refresh = async (): Promise<void> => {
    const found: string[] = [];
    for (const n of relayNames) found.push(...(await resolve(n).catch(() => [] as string[])));
    if (found.length) relayAddresses = [...new Set(found)];
  };

  return {
    hosts: () => ({ names: relayNames, addresses: addresses(), zones, labelPrefixes, portLimited: portLimited() }),
    addresses,
    portLimited,
    refresh,
    startRefresh(everyMs = 10 * 60_000) {
      void refresh();
      const t = setInterval(() => void refresh(), everyMs);
      t.unref?.();
      return () => clearInterval(t);
    },
  };
}
