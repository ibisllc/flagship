/**
 * Pod entitlement domain — the (deprecated) RootEntitlement +
 * ServiceEntitlement certs and their revocation list, TunnelHello v2, and
 * the unified ServiceGrant that replaced them (per-app authorization with
 * explicit pod identities + routes).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, sort rules, and guards are unchanged, so canonical bytes and
 * signatures remain byte-identical. (Imported by `devEntitlements.ts`.)
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Pod entitlement certs — two-tier model.
//
// RootEntitlement: never-expires. Signed by the user's IRK. Authorizes
// the pod's own canonical (e.g. `kitchen.john.flagship.services`).
// Without this, a long-offline pod couldn't reconnect even to fetch
// fresh app entitlements — chicken-and-egg.
//
// AppEntitlement: 90-day default TTL. Signed by the user's IRK. Lists
// every app-canonical the pod is currently entitled to serve (e.g.
// `messenger-facebook.kitchen.john.flagship.services`,
// `shittygame.woodshed.john.flagship.services`). Phone re-issues
// opportunistically (on app install/uninstall, on rolling refresh).
//
// `.services` validates both at HELLO time. Shortened slots (the
// user-zone and host-zone collapsed forms like
// `messenger.john.flagship.services`) are AUTOMATICALLY DERIVED from
// the cert's canonicals — not separately listed. Multiple pods may
// derive overlapping shortened slots → collision is normal → FCFS
// resolves at the hub.
//
// Each cert has a stable `certId` = SHA-256 hex of its canonical
// bytes. Revocation lists reference certs by id.
// ──────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use AppGrant (see below). RootEntitlement and
 * AppEntitlement are subsumed by AppGrant under the Thread-C model.
 * Existing signed RootEntitlements remain verifiable for back-compat;
 * new pods issue AppGrants instead, which carry a 7-day TTL by
 * convention (#51 cadence — long-offline pods naturally lose authority
 * without depending on revocation-list propagation).
 *
 * Perpetual cert authorizing a single pod canonical. Issued once at
 * pod registration, never re-issued. Phone retains the ability to
 * REVOKE it (via the cert revocation list — see below) for compromise
 * scenarios.
 */
export interface RootEntitlement {
  /** User-zone owner — middle label of the pod canonical. */
  username: string;
  /** Pod identity pubkey (the STK). 32 bytes. */
  podPubKey: Bytes;
  /** Pod's canonical FQDN, e.g. `kitchen.john.flagship.services`. */
  podCanonical: string;
  /** ms since epoch when this cert was minted. */
  issuedAt: number;
}

const TAG_ROOT_ENTITLEMENT = "flagship/root-entitlement/v1";

function canonicalRootEntitlement(c: RootEntitlement): Bytes {
  legacyFieldGuard("username", c.username);
  legacyFieldGuard("podCanonical", c.podCanonical);
  return new TextEncoder().encode(
    [
      TAG_ROOT_ENTITLEMENT,
      c.username,
      hex(c.podPubKey),
      c.podCanonical,
      c.issuedAt,
    ].join("|"),
  );
}

export function signRootEntitlement(c: RootEntitlement, irk: Keypair): Bytes {
  return ed.sign(canonicalRootEntitlement(c), irk.privateKey);
}

export function verifyRootEntitlement(
  c: RootEntitlement,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRootEntitlement(c), irkPub);
  } catch {
    return false;
  }
}

/**
 * Time-limited cert authorizing a list of app-canonicals on a pod.
 * Re-issued by the phone whenever the canonicals change OR before
 * `expiresAt` lapses (default TTL 90 days).
 *
 * Canonicals listed here are FQDNs of the form
 * `<slug>[-<author>].<host>.<user>.flagship.services`. The hub uses
 * them to derive the shortened slots the pod can compete for; the
 * pod doesn't list shortened slots explicitly.
 *
 * FUTURE: extend with `customDomains: Array<{ host: string; serviceId:
 * { slug: string; author: string } }>`. A user-purchased domain
 * (e.g., `notes.alice.com` pointed at .services) MUST be bound to a
 * specific (slug, author, user) tuple — never free-floating. The
 * binding goes in the cert so the hub can route the SNI through the
 * same allocator state. This expansion is wire-only on AppEntitlement;
 * the allocator already keys per-(slug, author, user) so custom
 * domains slot in alongside derived shorteneds in the same set.
 */
