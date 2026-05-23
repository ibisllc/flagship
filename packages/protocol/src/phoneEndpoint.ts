// ──────────────────────────────────────────────────────────────────────
// Phone-as-tunnel-endpoint protocol layer.
//
// Implements the canonical-bytes envelopes + sign/verify + sealing
// helpers for the "phone as a tunnel endpoint for boot-time secrets"
// architecture (docs/security-phone-as-unlock-endpoint.md).
//
// The booting box fetches its boot secrets (LUKS unlock key,
// entitlement) directly from the user's phone over the
// SNI-passthrough + tunnel-hub chain — `.com` only routes ciphertext,
// wakes the phone via APNs, and acts as a directory. `.com` never sees
// plaintext on any path.
//
// Envelopes:
//   1. DeviceEndpointClaim   (IRK-signed) — phone claims the transient
//                            tunnel endpoint device.<username>.flagship.services
//   2. SecretRequest         (STK-signed) — box asks the phone for a secret
//   3. SealedSecretResponse  (sealed FOR the box's STK) — phone's reply,
//                            bound to the request's nonce + purpose
//   4. AutoUnlockLease v2    (IRK-signed)  — `.com` may STORE a box-sealed
//                            LUKS key + release on reboot, plus LeaseRevocation
//
// RootEntitlement (the phone-signed admission credential for step 5c of
// the handshake) already lives in auth.ts with a first-class IRK
// sign/verify; it is re-exported here for discoverability — see the
// bottom of this file.
// ──────────────────────────────────────────────────────────────────────

import { ed } from "./edSync.js";
import {
  openSealedFromEd25519Recipient,
  sealForEd25519Recipient,
} from "./encryption.js";
import type { Bytes, Keypair } from "./types.js";

function hex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Reject the canonical-bytes separator '|' and control characters in a
 * user/caller-controlled string field, at both sign- and verify-time, so
 * a field containing the separator can never canonicalize ambiguously.
 * Mirrors auth.ts's field guard.
 */
function fieldGuard(name: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) {
      throw new Error(
        `canonical-bytes field "${name}" contains separator '|' at index ${i}`,
      );
    }
    if (c <= 0x1f || c === 0x7f) {
      throw new Error(
        `canonical-bytes field "${name}" contains control char 0x${c.toString(
          16,
        )} at index ${i}`,
      );
    }
  }
}

const TAG_DEVICE_ENDPOINT_CLAIM = "flagship/device-endpoint-claim/v1";
const TAG_SECRET_REQUEST = "flagship/secret-request/v1";
const TAG_SECRET_RESPONSE_CTX = "flagship/secret-response/v1";
const TAG_AUTO_UNLOCK_LEASE_V2 = "flagship/auto-unlock-lease/v2";
const TAG_AUTO_UNLOCK_LEASE_REVOKE = "flagship/auto-unlock-lease-revoke/v1";

// ──────────────────────────────────────────────────────────────────────
// 1. DeviceEndpointClaim — IRK-signed.
//
// Lets the phone claim the transient tunnel endpoint
// `<endpointLabel>.<username>.flagship.services` over the same RCK/hub/DNS
// path servers use. The IRK is the root identity, so claiming the user's
// own device endpoint is natural self-authorization. The hub verifies
// this against the user's IRK to route the endpoint to the phone's WSS;
// the registration is transient (drops when the WSS closes).
//
// `expiresAt` is short (minutes) — the endpoint only needs to be live for
// the duration of a single boot handshake, and a short window bounds the
// blast radius of a captured claim. `nonce` makes each claim unique so a
// captured claim can't be re-presented to re-open a closed endpoint.
// ──────────────────────────────────────────────────────────────────────

export interface DeviceEndpointClaim {
  /** User-zone owner — the middle label of the endpoint FQDN. */
  username: string;
  /** Left-most label of the endpoint FQDN (e.g. "device", or a device label). */
  endpointLabel: string;
  /** The phone's IRK pubkey (32 bytes) — the key this claim is verified against. */
  phoneIrkPub: Bytes;
  issuedAt: number;
  /** Short-lived: ms since epoch, typically a few minutes after issuedAt. */
  expiresAt: number;
  /** 32 random bytes — per-claim uniqueness / replay handle. */
  nonce: Bytes;
}

