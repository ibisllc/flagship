/**
 * STK-signed push-relay request — the authentication primitive for
 * POST /api/push/relay (SEC-2).
 *
 * A push relay fans an opaque, sealed payload out to a target user's
 * registered push tokens. The legitimate sender is one of the target's
 * OWN boxes — e.g. a daemon notifying its owner that it needs an unlock
 * approval. The daemon already holds a registered identity (STK) key
 * (the same key it signs daemon-status reports with), so we require the
 * relay to be signed by that key and verify it against the target's
 * registered servers. A rogue caller that only knows a username can no
 * longer spam push notifications nor probe device-registration state.
 *
 * The sealed payload is NOT signed verbatim (it can be large and is
 * already confidential to .com); instead the canonical bytes bind its
 * SHA-256, so the signature still covers the exact payload that fans out.
 *
 * Canonical bytes (one implementation, shared by the daemon sender and
 * the control-plane verifier; clients mirror byte-for-byte — see the
 * pinned vector in tests/pushRelay.test.ts):
 *
 *   flagship/push-relay/v1|<targetUsername>|<category>|
 *   <sha256(sealedPayload) lowercase hex>|<issuedAt>
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import type { Bytes, Keypair } from "./types.js";

/**
 * The plaintext notification categories a relay may carry. Constraining
 * this to a known enum stops an attacker from injecting arbitrary
 * plaintext into the (OS-visible) category slot to socially engineer a
 * box unlock. Extend deliberately — every value here is shown by the
 * recipient OS.
 */
export const PUSH_RELAY_CATEGORIES = [
  "unlock-request",
  "boot-approval",
  "device-added",
  "re-pair-alert",
  "cert-alert",
  "generic",
] as const;

export type PushRelayCategory = (typeof PUSH_RELAY_CATEGORIES)[number];

export function isPushRelayCategory(value: string): value is PushRelayCategory {
  return (PUSH_RELAY_CATEGORIES as readonly string[]).includes(value);
}

export interface PushRelayRequest {
  targetUsername: string;
  category: PushRelayCategory;
  /** Hex of the bytes sealed by the sender to the target's push X25519 pub. */
  sealedPayloadHex: string;
  issuedAt: number;
}

const TAG_PUSH_RELAY = "flagship/push-relay/v1";

function sealedPayloadDigestHex(sealedPayloadHex: string): string {
  const digest = sha256(new TextEncoder().encode(sealedPayloadHex));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

export function canonicalPushRelayRequest(r: PushRelayRequest): Bytes {
  return new TextEncoder().encode(
    [
      TAG_PUSH_RELAY,
      r.targetUsername,
      r.category,
      sealedPayloadDigestHex(r.sealedPayloadHex),
      String(r.issuedAt),
    ].join("|"),
  );
}

export function signPushRelayRequest(r: PushRelayRequest, identity: Keypair): Bytes {
  return ed.sign(canonicalPushRelayRequest(r), identity.privateKey);
}

export function verifyPushRelayRequest(
  r: PushRelayRequest,
  sig: Bytes,
  stkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalPushRelayRequest(r), stkPub);
  } catch {
    return false;
  }
}