/**
 * @deprecated Use AppGrant. AppEntitlement was the per-pod listing of
 * canonicals; AppGrant inverts the axis (per-app listing of pods) for
 * cleaner multi-pod failover.
 */
export interface ServiceEntitlement {
  username: string;
  podPubKey: Bytes;
  /** Lower-cased FQDNs the pod is entitled to serve. */
  canonicals: string[];
  issuedAt: number;
  expiresAt: number;
}

const TAG_SERVICE_ENTITLEMENT = "flagship/service-entitlement/v1";

function canonicalServiceEntitlement(c: ServiceEntitlement): Bytes {
  legacyFieldGuard("username", c.username);
  for (const canonical of c.canonicals) legacyFieldGuard("canonical", canonical);
  // Sort canonicals so signing is order-independent.
  const list = [...c.canonicals].map((s) => s.toLowerCase()).sort().join(",");
  return new TextEncoder().encode(
    [
      TAG_SERVICE_ENTITLEMENT,
      c.username,
      hex(c.podPubKey),
      list,
      c.issuedAt,
      c.expiresAt,
    ].join("|"),
  );
}

export function signServiceEntitlement(c: ServiceEntitlement, irk: Keypair): Bytes {
  return ed.sign(canonicalServiceEntitlement(c), irk.privateKey);
}

export function verifyServiceEntitlement(
  c: ServiceEntitlement,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServiceEntitlement(c), irkPub);
  } catch {
    return false;
  }
}

/**
 * Stable identifier for an entitlement cert — SHA-256 hex of its
 * canonical bytes. Used as the lookup key in revocation lists.
 *
 * The discriminator argument selects which canonical-bytes function
 * to hash, since the two cert types share an `issuedAt` and could
 * otherwise collide (extremely unlikely in practice, but guard
 * cheaply).
 */
export async function rootEntitlementCertId(c: RootEntitlement): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalRootEntitlement(c));
  return hex(new Uint8Array(digest));
}

export async function serviceEntitlementCertId(c: ServiceEntitlement): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalServiceEntitlement(c));
  return hex(new Uint8Array(digest));
}

/**
 * Phone-signed revocation list. The phone publishes this to .com on
 * change; .services pulls per-user with a small cache TTL (default
 * 5 min) to honor revocations promptly without hammering the Worker.
 *
 * Monotonic `issuedAt` defends against replay of an older list (which
 * would un-revoke certs).
 */
export interface EntitlementRevocationList {
  username: string;
  /** Cert ids (SHA-256 hex) that are revoked. */
  certIds: string[];
  issuedAt: number;
}

const TAG_ENTITLEMENT_REVOKE = "flagship/entitlement-revoke/v1";

function canonicalEntitlementRevocationList(r: EntitlementRevocationList): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [
      TAG_ENTITLEMENT_REVOKE,
      r.username,
      [...r.certIds].sort().join(","),
      r.issuedAt,
    ].join("|"),
  );
}

export function signEntitlementRevocationList(
  r: EntitlementRevocationList,
  irk: Keypair,
): Bytes {
  return ed.sign(canonicalEntitlementRevocationList(r), irk.privateKey);
}

