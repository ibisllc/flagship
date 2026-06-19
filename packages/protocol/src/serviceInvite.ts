/**
 * Service-access capability invites (docs/service-access-gating.md) — the
 * `flagship/service-invite/v1` tag family for the UMK-anchored, first-bind,
 * bearer-link access model.
 *
 * Identity is the stable **AID** (`deriveAccountId(UMK)`), NOT the versioned
 * IRK. The author's IRK SIGNS create + revoke (active orders by the current
 * device key); the friend is IDENTIFIED by — and signs redeem with — their
 * AID. See the spec's "Identity / stability" + "Flows".
 *
 * Three envelopes:
 *   - create  (IRK-signed by the author; carries `authorAID`)
 *   - redeem  (AID-signed by the friend; first redeem binds the invite)
 *   - revoke  (IRK-signed by the author; by inviteId)
 *
 * Plus the value-blind bundle: `{ name, photo? }` sealed under the household
 * key (`deriveHouseholdKey(UMK)`), so flagshipserver.com — which never holds
 * the UMK — stores ciphertext only and cannot read the friend's name/photo.
 *
 * NOTE: distinct from the pre-existing `ServiceAccessInvite` (#79,
 * `flagship/service-invite/v1` single-use IRK-bound model in
 * serviceLifecycle.ts). This family uses DIFFERENT sub-tags
 * (`flagship/service-invite/{create,redeem,revoke}/v1` + the bundle's
 * `flagship/service-invite/bundle/v1` AEAD AAD tag), so the two never share
 * canonical bytes.
 */
import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, validateNoSepCtrl } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_CREATE = "flagship/service-invite/create/v1";
const TAG_REDEEM = "flagship/service-invite/redeem/v1";
const TAG_REVOKE = "flagship/service-invite/revoke/v1";
const TAG_ACCEPT = "flagship/service-invite/accept/v1";
const TAG_INVITE_ID = "flagship/service-invite/id/v1";
const TAG_BUNDLE = "flagship/service-invite/bundle/v1";
const TAG_ACCESS_MODE = "flagship/service-access-mode/v1";
const TAG_VISIT = "flagship/service-visit/v1";
const TAG_KNOCK = "flagship/service-knock/v1";
const TAG_ALLOW_REMOVE = "flagship/service-allow-remove/v1";

// ──────────────────────────────────────────────────────────────────────
// Invite id — `hash(AID_author) · hash(devicePub_author) · counter`.
//
// Unique, attributable to the author account AND the creating device, and
// monotonic per (account, device). Used as the revocation key + the edge in
// the who-authorized-whom graph. Stable hex string (64 chars).
// ──────────────────────────────────────────────────────────────────────

/**
 * Derive the deterministic inviteId from the author's stable AID pubkey, the
 * creating device's pubkey, and a monotonic per-(account, device) counter.
 * SHA-256 over the canonical tuple; returned as lowercase hex.
 */
export function serviceInviteId(
  authorAidPub: Bytes,
  authorDevicePub: Bytes,
  counter: number,
): string {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error("serviceInviteId: counter must be a non-negative integer");
  }
  const bytes = new TextEncoder().encode(
    [
      TAG_INVITE_ID,
      hex(sha256(authorAidPub)),
      hex(sha256(authorDevicePub)),
      String(counter),
    ].join("|"),
  );
  return hex(sha256(bytes));
}

// ──────────────────────────────────────────────────────────────────────
// The value-blind bundle — `{ name, photo? }` sealed under the household key.
//
// AES-256-GCM with a random 12-byte nonce; the AAD pins the AEAD to this
// purpose + the inviteId so a sealed bundle can't be lifted onto a different
// invite. Wire layout (hex): [nonce: 12 B][ciphertext + GCM tag: var].
// ──────────────────────────────────────────────────────────────────────