function canonicalDeviceEndpointClaim(c: DeviceEndpointClaim): Bytes {
  fieldGuard("username", c.username);
  fieldGuard("endpointLabel", c.endpointLabel);
  return new TextEncoder().encode(
    [
      TAG_DEVICE_ENDPOINT_CLAIM,
      c.username,
      c.endpointLabel,
      hex(c.phoneIrkPub),
      c.issuedAt,
      c.expiresAt,
      hex(c.nonce),
    ].join("|"),
  );
}

export function signDeviceEndpointClaim(c: DeviceEndpointClaim, irk: Keypair): Bytes {
  return ed.sign(canonicalDeviceEndpointClaim(c), irk.privateKey);
}

export function verifyDeviceEndpointClaim(
  c: DeviceEndpointClaim,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalDeviceEndpointClaim(c), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// 2. SecretRequest — STK-signed.
//
// The booting box asks the phone for a boot secret. Signed by the box's
// STK (server identity key) so the phone can authenticate the caller as
// "the STK `.com` bound to this user" (the directory check), independent
// of whatever the transport claims. `nonce` is fresh per request and is
// what the phone's `SealedSecretResponse` binds to (anti-replay). `purpose`
// scopes the request so a response for one purpose can't be repurposed.
// ──────────────────────────────────────────────────────────────────────

export const SECRET_PURPOSES = ["unlock-key", "entitlement"] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

export interface SecretRequest {
  /** The box's canonical FQDN, e.g. `kitchen.john.flagship.services`. */
  serverDomain: string;
  /** The box's STK pubkey (32 bytes) — the key this request is verified against. */
  stkPub: Bytes;
  /** What the box is asking for. */
  purpose: SecretPurpose;
  /** 32 random bytes — fresh per request; the response is bound to this. */
  nonce: Bytes;
  issuedAt: number;
}

function canonicalSecretRequest(r: SecretRequest): Bytes {
  fieldGuard("serverDomain", r.serverDomain);
  return new TextEncoder().encode(
    [
      TAG_SECRET_REQUEST,
      r.serverDomain,
      hex(r.stkPub),
      r.purpose,
      hex(r.nonce),
      r.issuedAt,
    ].join("|"),
  );
}

export function signSecretRequest(r: SecretRequest, stk: Keypair): Bytes {
  return ed.sign(canonicalSecretRequest(r), stk.privateKey);
}

export function verifySecretRequest(r: SecretRequest, sig: Bytes, stkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalSecretRequest(r), stkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// 3. SealedSecretResponse — the phone's reply.
//
// The secret is sealed FOR the box's STK (via sealForEd25519Recipient —
// the same Ed25519→X25519 birational map the LUKS install path uses), so
// ONLY the box's STK private key can open it. There is NO plaintext field
// on the wire type — the plaintext lives only inside `sealed`. `.com`
// routes the ciphertext and can never read it (invariant I1).
//
// The response is cryptographically bound to the request's `nonce` +
// `purpose`: a fixed-length context header (the canonical bytes of
// (nonce, purpose)) is prepended to the secret *before* sealing, so a
// response minted for one (nonce, purpose) fails to open as another. This
// gives the binding without an AEAD-AAD parameter the underlying seal
// format doesn't carry — the box re-derives the expected header from the
// request it sent and rejects any mismatch. A response therefore can't be
// replayed against a different request or repurposed across purposes.
//
// `requestNonce` / `purpose` are echoed on the wire ONLY as routing /
// matching hints — they are NOT the security boundary (the sealed header
// is). The box still verifies the opened header against the request it
// actually sent.
// ──────────────────────────────────────────────────────────────────────

export interface SealedSecretResponse {
  /** Echo of the originating request's serverDomain (routing hint). */
  serverDomain: string;
  /** Echo of the originating request's nonce, hex (matching hint, not the boundary). */
  requestNonceHex: string;
  /** Echo of the originating request's purpose (matching hint, not the boundary). */
  purpose: SecretPurpose;
  /**
   * The secret, sealed for the request's stkPub with a bound context
   * header. Opening requires the box's STK private key AND a matching
   * (nonce, purpose). NEVER plaintext.
   */
  sealed: Bytes;
  issuedAt: number;
}

/**
 * The context bytes prepended to the secret before sealing. Binds the
 * sealed payload to the exact (nonce, purpose) of the request so the
 * box can detect a replayed/repurposed response on open. Length-prefixed
 * so the secret can be any length and the split is unambiguous.
 */
function secretResponseContext(nonce: Bytes, purpose: SecretPurpose): Bytes {
  return new TextEncoder().encode(
    [TAG_SECRET_RESPONSE_CTX, hex(nonce), purpose].join("|"),
  );
}

function concatBytes(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Phone-side: seal `secret` for the box's STK, bound to the request's
 * (nonce, purpose). The phone has already verified the request's STK
 * against the directory + the user's visual confirm before calling this.
 * Returns the wire-ready `SealedSecretResponse` — `.com` cannot read it.
 */
export function buildSealedSecretResponse(
  secret: Bytes,
  request: SecretRequest,
): SealedSecretResponse {
  const ctx = secretResponseContext(request.nonce, request.purpose);
  // [ctxLen:4 BE][ctx][secret] — length-prefixed so open can split cleanly.
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, ctx.length, false);
  const payload = concatBytes(concatBytes(header, ctx), secret);
  const sealed = sealForEd25519Recipient(payload, request.stkPub);
  return {
    serverDomain: request.serverDomain,
    requestNonceHex: hex(request.nonce),
    purpose: request.purpose,
    sealed,
    issuedAt: Date.now(),
  };
}

/**
 * Box-side: open a `SealedSecretResponse` with the box's STK private key,
 * verifying the embedded context against the request the box actually
 * sent. Throws if the STK can't open the seal OR the bound (nonce,
 * purpose) doesn't match — so a response for a different request/purpose
 * is rejected, not silently accepted. Returns the recovered secret.
 *
 * `stkPriv` is the 32-byte STK Ed25519 seed (the `privateKey` half of the
 * box's STK Keypair).
 */
export function openSealedSecretResponse(
  response: SealedSecretResponse,
  request: SecretRequest,
  stkPriv: Bytes,
): Bytes {
  const payload = openSealedFromEd25519Recipient(response.sealed, stkPriv);
  if (payload.length < 4) {
    throw new Error("sealed secret response payload too short");
  }
  const ctxLen = new DataView(
    payload.buffer,
    payload.byteOffset,
    4,
  ).getUint32(0, false);
  if (payload.length < 4 + ctxLen) {
    throw new Error("sealed secret response payload truncated");
  }
  const ctx = payload.slice(4, 4 + ctxLen);
  const expected = secretResponseContext(request.nonce, request.purpose);
  if (ctx.length !== expected.length) {
    throw new Error("sealed secret response bound to a different (nonce, purpose)");
  }
  for (let i = 0; i < ctx.length; i++) {
    if (ctx[i] !== expected[i]) {
      throw new Error(
        "sealed secret response bound to a different (nonce, purpose)",
      );
    }
  }
  return payload.slice(4 + ctxLen);
}

// ──────────────────────────────────────────────────────────────────────
// 4. AutoUnlockLease v2 — box-sealed, IRK-signed.
//
// Authorizes `.com` to STORE a LUKS key sealed for the box's STK and
// release the SEALED blob on reboot — never plaintext. The box pulls the
// sealed blob and unseals it itself with its STK private key. This encodes
// the §7a rogue-operator invariants structurally:
//
//   I1 (no plaintext at `.com`): the type carries ONLY `sealedKey` — there
//      is NO plaintext key field. `.com` holds ciphertext on this path
//      exactly as on the phone-gated path.
//   I2 (user-anchored, pinned recipient): `stkPub` is signed into the
//      lease by the user's IRK and is the seal recipient. `.com` cannot
//      retarget the seal to a box it controls — the recipient is pinned at
//      lease creation by the user-anchored signature.
//
// This is the opt-in (defaults OFF) unattended-reboot fallback; first boot
// always requires the phone. `maxUses` optionally bounds how many reboots
// a single lease covers (omitted ⇒ unbounded until `expiresAt`).
//
// `LeaseRevocation` (IRK-signed) is the kill switch — revoking a lease
// before a reboot locks out a colluding operator+host who would otherwise
// reuse the sealed key.
// ──────────────────────────────────────────────────────────────────────

export interface AutoUnlockLeaseV2 {
  /** The box's canonical FQDN this lease unlocks. */
  serverDomain: string;
  /**
   * The PINNED recipient: the box's STK pubkey (32 bytes). `sealedKey` is
   * sealed for THIS key; the user's IRK signature pins it so `.com` cannot
   * retarget the seal (invariant I2).
   */
  stkPub: Bytes;
  /** Unique handle for this lease (16+ hex chars) — the revoke handle. */
  leaseId: string;
  /**
   * The LUKS key, sealed for `stkPub` (sealForEd25519Recipient). The ONLY
   * representation of the key on this type — there is no plaintext field
   * (invariant I1).
   */
  sealedKey: Bytes;
  issuedAt: number;
  /** Wall-clock ms after which the lease is no longer valid. */
  expiresAt: number;
  /**
   * Optional cap on the number of releases (reboots) this lease covers.
   * Omitted ⇒ unbounded until `expiresAt`. Encoded as -1 in the canonical
   * bytes when absent so signer/verifier agree on the "no cap" case.
   */
  maxUses?: number;
}

function canonicalAutoUnlockLeaseV2(l: AutoUnlockLeaseV2): Bytes {
  fieldGuard("serverDomain", l.serverDomain);
  fieldGuard("leaseId", l.leaseId);
  return new TextEncoder().encode(
    [
      TAG_AUTO_UNLOCK_LEASE_V2,
      l.serverDomain,
      hex(l.stkPub),
      l.leaseId,
      hex(l.sealedKey),
      l.issuedAt,
      l.expiresAt,
      l.maxUses ?? -1,
    ].join("|"),
  );
}

export function signAutoUnlockLeaseV2(l: AutoUnlockLeaseV2, irk: Keypair): Bytes {
  return ed.sign(canonicalAutoUnlockLeaseV2(l), irk.privateKey);
}

export function verifyAutoUnlockLeaseV2(
  l: AutoUnlockLeaseV2,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAutoUnlockLeaseV2(l), irkPub);
  } catch {
    return false;
  }
}