export function verifyEntitlementRevocationList(
  r: EntitlementRevocationList,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalEntitlementRevocationList(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * TunnelHello v2 — the HELLO frame envelope sent over the .services
 * tunnel WS. Replaces v1's `subdomains` / `controlledDomains` model
 * with entitlement-cert-driven allocation.
 *
 * The pod's STK signs `canonicalTunnelHelloV2` (which references the
 * cert ids, not the certs themselves). This binds the STK signature
 * to the specific certs being presented; a captured signature can't
 * be replayed against a different cert set.
 *
 * The wire payload (sent as the FRAME_HELLO body) carries the certs +
 * their IRK signatures alongside this signed envelope so the hub can
 * verify both (STK on envelope, IRK on certs) without an extra
 * round-trip.
 */
export interface TunnelHelloV2 {
  serverId: ServerId;
  /** SHA-256 hex of the RootEntitlement's canonical bytes. */
  rootEntitlementCertId: string;
  /**
   * SHA-256 hex of the ServiceEntitlement's canonical bytes, or empty
   * string when no service entitlement is presented (initial provisioning).
   */
  serviceEntitlementCertId: string;
  /** 32-byte random nonce for replay defense. */
  nonce: Bytes;
  issuedAt: number;
}

const TAG_TUNNEL_HELLO_V2 = "flagship/tunnel-hello/v2";

function canonicalTunnelHelloV2(h: TunnelHelloV2): Bytes {
  return new TextEncoder().encode(
    [
      TAG_TUNNEL_HELLO_V2,
      h.serverId,
      h.rootEntitlementCertId,
      h.serviceEntitlementCertId,
      hex(h.nonce),
      h.issuedAt,
    ].join("|"),
  );
}

export function signTunnelHelloV2(h: TunnelHelloV2, stk: Keypair): Bytes {
  return ed.sign(canonicalTunnelHelloV2(h), stk.privateKey);
}

export function verifyTunnelHelloV2(
  h: TunnelHelloV2,
  sig: Bytes,
  stkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalTunnelHelloV2(h), stkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// AppGrant — the unified envelope replacing RootEntitlement +
// AppEntitlement + ClaimUrlCapability.
//
// One grant covers all four authorization concerns for a single app:
//   - WHO authorized: the user, via IRK signature
//   - WHO may run: one or more pod identities (failover/sibling group)
//   - WHAT they may run: an app, identified by appName@authorStableId
//   - WHERE they may serve from: a list of serverDomains + routes
//   - HOW LONG: issuedAt → expiresAt (7 days by convention)
//
// Renewal is a fresh AppGrant with a new grantId, distributed to
// siblings via the sibling-WS routine sync. Individual revocation by
// grantId is supported via the revocation list (see #88).
//
// Discrimination from older entitlements:
//   - 7-day TTL (vs 90-day AppEntitlement) → phone-loss blast radius
//     bounded to one week
//   - per-app rather than per-pod-listing-many-apps → multi-pod
//     failover is natural
//   - explicit allowedPodIdentities → cross-pod cert escalation closed
//     at the AppGrant verification layer
// ──────────────────────────────────────────────────────────────────────

export type ServiceGrantRouteScope = "canonical" | "non-canonical" | "subpath";

export interface ServiceGrantRoute {
  /** Lower-case FQDN (and optional path prefix for "subpath" scope). */
  url: string;
  scope: ServiceGrantRouteScope;
}

export interface ServiceGrant {
  /** Fresh v4 UUID; consumers reject duplicates within the active window. */
  grantId: string;
  /** Username at issuance time. Renames produce new grants under the new name. */
  username: string;
  /**
   * Service canonical name in the form `serviceName@authorStableId` where
   * authorStableId is a 12-char SHA-256 prefix of the author's IRK pubkey.
   * Stable across author renames.
   */
  serviceCanonical: string;
  /** Optional discriminator for multi-instance installs of the same service. */
  serviceInstanceId?: string;
  /** Pod canonical FQDNs covered by this grant (sorted at canonicalization). */
  serverDomains: string[];
  /** Pod identity pubkeys authorized to serve (sorted at canonicalization). */
  serverIdentities: Bytes[];
  /** Explicit list of URLs (canonical + non-canonical + subpath) covered. */
  routes: ServiceGrantRoute[];
  /** ms since epoch. */
  issuedAt: number;
  /** ms since epoch; SHOULD be issuedAt + 7*24*3600*1000 by convention. */
  expiresAt: number;
}

const TAG_SERVICE_GRANT = "flagship/service-grant/v1";

/**
 * Validate that no string field in a ServiceGrant contains the
 * canonical-bytes separator '|' or any control byte (H1 hardening).
 * Throws on violation.
 */
function validateServiceGrantFields(g: ServiceGrant): void {
  const fields: Array<[string, string]> = [
    ["grantId", g.grantId],
    ["username", g.username],
    ["serviceCanonical", g.serviceCanonical],
  ];
  if (g.serviceInstanceId) fields.push(["serviceInstanceId", g.serviceInstanceId]);
  for (const d of g.serverDomains) fields.push(["serverDomain", d]);
  for (const r of g.routes) fields.push([`route(${r.scope})`, r.url]);
  for (const [name, value] of fields) {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0x7c) throw new Error(`ServiceGrant field "${name}" contains separator '|'`);
      if (c <= 0x1f || c === 0x7f) {
        throw new Error(
          `ServiceGrant field "${name}" contains control char 0x${c.toString(16)} at index ${i}`,
        );
      }
    }
  }
  if (g.expiresAt <= g.issuedAt) {
    throw new Error("ServiceGrant: expiresAt must be strictly after issuedAt");
  }
  if (g.serverIdentities.length === 0) {
    throw new Error("ServiceGrant: serverIdentities must have at least one entry");
  }
  if (g.routes.length === 0) {
    throw new Error("ServiceGrant: routes must have at least one entry");
  }
}