export interface InviteBundle {
  /** Display name the author assigns the friend (issuer-private). */
  name: string;
  /** Optional avatar — opaque (e.g. a data URI or base64); never inspected. */
  photo?: string;
}

function bundleAad(inviteId: string): Bytes {
  return new TextEncoder().encode([TAG_BUNDLE, inviteId].join("|"));
}

/**
 * Seal `{ name, photo? }` under the household key, bound to `inviteId`.
 * Returns lowercase hex of `nonce || ciphertext`. flagshipserver.com stores
 * this verbatim and cannot open it (it has no UMK → no household key).
 */
export function sealInviteBundle(
  bundle: InviteBundle,
  householdKey: Bytes,
  inviteId: string,
): string {
  if (householdKey.length !== 32) {
    throw new Error("household key must be 32 bytes");
  }
  const plaintext = new TextEncoder().encode(
    JSON.stringify(
      bundle.photo !== undefined
        ? { name: bundle.name, photo: bundle.photo }
        : { name: bundle.name },
    ),
  );
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ct = gcm(householdKey, nonce, bundleAad(inviteId)).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return hex(out);
}

/**
 * Open a bundle sealed by `sealInviteBundle`. Throws on a bad key / tampered
 * ciphertext / wrong inviteId (the GCM tag + AAD fail). The author's sibling
 * devices and the author's boxes (all UMK-holders) can open it; .com cannot.
 */
export function openInviteBundle(
  sealedHex: string,
  householdKey: Bytes,
  inviteId: string,
): InviteBundle {
  if (householdKey.length !== 32) {
    throw new Error("household key must be 32 bytes");
  }
  const buf = hexToBytes(sealedHex);
  if (buf.length < 12) throw new Error("sealed bundle too short");
  const nonce = buf.slice(0, 12);
  const ct = buf.slice(12);
  const plain = gcm(householdKey, nonce, bundleAad(inviteId)).decrypt(ct);
  const obj = JSON.parse(new TextDecoder().decode(plain)) as unknown;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("malformed bundle");
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.name !== "string") throw new Error("malformed bundle: name");
  const result: InviteBundle = { name: o.name };
  if (typeof o.photo === "string") result.photo = o.photo;
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Create — IRK-signed by the author; carries the author's stable AID.
// ──────────────────────────────────────────────────────────────────────

export interface CreateServiceInvite {
  inviteId: string;
  /** Author's stable AID pubkey — the identity recorded as the inviter. */
  authorAID: Bytes;
  /** Which service this invite grants — `<creator>-<slug>` or canonical FQDN. */
  serviceRef: string;
  /** SHA-256 hex of the random 32-byte capability secret in the link. */
  secretHash: string;
  /** Hex of the sealed `{name, photo?}` bundle (`.com` stores ciphertext only). */
  encryptedBundle: string;
  issuedAt: number;
  /**
   * GROUP / multi-use cap (v2): max redemptions, 0 = unlimited. ABSENT ⇒ a
   * single-use personal invite (the v1 behavior). Group links are auto-approve
   * by construction (no per-person confirm) + lower-trust; `maxN` bounds the
   * blast radius of a leaked link. Appended to the canonical bytes only when
   * present, so a v1 (no-maxN) create signs/verifies byte-identically.
   */
  maxRedemptions?: number;
  /** Optional expiry (epoch-ms) — recommended for group links. Same append rule. */
  expiresAt?: number;
}

