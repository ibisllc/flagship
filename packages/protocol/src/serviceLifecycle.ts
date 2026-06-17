/**
 * Service lifecycle domain — rename / custom-domain attach / voi.ci shorten,
 * install + uninstall, per-service env vars, the update-pack pull request,
 * and the single-use service-access invite + acceptance (#79).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and guards are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard, validateNoSepCtrl } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

const TAG_SERVICE_RENAME = "flagship/service-rename/v1";
const TAG_SET_CUSTOM_DOMAIN = "flagship/custom-domain/v1";
const TAG_VOICI_SHORTEN = "flagship/voici-shorten/v1";
const TAG_INSTALL_SERVICE = "flagship/install-service/v1";
const TAG_UNINSTALL_SERVICE = "flagship/uninstall-service/v1";
const TAG_SET_SERVICE_ENV = "flagship/set-service-env/v1";
const TAG_UPDATE_PULL = "flagship/update-pull/v1";
const TAG_SERVICE_INVITE = "flagship/service-invite/v1";
const TAG_SERVICE_INVITE_ACCEPT = "flagship/service-invite-accept/v1";

/**
 * App rename (voi.ci-aware). Replaces the user-visible URL stem
 * the app surfaces at. The internal serviceId is preserved; only the
 * displayLabel changes. Signed by the user's current IRK.
 *
 * The handler is responsible for:
 *   - validating displayLabel against DNS label rules
 *   - checking uniqueness within the user's zone
 *   - deleting old voi.ci codes pointing at the previous stem
 *   - re-publishing user-zone DNS labels (delegated to a hook)
 *   - minting a fresh voi.ci code for the new canonical URL
 */
export interface ServiceRename {
  username: string;
  serviceId: string;
  newDisplayLabel: string;
  issuedAt: number;
}

function canonicalServiceRename(r: ServiceRename): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("serviceId", r.serviceId);
  legacyFieldGuard("newDisplayLabel", r.newDisplayLabel);
  return new TextEncoder().encode(
    [TAG_SERVICE_RENAME, r.username, r.serviceId, r.newDisplayLabel.toLowerCase(), r.issuedAt].join("|"),
  );
}

