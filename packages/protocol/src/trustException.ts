/**
 * TrustException — an owner-signed, per-cert override that un-sticks a box
 * (or app) from a broken-trust state (docs/maintainer-trust-enforcement.md
 * § "Recovery").
 *
 * When a control-blessing or relay-blessing is expired/invalid and the
 * owner deliberately decides to keep using the degraded system, the
 * granting phone signs a TrustException with its DEVICE key, scoped to
 * exactly ONE cert-hash. It is propagated via `.com` — safe even when
 * `.com` is the suspected party, because it is device-key-signed and
 * cert-hash-scoped: `.com` can drop or replay it but cannot forge it, and
 * replaying "accept cert X" is harmless (it only ever re-affirms a degraded
 * state the owner already chose). It is verified against the IRK-anchored
 * DEVICE SET, never a `.com`-asserted roster.
 *
 * Canonical tag: `flagship/trust-exception/v1`
 * Field order:   certClass | certHash | grantedAt | grantedByDevicePub
 *
 * cert-hash slugs (the two failure classes):
 *   control = sha256hex(utf8(caPubkey))   — the `.com` hot CA key
 *   relay   = sha256hex(utf8(hubKeyPub))  — the `.services` hub key
 */

import { sha256 } from "@noble/hashes/sha256";
import { legacyFieldGuard } from "./auth.js";
import { ed } from "./edSync.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_TRUST_EXCEPTION = "flagship/trust-exception/v1";

export type TrustExceptionCertClass = "control" | "relay";

export interface TrustException {
  kind: "TrustException";
  version: 1;
  certClass: TrustExceptionCertClass;
  /** sha256hex of the offending key (see module doc for which key). */
  certHash: string;
  grantedAt: number;
  /** lower-hex Ed25519 pubkey of the granting phone's device key. */
  grantedByDevicePub: string;
  signatures: { pubkey: string; sig: string }[];
}

function hexToBytes(h: string): Bytes {
  if (h.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** sha256hex of the utf8 bytes of a key — the cert-hash slug primitive. */
export function trustExceptionCertHash(keyHex: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(keyHex)));
}

/** control-class cert-hash = sha256hex(utf8(caPubkey)). */
export function controlCertHash(caPubkey: string): string {
  return trustExceptionCertHash(caPubkey);
}

/** relay-class cert-hash = sha256hex(utf8(hubKeyPub)). */
export function relayCertHash(hubKeyPub: string): string {
  return trustExceptionCertHash(hubKeyPub);
}

export function canonicalTrustException(
  e: Pick<
    TrustException,
    "certClass" | "certHash" | "grantedAt" | "grantedByDevicePub"
  >,
): Bytes {
  legacyFieldGuard("certClass", e.certClass);
  legacyFieldGuard("certHash", e.certHash);
  legacyFieldGuard("grantedByDevicePub", e.grantedByDevicePub);
  return new TextEncoder().encode(
    [
      TAG_TRUST_EXCEPTION,
      e.certClass,
      e.certHash,
      e.grantedAt,
      e.grantedByDevicePub,
    ].join("|"),
  );
}

/**
 * Sign a TrustException with the granting phone's DEVICE keypair.
 * `grantedByDevicePub` is set to that device's pubkey and the single
 * signature is attached.
 */
export function signTrustException(
  unsigned: Pick<TrustException, "certClass" | "certHash" | "grantedAt"> & {
    grantedByDevicePub?: string;
  },
  deviceKeypair: Keypair,
): TrustException {
  const devicePub = bytesToHex(deviceKeypair.publicKey);
  const fields = {
    certClass: unsigned.certClass,
    certHash: unsigned.certHash,
    grantedAt: unsigned.grantedAt,
    grantedByDevicePub: devicePub,
  };
  const sig = ed.sign(canonicalTrustException(fields), deviceKeypair.privateKey);
  return {
    kind: "TrustException",
    version: 1,
    ...fields,
    signatures: [{ pubkey: devicePub, sig: bytesToHex(sig) }],
  };
}

export type TrustExceptionReject =
  | "device-not-in-roster"
  | "signature-unverified"
  | "malformed";

/**
 * Verify a TrustException against the IRK-anchored device set.
 *
 * `ok` iff `grantedByDevicePub` is in `allowedDevicePubs` (the roster
 * resolved from the user's IRK — NEVER a `.com`-asserted list) AND a
 * matching signature over the canonical bytes verifies under it.
 *
 * Replay is harmless by design, so there is no TTL on the exception
 * itself; `now` is accepted for interface symmetry / future windowing but
 * is not consulted today.
 */
export function verifyTrustException(
  e: TrustException,
  allowedDevicePubs: readonly string[],
  _now?: number,
): { ok: true } | { ok: false; reason: TrustExceptionReject } {
  if (
    !e ||
    typeof e.grantedByDevicePub !== "string" ||
    !Array.isArray(e.signatures)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const granter = e.grantedByDevicePub.toLowerCase();
  const roster = new Set(allowedDevicePubs.map((k) => k.toLowerCase()));
  if (!roster.has(granter)) {
    return { ok: false, reason: "device-not-in-roster" };
  }
  let msg: Bytes;
  try {
    msg = canonicalTrustException(e);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  for (const entry of e.signatures) {
    if (entry.pubkey.toLowerCase() !== granter) continue;
    let pubBytes: Bytes;
    let sigBytes: Bytes;
    try {
      pubBytes = hexToBytes(granter);
      sigBytes = hexToBytes(entry.sig);
    } catch {
      continue;
    }
    try {
      if (ed.verify(sigBytes, msg, pubBytes)) return { ok: true };
    } catch {
      /* next */
    }
  }
  return { ok: false, reason: "signature-unverified" };
}
