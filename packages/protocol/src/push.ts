/**
 * Push-token domain — device push-token registration + IRK-signed revoke,
 * plus the vouched cross-device DeviceAdmit envelope (Phase 3b pairing).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and guards are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Push-token registration
//
// The phone registers a device push token (APNs / FCM / WebPush) with
// .com so other devices can reach it. The phone also pre-shares an
// X25519 pubkey at register time; later relays seal payloads to it
// so the Worker forwards opaque ciphertext (cannot read).
// ──────────────────────────────────────────────────────────────────────

export type PushPlatform = "apns" | "fcm" | "webpush";

export interface PushTokenRegister {
  username: string;
  platform: PushPlatform;
  providerToken: string;        // opaque to .com
  pushX25519Pub: Bytes;         // 32 bytes — encryption key for relays
  /**
   * Human-readable device label surfaced in the user's "Trusted devices"
   * list — e.g. "Harry's iPhone", "Pixel 8 — kitchen". The phone supplies
   * this at registration; .com persists it so other devices can show a
   * recognisable name rather than a token-id. Treated as opaque text:
   * the Worker sanitizes length + control chars but never interprets
   * the content.
   */
  label: string;
  issuedAt: number;
}

const TAG_PUSH_TOKEN_REGISTER = "flagship/push-token-register/v1";

function canonicalPushTokenRegister(r: PushTokenRegister): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("providerToken", r.providerToken);
  legacyFieldGuard("label", r.label);
  return new TextEncoder().encode(
    [
      TAG_PUSH_TOKEN_REGISTER,
      r.username,
      r.platform,
      r.providerToken,
      hex(r.pushX25519Pub),
      r.label,
      r.issuedAt,
    ].join("|"),
  );
}

export function signPushTokenRegister(r: PushTokenRegister, irk: Keypair): Bytes {
  return ed.sign(canonicalPushTokenRegister(r), irk.privateKey);
}

export function verifyPushTokenRegister(r: PushTokenRegister, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPushTokenRegister(r), irkPub);
  } catch {
    return false;
  }
}

/**
 * IRK-signed push-token REVOKE — the authentication primitive for
 * `DELETE /api/push/<token-id>`.
 *
 * Before this existed, the revoke handler discarded the body and deleted
 * unconditionally, so anyone who learned a 16-byte hex tokenId could
 * silently kill a device's push registration — including boot-unlock
 * approval pushes and security alerts. Revoke is now proven by the
 * account IRK: `.com` resolves the token's owner username from the row,
 * looks up that user's registered IRK pub, and verifies this signature
 * before removing. The envelope binds the `tokenId` + `issuedAt`, so a
 * captured signature can't be re-aimed at a different token nor replayed
 * outside the freshness window.
 *
 * Canonical bytes (byte-identical across TS/Swift/Kotlin + the webapp;
 * pinned by tests/pushTokenRevoke.test.ts):
 *
 *   flagship/push-token-revoke/v1|<tokenId>|<issuedAt>
 */
export interface PushTokenRevoke {
  tokenId: string;
  issuedAt: number;
}

const TAG_PUSH_TOKEN_REVOKE = "flagship/push-token-revoke/v1";

export function canonicalPushTokenRevoke(r: PushTokenRevoke): Bytes {
  legacyFieldGuard("tokenId", r.tokenId);
  return new TextEncoder().encode(
    [TAG_PUSH_TOKEN_REVOKE, r.tokenId, r.issuedAt].join("|"),
  );
}

export function signPushTokenRevoke(r: PushTokenRevoke, irk: Keypair): Bytes {
  return ed.sign(canonicalPushTokenRevoke(r), irk.privateKey);
}

export function verifyPushTokenRevoke(r: PushTokenRevoke, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPushTokenRevoke(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Device-admit (Phase 3b — vouched cross-device pairing)
//
// A collaborator joins an account by scanning the admin's pairing QR.
// Over the sealed QrRelay the incoming device sends its FRESH device
// pubkey; the admin confirms the SAS and signs a DeviceAdmit binding
// that pubkey. The incoming device presents the envelope to .com on
// register; .com verifies it under the account's CURRENT IRK (the
// admin/vouching device holds that key) and admits the device
// QUARANTINED (14-day non-admin peer window).
//
// The envelope is the unforgeable vouch: only a holder of the
// account's IRK private key can mint it, and it commits to the exact
// `newDevicePubHex` so a captured admit can't be re-aimed at a
// different device. `issuedAt` bounds replay (the route enforces
// ~5-min freshness, same window as push-register).
// ──────────────────────────────────────────────────────────────────────

export interface DeviceAdmit {
  username: string;
  /** The incoming device's freshly-minted pubkey, lowercased hex (32 bytes). */
  newDevicePubHex: string;
  issuedAt: number;
}

const TAG_DEVICE_ADMIT = "flagship/device-admit/v1";

function canonicalDeviceAdmit(a: DeviceAdmit): Bytes {
  legacyFieldGuard("username", a.username);
  legacyFieldGuard("newDevicePubHex", a.newDevicePubHex);
  return new TextEncoder().encode(
    [TAG_DEVICE_ADMIT, a.username, a.newDevicePubHex, a.issuedAt].join("|"),
  );
}

/** Signed by the account's CURRENT IRK (the vouching admin device). */
export function signDeviceAdmit(a: DeviceAdmit, irk: Keypair): Bytes {
  return ed.sign(canonicalDeviceAdmit(a), irk.privateKey);
}

export function verifyDeviceAdmit(a: DeviceAdmit, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalDeviceAdmit(a), irkPub);
  } catch {
    return false;
  }
}
