/**
 * Shared canonical-bytes primitives.
 *
 * Leaf module (imports only `./types.js`) so every domain envelope module
 * AND `auth.ts` can depend on it without an import cycle. These helpers were
 * extracted verbatim from the original monolithic `auth.ts` — the byte
 * output of every field guard / hex encoder is unchanged, so all canonical
 * bytes and signatures are byte-identical.
 *
 * Public surface: ONLY `legacyFieldGuard` (it was the sole exported helper
 * in the pre-split `auth.ts`, and `auth.ts` re-exports just that). `hex`,
 * `validateNoSepCtrl`, and `assertCanonicalField` are exported for the sibling
 * domain modules' use but are deliberately NOT re-exported by `auth.ts`, so
 * the package's public API is unchanged.
 */
import type { Bytes, Keypair } from "./types.js";
import { ed } from "./edSync.js";

/**
 * A message signer: either a raw Ed25519 `Keypair` (the historical form) or a
 * closure that signs canonical bytes. The closure form lets a caller that does
 * NOT hold the private key — e.g. a daemon whose seed lives behind a
 * KeyCustodian — sign without ever surfacing the seed. `resolveMsgSigner`
 * normalizes either to `(msg) => sig`, so signature bytes stay identical.
 */
export type MsgSigner = Keypair | ((msg: Bytes) => Bytes);

export function resolveMsgSigner(signer: MsgSigner): (msg: Bytes) => Bytes {
  return typeof signer === "function"
    ? signer
    : (msg: Bytes) => ed.sign(msg, signer.privateKey);
}

/** Lower-case hex of a byte array. */
export function hex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * #12 — per-field separator-rejection helper retrofitted into the
 * legacy canonical-bytes functions below. Rejects '|' and control
 * characters (0x00-0x1F, 0x7F) at sign-time AND verify-time, so any
 * envelope whose user-controlled field contains the canonical-bytes
 * separator is refused before it can canonicalize ambiguously.
 *
 * Exported so external callers (rare) can spot-check field shape
 * before constructing an envelope. Verifiers call this implicitly
 * via the legacy canonicals — a tampered envelope whose canonical
 * bytes differ from the signed bytes simply fails Ed25519 verify.
 */
export function legacyFieldGuard(name: string, value: string): void {
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

/**
 * Reject '|' or control chars in any string field. Used by the newer
 * envelopes (pod-binding, service-invite, RCK rotation, merge-back,
 * username-rename, inheritance). (The legacy envelopes pre-date this guard;
 * the v2 framing migration #96 will harden them comprehensively.)
 */
export function validateNoSepCtrl(name: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) {
      throw new Error(`canonical-bytes field "${name}" contains separator '|' at index ${i}`);
    }
    if (c <= 0x1f || c === 0x7f) {
      throw new Error(
        `canonical-bytes field "${name}" contains control char 0x${c.toString(16)} at index ${i}`,
      );
    }
  }
}

/**
 * Field validator used by the per-box cert-routing revocation envelopes:
 * rejects empty values, the '|' separator, and control chars, naming both
 * the envelope and the field in the error.
 */
export function assertCanonicalField(value: string, envelope: string, field: string): void {
  if (value.length === 0) throw new Error(`${envelope}: empty "${field}"`);
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 0x7c) throw new Error(`${envelope} field "${field}" contains separator '|'`);
    if (ch <= 0x1f || ch === 0x7f) {
      throw new Error(`${envelope} field "${field}" contains control char 0x${ch.toString(16)} at index ${i}`);
    }
  }
}