function canonicalCreate(c: CreateServiceInvite): Bytes {
  validateNoSepCtrl("inviteId", c.inviteId);
  validateNoSepCtrl("serviceRef", c.serviceRef);
  validateNoSepCtrl("secretHash", c.secretHash);
  validateNoSepCtrl("encryptedBundle", c.encryptedBundle);
  const parts: (string | number)[] = [
    TAG_CREATE,
    c.inviteId,
    hex(c.authorAID),
    c.serviceRef,
    c.secretHash,
    c.encryptedBundle,
    c.issuedAt,
  ];
  // Backward-compatible: append ONLY when present (absent ⇒ v1 bytes). Order is
  // fixed (maxN then exp) so the pre-image is deterministic.
  if (c.maxRedemptions !== undefined) {
    if (!Number.isInteger(c.maxRedemptions) || c.maxRedemptions < 0) {
      throw new Error("maxRedemptions must be a non-negative integer");
    }
    parts.push(`maxN=${c.maxRedemptions}`);
  }
  if (c.expiresAt !== undefined) {
    if (!Number.isInteger(c.expiresAt) || c.expiresAt < 0) {
      throw new Error("expiresAt must be a non-negative integer");
    }
    parts.push(`exp=${c.expiresAt}`);
  }
  return new TextEncoder().encode(parts.join("|"));
}

export function signCreateServiceInvite(c: CreateServiceInvite, irk: Keypair): Bytes {
  return ed.sign(canonicalCreate(c), irk.privateKey);
}

export function verifyCreateServiceInvite(
  c: CreateServiceInvite,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalCreate(c), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Redeem — AID-signed by the FRIEND. The first redeem binds the invite to
// the friend's AID; a re-redeem by the SAME AID is idempotent (the UMK,
// hence the AID, is unchanged across the friend's IRK rotations / new
// devices — that is the entire point of anchoring to the AID).
// ──────────────────────────────────────────────────────────────────────

export interface RedeemServiceInvite {
  /** SHA-256 hex of the actual secret the friend pulled from the link. */
  secretHash: string;
  /** Friend's stable AID pubkey — bound to the invite on first redeem. */
  visitorAID: Bytes;
  redeemedAt: number;
}

function canonicalRedeem(r: RedeemServiceInvite): Bytes {
  validateNoSepCtrl("secretHash", r.secretHash);
  return new TextEncoder().encode(
    [TAG_REDEEM, r.secretHash, hex(r.visitorAID), r.redeemedAt].join("|"),
  );
}

export function signRedeemServiceInvite(
  r: RedeemServiceInvite,
  visitorAid: Keypair,
): Bytes {
  return ed.sign(canonicalRedeem(r), visitorAid.privateKey);
}

export function verifyRedeemServiceInvite(
  r: RedeemServiceInvite,
  sig: Bytes,
  visitorAidPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRedeem(r), visitorAidPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Accept — the MANUAL-APPROVE out-of-band loop (v2 Phase 3, tier 2).
//
// For a "sensitive" personal invite the author wants to confirm it's really
// their friend WITHOUT learning the friend's username (the owner-privacy
// requirement). Flow: author sends the link → the friend's app emits THIS
// acceptance (signed by the friend's PER-AUTHOR contact AID) → the friend
// replies it back through the SAME private channel → the author's app opens it
// and submits it to the AUTHOR'S OWN box, which verifies the friend's signature
// + the owner's create, then binds the contact AID. The author FINALIZES the
// loop, so a thief who only grabbed the link can't produce an acceptance the
// author will open from their friend-channel (channel-trust + author-finalization,
// not cryptographic against an in-channel attacker — matches the threat model).
// ──────────────────────────────────────────────────────────────────────

export interface AcceptServiceInvite {
  inviteId: string;
  /** `<creator>-<slug>` the invite grants — binds the acceptance to its service. */
  serviceRef: string;
  /** The friend's PER-AUTHOR contact AID pubkey to be bound (`deriveContactAccountId`). */
  contactAID: Bytes;
  acceptedAt: number;
}

function canonicalAccept(a: AcceptServiceInvite): Bytes {
  validateNoSepCtrl("inviteId", a.inviteId);
  validateNoSepCtrl("serviceRef", a.serviceRef);
  return new TextEncoder().encode(
    [TAG_ACCEPT, a.inviteId, a.serviceRef, hex(a.contactAID), a.acceptedAt].join("|"),
  );
}

export function signAcceptServiceInvite(a: AcceptServiceInvite, contactAid: Keypair): Bytes {
  return ed.sign(canonicalAccept(a), contactAid.privateKey);
}

export function verifyAcceptServiceInvite(
  a: AcceptServiceInvite,
  sig: Bytes,
  contactAidPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAccept(a), contactAidPub);
  } catch {
    return false;
  }
}