function canonicalServiceGrant(g: ServiceGrant): Bytes {
  validateServiceGrantFields(g);
  const domains = [...g.serverDomains].map((d) => d.toLowerCase()).sort().join(",");
  const identities = [...g.serverIdentities].map((b) => hex(b)).sort().join(",");
  const routes = [...g.routes]
    .map((r) => `${r.scope}:${r.url.toLowerCase()}`)
    .sort()
    .join(",");
  return new TextEncoder().encode(
    [
      TAG_SERVICE_GRANT,
      g.grantId,
      g.username,
      g.serviceCanonical,
      g.serviceInstanceId ?? "",
      domains,
      identities,
      routes,
      g.issuedAt,
      g.expiresAt,
    ].join("|"),
  );
}

export function signServiceGrant(g: ServiceGrant, irk: Keypair): Bytes {
  return ed.sign(canonicalServiceGrant(g), irk.privateKey);
}

export function verifyServiceGrant(g: ServiceGrant, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalServiceGrant(g), irkPub);
  } catch {
    return false;
  }
}

/**
 * Stable identifier for a ServiceGrant — SHA-256 hex of its canonical
 * bytes. Used as the lookup key in revocation lists and the cert-sync
 * inventory.
 */
export async function serviceGrantId(g: ServiceGrant): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalServiceGrant(g));
  return hex(new Uint8Array(digest));
}

/**
 * Check whether a specific pod identity is authorized under this grant.
 * The verifier MUST also confirm the grant's signature, that it is not
 * revoked, and that the current time is within [issuedAt, expiresAt).
 */
export function serviceGrantAuthorizesPod(g: ServiceGrant, podPubKey: Bytes): boolean {
  const target = hex(podPubKey);
  for (const id of g.serverIdentities) {
    if (hex(id) === target) return true;
  }
  return false;
}

/**
 * Check whether a URL is in the grant's routes list.
 * Comparison is case-insensitive on the host portion.
 */
export function serviceGrantAuthorizesUrl(g: ServiceGrant, url: string): boolean {
  const target = url.toLowerCase();
  for (const r of g.routes) {
    if (r.url.toLowerCase() === target) return true;
    if (r.scope === "subpath" && target.startsWith(r.url.toLowerCase() + "/")) return true;
  }
  return false;
}

/**
 * Check whether `now` falls inside the grant's active window. The
 * window is half-open: [issuedAt, expiresAt).
 */
export function serviceGrantActiveAt(g: ServiceGrant, now: number): boolean {
  return now >= g.issuedAt && now < g.expiresAt;
}