/**
 * Convenience builder: seal `luksKey` for `stkPub` and assemble a v2
 * lease. Keeps callers from ever holding a plaintext key field on the
 * lease type. The caller signs the returned lease with the user's IRK.
 */
export function buildAutoUnlockLeaseV2(args: {
  serverDomain: string;
  stkPub: Bytes;
  leaseId: string;
  luksKey: Bytes;
  issuedAt: number;
  expiresAt: number;
  maxUses?: number;
}): AutoUnlockLeaseV2 {
  const lease: AutoUnlockLeaseV2 = {
    serverDomain: args.serverDomain,
    stkPub: args.stkPub,
    leaseId: args.leaseId,
    sealedKey: sealForEd25519Recipient(args.luksKey, args.stkPub),
    issuedAt: args.issuedAt,
    expiresAt: args.expiresAt,
  };
  if (args.maxUses !== undefined) lease.maxUses = args.maxUses;
  return lease;
}

/**
 * Box-side: recover the LUKS key from a v2 lease using the box's STK
 * private key. Throws if the box's STK is not the pinned recipient.
 * `stkPriv` is the 32-byte STK Ed25519 seed.
 */
export function openAutoUnlockLeaseV2(l: AutoUnlockLeaseV2, stkPriv: Bytes): Bytes {
  return openSealedFromEd25519Recipient(l.sealedKey, stkPriv);
}

