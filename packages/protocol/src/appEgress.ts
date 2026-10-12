/**
 * Owner approval for a live app's internet access — `flagship/app-egress/v1`.
 *
 * A live app has no internet by default. Its manifest may declare hosts in
 * `network.egress`; the box opens exactly the hosts in the newest grant the
 * owner signed for that service (and still declared), nothing else. An empty
 * host list revokes. Signed by the sensitive-order key (the admin root when
 * pinned, else the owner IRK); the box verifies it with
 * `authorizeSensitiveOrder`, so a session token alone can never open egress.
 *
 * Canonical bytes:
 *   flagship/app-egress/v1|<serverDomain>|<serviceId>|<hosts sorted, comma-joined>|<issuedAt>
 * Hosts are sorted by code unit (plain ASCII order for valid hosts) and must be
 * distinct valid egress hosts, so ',' and '|' can never appear inside one.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import { EGRESS_HOSTS_MAX, isEgressHost } from "./manifest.js";
import type { Bytes } from "./types.js";

export interface AppEgressGrant {
  /** The box this grant is for (its FQDN). */
  serverDomain: string;
  /** The installed service, `<creator>-<slug>`. */
  serviceId: string;
  /** Hosts the app may reach; [] revokes. Order does not matter. */
  hosts: string[];
  /** Unix ms. The box keeps only the newest grant per service. */
  issuedAt: number;
}

export const TAG_APP_EGRESS = "flagship/app-egress/v1";

export function sortEgressHosts(hosts: readonly string[]): string[] {
  return [...hosts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function appEgressGrantCanonicalBytes(g: AppEgressGrant): Bytes {
  if (g.serverDomain.length === 0) throw new Error("app-egress: empty serverDomain");
  if (g.serviceId.length === 0) throw new Error("app-egress: empty serviceId");
  legacyFieldGuard("serverDomain", g.serverDomain);
  legacyFieldGuard("serviceId", g.serviceId);
  if (!Number.isSafeInteger(g.issuedAt) || g.issuedAt < 0) throw new Error("app-egress: bad issuedAt");
  if (g.hosts.length > EGRESS_HOSTS_MAX) throw new Error("app-egress: too many hosts");
  const hosts = sortEgressHosts(g.hosts);
  for (let i = 0; i < hosts.length; i++) {
    if (!isEgressHost(hosts[i]!)) throw new Error(`app-egress: invalid host ${JSON.stringify(hosts[i])}`);
    if (i > 0 && hosts[i] === hosts[i - 1]) throw new Error(`app-egress: duplicate host ${hosts[i]}`);
  }
  return new TextEncoder().encode(
    [TAG_APP_EGRESS, g.serverDomain, g.serviceId, hosts.join(","), String(g.issuedAt)].join("|"),
  );
}

export function signAppEgressGrant(g: AppEgressGrant, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appEgressGrantCanonicalBytes(g));
}

/** Never throws: a malformed grant simply fails. */
export function verifyAppEgressGrant(g: AppEgressGrant, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appEgressGrantCanonicalBytes(g), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON grant (no signature check). */
export function parseAppEgressGrant(v: unknown): AppEgressGrant | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.serviceId !== "string") return null;
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt)) return null;
  if (!Array.isArray(r.hosts) || !r.hosts.every((h) => typeof h === "string")) return null;
  const g: AppEgressGrant = {
    serverDomain: r.serverDomain,
    serviceId: r.serviceId,
    hosts: r.hosts as string[],
    issuedAt: r.issuedAt,
  };
  try {
    appEgressGrantCanonicalBytes(g);
  } catch {
    return null;
  }
  return g;
}