export function signServiceRename(r: ServiceRename, irk: Keypair): Bytes {
  return ed.sign(canonicalServiceRename(r), irk.privateKey);
}
export function verifyServiceRename(r: ServiceRename, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalServiceRename(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * Custom (external) domain attach request (#79A). IRK-signed; the
 * server only RECORDS it (status=pending) and rate-limits — the CNAME
 * is verified out-of-band later (#79B/#82) and the outcome pushed.
 * `fqdn` is the subdomain the user is attaching (apex is rejected
 * server-side; canonical-bytes lower-case it so signer/verifier agree).
 */
export interface SetCustomDomain {
  username: string;
  serviceId: string;
  fqdn: string;
  issuedAt: number;
}

function canonicalSetCustomDomain(r: SetCustomDomain): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("serviceId", r.serviceId);
  legacyFieldGuard("fqdn", r.fqdn);
  return new TextEncoder().encode(
    [TAG_SET_CUSTOM_DOMAIN, r.username, r.serviceId, r.fqdn.toLowerCase(), r.issuedAt].join("|"),
  );
}

export function signSetCustomDomain(r: SetCustomDomain, irk: Keypair): Bytes {
  return ed.sign(canonicalSetCustomDomain(r), irk.privateKey);
}
export function verifySetCustomDomain(r: SetCustomDomain, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalSetCustomDomain(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * voi.ci short-link mint. The phone never signs this directly —
 * Worker mints internally during AppRename. But surfacing the
 * canonical-bytes type keeps the protocol layer's contract visible
 * to anyone reading the package, and a future "mint a custom short
 * link" UX (signed by IRK) can reuse the same envelope.
 */
export interface VoiciShorten {
  username: string;
  /** Optional binding to an serviceId — when omitted, the link is a
   *  one-off (no cascade on rename). */
  serviceId?: string;
  targetUrl: string;
  issuedAt: number;
}

function canonicalVoiciShorten(r: VoiciShorten): Bytes {
  legacyFieldGuard("username", r.username);
  if (r.serviceId !== undefined) legacyFieldGuard("serviceId", r.serviceId);
  legacyFieldGuard("targetUrl", r.targetUrl);
  return new TextEncoder().encode(
    [TAG_VOICI_SHORTEN, r.username, r.serviceId ?? "", r.targetUrl, r.issuedAt].join("|"),
  );
}

export function signVoiciShorten(r: VoiciShorten, irk: Keypair): Bytes {
  return ed.sign(canonicalVoiciShorten(r), irk.privateKey);
}
export function verifyVoiciShorten(r: VoiciShorten, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalVoiciShorten(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * Phone request to install an app on this server.
 *
 * Signed by the **host's** IRK — the user whose box will run the
 * app. (Not the app's `creator` — when Bob installs Alice's `game1`
 * on his box, Bob's IRK is the authority because the data lives on
 * Bob's hardware.)
 *
 * The manifest is sent inline (`manifestJson`) so the daemon never
 * has to fetch from a network the phone doesn't trust. The phone
 * either composed the manifest itself, fetched + reviewed it from
 * the LLM harness, or pulled it from a Forgejo repo and is shipping
 * it over.
 *
 * `addOwnerToMembership` defaults to true — the user installing an
 * app generally wants to be a member of it. The phone install screen
 * exposes the toggle so a host installing on behalf of others (e.g.,
 * for the family) can leave themselves out of the membership list.
 */
export interface InstallServiceRequest {
  serverId: ServerId;
  creator: string;
  slug: string;
  /** Stringified `flagship.app.json` — the manifest as the phone reviewed it. */
  manifestJson: string;
  addOwnerToMembership: boolean;
  issuedAt: number;
}

/**
 * Phone request to uninstall a service. IRK-signed by the host. Removes
 * the container, drops the data namespace, and forgets the membership
 * store. Idempotent against an already-uninstalled service.
 */
export interface UninstallServiceRequest {
  serverId: ServerId;
  creator: string;
  slug: string;
  issuedAt: number;
}

function canonicalInstallService(r: InstallServiceRequest): Bytes {
  legacyFieldGuard("creator", r.creator);
  legacyFieldGuard("slug", r.slug);
  // manifestJson is intentionally NOT guarded: it is a JSON blob that can
  // legitimately contain '|'. Its integrity is bound the same way every other
  // field's is — it is part of the signed canonical bytes (a swap fails
  // Ed25519 verify) — and canonical bytes are only ever compared whole, never
  // re-split on '|', so a '|' inside it cannot forge an adjacent-field boundary.
  return new TextEncoder().encode(
    [
      TAG_INSTALL_SERVICE,
      r.serverId,
      r.creator,
      r.slug,
      r.manifestJson,
      r.addOwnerToMembership ? "1" : "0",
      r.issuedAt,
    ].join("|"),
  );
}

function canonicalUninstallService(r: UninstallServiceRequest): Bytes {
  legacyFieldGuard("creator", r.creator);
  legacyFieldGuard("slug", r.slug);
  return new TextEncoder().encode(
    [TAG_UNINSTALL_SERVICE, r.serverId, r.creator, r.slug, r.issuedAt].join("|"),
  );
}

export function signInstallService(r: InstallServiceRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalInstallService(r), irk.privateKey);
}
export function verifyInstallService(r: InstallServiceRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalInstallService(r), irkPub);
  } catch {
    return false;
  }
}

export function signUninstallService(r: UninstallServiceRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalUninstallService(r), irk.privateKey);
}
export function verifyUninstallService(r: UninstallServiceRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalUninstallService(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * Phone/laptop request to set an app's per-app environment variables.
 *
 * IRK-signed by the host — the SAME trust root as install/uninstall.
 * The owner sets `key=value` pairs on an app from the control surface;
 * they are injected into the deployed app's runtime environment and
 * sealed at rest on the box. The vibecoding model sees the env-var
 * NAMES (so generated code can reference them) but NEVER the values.
 *
 * Semantics: **full replace**. `env` is the complete desired set for
 * the app — the daemon stores exactly this map (an empty map clears
 * all env). Full-replace is the simplest correct semantics: the phone
 * always holds the authoritative key list (it's the only place the
 * user types them), so there is no merge ambiguity and a removed key
 * is just absent from the next signed order. The map values are part
 * of the canonical bytes so a MITM can't swap a value against a
 * captured signature; the values are SECRET — the daemon never logs
 * them, never returns them on any surface, and seals them at rest.
 */
export interface SetServiceEnvRequest {
  serverId: ServerId;
  creator: string;
  slug: string;
  /** Full desired env set for the service. Values are SECRET. */
  env: Record<string, string>;
  issuedAt: number;
}

/**
 * Canonical bytes for a set-app-env order. The env map is serialized
 * with keys sorted so the byte string is deterministic regardless of
 * insertion order, then each `name=value` joined under the `|`
 * separator like every other envelope. Both name and value go into
 * the signed bytes (a value swap must invalidate the signature).
 */
function canonicalSetServiceEnv(r: SetServiceEnvRequest): Bytes {
  legacyFieldGuard("creator", r.creator);
  legacyFieldGuard("slug", r.slug);
  const pairs = Object.keys(r.env)
    .sort()
    .map((k) => {
      legacyFieldGuard(`env-key:${k}`, k);
      legacyFieldGuard(`env-value:${k}`, r.env[k]!);
      return `${k}=${r.env[k]}`;
    });
  return new TextEncoder().encode(
    [
      TAG_SET_SERVICE_ENV,
      r.serverId,
      r.creator,
      r.slug,
      String(pairs.length),
      ...pairs,
      r.issuedAt,
    ].join("|"),
  );
}

export function signSetServiceEnv(r: SetServiceEnvRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalSetServiceEnv(r), irk.privateKey);
}
export function verifySetServiceEnv(r: SetServiceEnvRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalSetServiceEnv(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * Pull-request envelope for the app update-pack distribution layer.
 *
 * Signed by the **puller's server identity key** (not the phone). The
 * canonical-home daemon resolves `pullerServerId` to its identity
 * pubkey via `flagshipserver.com /api/server/by-domain/<id>` and then
 * verifies. No phone activity is needed for routine update pulls — the
 * trust grant happened earlier when the puller's host accepted the
 * app share (an IRK-signed membership mutation).
 *
 * `since` is the commit hash the puller already has at HEAD. The home
 * returns a pack of commits between `since` and current `main` tip.
 * Empty string means "first pull, send the full history."
 */
export interface UpdatePullRequest {
  pullerServerId: ServerId;
  /** App identity (creator,slug) — the home cross-checks the puller is in this app's subscriber list. */
  creator: string;
  slug: string;
  /** Commit hash the puller already has, or "" for an initial pull. */
  since: string;
  issuedAt: number;
}

function canonicalUpdatePull(r: UpdatePullRequest): Bytes {
  legacyFieldGuard("creator", r.creator);
  legacyFieldGuard("slug", r.slug);
  legacyFieldGuard("since", r.since);
  return new TextEncoder().encode(
    [
      TAG_UPDATE_PULL,
      r.pullerServerId,
      r.creator,
      r.slug,
      r.since,
      r.issuedAt,
    ].join("|"),
  );
}

export function signUpdatePull(r: UpdatePullRequest, identity: Keypair): Bytes {
  return ed.sign(canonicalUpdatePull(r), identity.privateKey);
}

export function verifyUpdatePull(r: UpdatePullRequest, sig: Bytes, identityPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalUpdatePull(r), identityPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// ServiceAccessInvite (#79) — single-use access secret for inviting
// specific people to a pod-resident service. Distinct from the legacy
// InviteToken (used for membership / cross-pod service collaboration).
// The access invite uses an opaqueTag to keep the recipient's identity
// off the server; the owner's phone keeps the tag→displayName map locally.
//
// expectedIrkPubKey is optional: when set, only that exact IRK can
// consume the invite. When null, first-IRK-to-redeem wins (bearer
// model; combined with short TTL + atomic single-use, this is the
// pattern users invoke when they don't yet know the recipient's IRK).
// ──────────────────────────────────────────────────────────────────────

export interface ServiceAccessInvite {
  /** Fresh UUID; consumers reject duplicates. */
  inviteId: string;
  /** Service canonical (serviceName@authorStableId). */
  serviceCanonical: string;
  /** SHA-256 hex of the random secret embedded in the share-link fragment. */
  secretHash: string;
  /** Role granted on consumption (e.g. "admin", "reader"). */
  role: string;
  /** 16-byte opaque tag — issuer-private mapping to a human label. */
  opaqueTag: Bytes;
  /** Optional pre-binding to a known recipient. null = bearer. */
  expectedIrkPubKey: Bytes | null;
  /** Optional context note the consumer sees before consuming. */
  contextNote: string | null;
  issuedAt: number;
  expiresAt: number;
}

function canonicalServiceAccessInvite(i: ServiceAccessInvite): Bytes {
  validateNoSepCtrl("inviteId", i.inviteId);
  validateNoSepCtrl("serviceCanonical", i.serviceCanonical);
  validateNoSepCtrl("role", i.role);
  validateNoSepCtrl("secretHash", i.secretHash);
  if (i.contextNote !== null) validateNoSepCtrl("contextNote", i.contextNote);
  return new TextEncoder().encode(
    [
      TAG_SERVICE_INVITE,
      i.inviteId,
      i.serviceCanonical,
      i.secretHash,
      i.role,
      hex(i.opaqueTag),
      i.expectedIrkPubKey ? hex(i.expectedIrkPubKey) : "",
      i.contextNote ?? "",
      i.issuedAt,
      i.expiresAt,
    ].join("|"),
  );
}

export function signServiceAccessInvite(i: ServiceAccessInvite, irk: Keypair): Bytes {
  return ed.sign(canonicalServiceAccessInvite(i), irk.privateKey);
}

export function verifyServiceAccessInvite(i: ServiceAccessInvite, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalServiceAccessInvite(i), irkPub);
  } catch {
    return false;
  }
}

export interface ServiceAccessAcceptance {
  inviteId: string;
  /** SHA-256 hex of the actual secret bytes (must match invite.secretHash). */
  secretHash: string;
  /** Consumer's IRK pubkey — bound to the access record at consumption. */
  consumerIrkPubKey: Bytes;
  acceptedAt: number;
  nonce: Bytes;
}

function canonicalServiceAccessAcceptance(a: ServiceAccessAcceptance): Bytes {
  validateNoSepCtrl("inviteId", a.inviteId);
  validateNoSepCtrl("secretHash", a.secretHash);
  return new TextEncoder().encode(
    [
      TAG_SERVICE_INVITE_ACCEPT,
      a.inviteId,
      a.secretHash,
      hex(a.consumerIrkPubKey),
      a.acceptedAt,
      hex(a.nonce),
    ].join("|"),
  );
}

export function signServiceAccessAcceptance(a: ServiceAccessAcceptance, consumerIrk: Keypair): Bytes {
  return ed.sign(canonicalServiceAccessAcceptance(a), consumerIrk.privateKey);
}

export function verifyServiceAccessAcceptance(
  a: ServiceAccessAcceptance,
  sig: Bytes,
  consumerIrkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServiceAccessAcceptance(a), consumerIrkPub);
  } catch {
    return false;
  }
}
