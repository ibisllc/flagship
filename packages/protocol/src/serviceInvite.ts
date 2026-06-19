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
const TAG_INVITE_ID = "flagship/service-invite/id/v1";
const TAG_BUNDLE = "flagship/service-invite/bundle/v1";
const TAG_ACCESS_MODE = "flagship/service-access-mode/v1";
const TAG_VISIT = "flagship/service-visit/v1";

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
}

function canonicalCreate(c: CreateServiceInvite): Bytes {
  validateNoSepCtrl("inviteId", c.inviteId);
  validateNoSepCtrl("serviceRef", c.serviceRef);
  validateNoSepCtrl("secretHash", c.secretHash);
  validateNoSepCtrl("encryptedBundle", c.encryptedBundle);
  return new TextEncoder().encode(
    [
      TAG_CREATE,
      c.inviteId,
      hex(c.authorAID),
      c.serviceRef,
      c.secretHash,
      c.encryptedBundle,
      c.issuedAt,
    ].join("|"),
  );
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