/**
 * A random 128-bit invite id (32 hex chars × 2 = 64-char lowercase hex), the v2
 * replacement for the structured `serviceInviteId` (which baked `hash(devicePub)`
 * into the id — a device-fingerprint leak via the listing, v2 §M2). Carries the
 * same uniqueness with zero metadata; attribution stays in the stored `authorAID`.
 */
export function randomServiceInviteId(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return hex(b);
}

// ──────────────────────────────────────────────────────────────────────
// Revoke — IRK-signed by the author, by inviteId.
// ──────────────────────────────────────────────────────────────────────

export interface RevokeServiceInvite {
  inviteId: string;
  issuedAt: number;
}

function canonicalRevoke(r: RevokeServiceInvite): Bytes {
  validateNoSepCtrl("inviteId", r.inviteId);
  return new TextEncoder().encode([TAG_REVOKE, r.inviteId, r.issuedAt].join("|"));
}

export function signRevokeServiceInvite(r: RevokeServiceInvite, irk: Keypair): Bytes {
  return ed.sign(canonicalRevoke(r), irk.privateKey);
}

export function verifyRevokeServiceInvite(
  r: RevokeServiceInvite,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRevoke(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Set per-service access mode — owner-IRK-signed, served on the box's OWN
// pinned pipe (the `/api/power` / `/api/front-page` shape, NOT the dead PSK
// orders surface). `restricted` gates the service to its bound AID allow-list;
// `open` (the default) lets anyone. The box verifies against its config-pinned
// owner IRK.
// ──────────────────────────────────────────────────────────────────────

export type ServiceAccessMode = "open" | "restricted";

export interface SetServiceAccessMode {
  serverId: string;
  /** `<creator>-<slug>` service id this mode applies to. */
  serviceRef: string;
  mode: ServiceAccessMode;
  issuedAt: number;
}

function canonicalSetServiceAccessMode(s: SetServiceAccessMode): Bytes {
  validateNoSepCtrl("serverId", s.serverId);
  validateNoSepCtrl("serviceRef", s.serviceRef);
  if (s.mode !== "open" && s.mode !== "restricted") {
    throw new Error("service access mode must be 'open' or 'restricted'");
  }
  return new TextEncoder().encode(
    [TAG_ACCESS_MODE, s.serverId, s.serviceRef, s.mode, s.issuedAt].join("|"),
  );
}

export function signSetServiceAccessMode(s: SetServiceAccessMode, irk: Keypair): Bytes {
  return ed.sign(canonicalSetServiceAccessMode(s), irk.privateKey);
}

export function verifySetServiceAccessMode(
  s: SetServiceAccessMode,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalSetServiceAccessMode(s), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Service-visit proof — AID-signed by the FRIEND, presented on each request
// to a RESTRICTED service so the box can confirm the visitor controls an
// allow-listed AID (the friend's IRK rotates; the AID does not, so the proof
// stays valid across the friend's device changes). The box checks the
// signature + that `visitorAID` is in the service's allow-list, with a short
// replay window on `issuedAt`.
// ──────────────────────────────────────────────────────────────────────

export interface ServiceVisitProof {
  serverId: string;
  serviceRef: string;
  visitorAID: Bytes;
  issuedAt: number;
}

function canonicalServiceVisit(v: ServiceVisitProof): Bytes {
  validateNoSepCtrl("serverId", v.serverId);
  validateNoSepCtrl("serviceRef", v.serviceRef);
  return new TextEncoder().encode(
    [TAG_VISIT, v.serverId, v.serviceRef, hex(v.visitorAID), v.issuedAt].join("|"),
  );
}

export function signServiceVisitProof(v: ServiceVisitProof, visitorAid: Keypair): Bytes {
  return ed.sign(canonicalServiceVisit(v), visitorAid.privateKey);
}

export function verifyServiceVisitProof(
  v: ServiceVisitProof,
  sig: Bytes,
  visitorAidPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServiceVisit(v), visitorAidPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Knock authorization — AID-signed by the visitor's PHONE to authorize a
// SEPARATE browser's QR-login session (docs/service-access-gating.md,
// "Web-experience gating"). A plain browser hitting a restricted service gets a
// knock page carrying a high-entropy single-use `pageId`; the phone verifies its
// AID is allow-listed, then signs THIS envelope (binding the pageId, so a visit
// proof can never be replayed to authorize a different page) and POSTs it to the
// box. The box checks the signature + that `visitorAID` is allow-listed, then
// binds the browser session to that pageId. Short replay window on `issuedAt`.
// ──────────────────────────────────────────────────────────────────────

export interface KnockAuthorization {
  serverId: string;
  serviceRef: string;
  /** The browser's knock-page id this authorization is bound to. */
  pageId: string;
  visitorAID: Bytes;
  issuedAt: number;
}

function canonicalKnock(k: KnockAuthorization): Bytes {
  validateNoSepCtrl("serverId", k.serverId);
  validateNoSepCtrl("serviceRef", k.serviceRef);
  validateNoSepCtrl("pageId", k.pageId);
  return new TextEncoder().encode(
    [TAG_KNOCK, k.serverId, k.serviceRef, k.pageId, hex(k.visitorAID), k.issuedAt].join("|"),
  );
}

export function signKnockAuthorization(k: KnockAuthorization, visitorAid: Keypair): Bytes {
  return ed.sign(canonicalKnock(k), visitorAid.privateKey);
}

export function verifyKnockAuthorization(
  k: KnockAuthorization,
  sig: Bytes,
  visitorAidPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalKnock(k), visitorAidPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Remove-from-allow-list — owner-IRK-signed, served on the box's OWN pinned
// pipe (the `set-service-access-mode` shape). Prunes a single AID from a
// service's allow-list so a revoked / "deleted" friend is denied on their NEXT
// request (`decide` re-checks the allow-list per request, so this also kills any
// live browser cookie bound to that AID). The admin app fires this ALONGSIDE the
// `.com` invite revoke (`.com` records the revocation; this is what actually
// reaches the box — `.com` does not push to the daemon). The box verifies
// against its config-pinned owner IRK.
// ──────────────────────────────────────────────────────────────────────

export interface RemoveServiceAllow {
  serverId: string;
  /** `<creator>-<slug>` service id to prune the AID from. */
  serviceRef: string;
  /** Lower-hex AID pubkey to remove from the allow-list. */
  aid: string;
  issuedAt: number;
}

function canonicalRemoveServiceAllow(s: RemoveServiceAllow): Bytes {
  validateNoSepCtrl("serverId", s.serverId);
  validateNoSepCtrl("serviceRef", s.serviceRef);
  validateNoSepCtrl("aid", s.aid);
  return new TextEncoder().encode(
    [TAG_ALLOW_REMOVE, s.serverId, s.serviceRef, s.aid, s.issuedAt].join("|"),
  );
}

export function signRemoveServiceAllow(s: RemoveServiceAllow, irk: Keypair): Bytes {
  return ed.sign(canonicalRemoveServiceAllow(s), irk.privateKey);
}

export function verifyRemoveServiceAllow(
  s: RemoveServiceAllow,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRemoveServiceAllow(s), irkPub);
  } catch {
    return false;
  }
}

/** SHA-256 hex of a 32-byte capability secret — the form `.com` stores + indexes. */
export function serviceInviteSecretHash(secret: Bytes): string {
  return hex(sha256(secret));
}

function hexToBytes(s: string): Bytes {
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