/**
 * IRK-signed revocation of a v2 auto-unlock lease — the kill switch from
 * any of the user's devices. `.com` drops the stored sealed blob so a
 * subsequent reboot can't release it.
 */
export interface LeaseRevocation {
  serverDomain: string;
  leaseId: string;
  issuedAt: number;
}

function canonicalLeaseRevocation(r: LeaseRevocation): Bytes {
  fieldGuard("serverDomain", r.serverDomain);
  fieldGuard("leaseId", r.leaseId);
  return new TextEncoder().encode(
    [TAG_AUTO_UNLOCK_LEASE_REVOKE, r.serverDomain, r.leaseId, r.issuedAt].join("|"),
  );
}

export function signLeaseRevocation(r: LeaseRevocation, irk: Keypair): Bytes {
  return ed.sign(canonicalLeaseRevocation(r), irk.privateKey);
}

export function verifyLeaseRevocation(
  r: LeaseRevocation,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalLeaseRevocation(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// 5. Phone-signed RootEntitlement.
//
// The phone-signed admission credential (handshake step 5c, entitlement
// variant) already has a first-class IRK sign/verify in auth.ts:
//
//   signRootEntitlement(c, irk)   — IRK signs (username, podPubKey/stkPub,
//                                   podCanonical, issuedAt)
//   verifyRootEntitlement(c, sig, irkPub)
//
// The hub verifies these against the user's IRK when `irkLookup` is
// enabled. They are NOT re-implemented here; tests for the phone-signing
// primitive live alongside this module's tests. See auth.ts for the type.
// ──────────────────────────────────────────────────────────────────────
