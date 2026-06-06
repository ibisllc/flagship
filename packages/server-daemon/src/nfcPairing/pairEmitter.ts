// N-BOX-2 (continued) + N-BOX-7 — per-boot ephemeral keygen + PAIR
// emitter payload construction.
//
// The box, while UNPAIRED, regenerates everything per boot:
//   - STK keypair (Ed25519) — becomes the persisted long-lived STK iff
//     the pairing succeeds.
//   - Ephemeral X25519 keypair (forward secrecy for this session).
//   - 16-byte random nonce + 16-byte random sessionId.
//
// Output is a `PairPayload` ready to feed `signPair` from
// `@flagship/protocol`. The hint carries discovery surfaces (mDNS name +
// cloud rendezvous id) plus the 6-hex `suffix6` (last 6 hex of stkPub)
// used by phones to disambiguate when multiple boxes are visible on the
// same LAN (closes T2 in the design).

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  PAIR_PROTOCOL_VERSION,
  type PairHint,
  type PairPayload,
  stkPubToSuffix6,
} from "@flagship/protocol";
import type { Bytes } from "@flagship/protocol";
import { checkEntropy, type EntropyCheckResult, type EntropyReader } from "./rngGate.js";

export interface EphemeralPairKeys {
  /** Ed25519 STK keypair (publicKey + privateKey, raw 32 bytes each). */
  stkPub: Bytes;
  stkPriv: Bytes;
  /** X25519 ephemeral keypair (raw 32 bytes each). */
  eBoxPub: Bytes;
  eBoxPriv: Bytes;
  /** 16-byte nonce. */
  nonce: Bytes;
  /** 16-byte sessionId. */
  sessionId: Bytes;
}

export interface PairEmitterConfig {
  /**
   * mDNS hostname *base* — the box's local-network name (e.g.
   * `flagship-<suffix6>`); `.local` is appended at the link layer.
   * The 6-hex suffix is injected per-emit, so callers usually pass a
   * static base like `"flagship"`.
   */
  mdnsBase: string;
  /**
   * Cloud rendezvous endpoint base — a stable per-box id derived from
   * stkPub that a phone can reach over the cloud relay if LAN
   * discovery fails. Same suffix-injection scheme.
   */
  cloudRendezvousBase: string;
}

/**
 * Per-boot key generation. Refuses if the RNG entropy gate is closed;
 * caller decides whether to retry or surface the failure (e.g. boot the
 * box into "waiting for entropy" mode and show a status LED pattern).
 */
export function generatePairKeys(
  reader?: EntropyReader,
  rng: (n: number) => Bytes = (n) => {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  },
): { ok: true; keys: EphemeralPairKeys } | { ok: false; entropy: EntropyCheckResult } {
  const entropy = checkEntropy(reader);
  if (!entropy.ok) {
    return { ok: false, entropy };
  }
  const stkPriv = rng(32);
  const stkPub = ed25519.getPublicKey(stkPriv);
  const eBoxPriv = rng(32);
  const eBoxPub = x25519.getPublicKey(eBoxPriv);
  const nonce = rng(16);
  const sessionId = rng(16);
  return {
    ok: true,
    keys: { stkPub, stkPriv, eBoxPub, eBoxPriv, nonce, sessionId },
  };
}

/**
 * Build the discovery hint embedded in PAIR. `suffix6` is derived from
 * the STK pubkey so two boxes with different identity pubkeys always
 * end up with different suffixes (collision risk over 24 bits is
 * meaningful but the user only needs to disambiguate the boxes in
 * front of them, not the global population).
 */
export function buildPairHint(stkPub: Bytes, config: PairEmitterConfig): PairHint {
  const suffix6 = stkPubToSuffix6(stkPub);
  return {
    mdnsName: `${config.mdnsBase}-${suffix6}`,
    cloudRendezvousId: `${config.cloudRendezvousBase}/${suffix6}`,
    suffix6,
  };
}

/**
 * Compose a complete PairPayload ready for `signPair`. Lives at the
 * boundary between this daemon module and `@flagship/protocol` so that
 * any field-ordering update to the canonical-bytes layout flows from
 * the protocol package and this caller stays a pure assembler.
 */
export function buildPairPayload(
  keys: EphemeralPairKeys,
  config: PairEmitterConfig,
): PairPayload {
  return {
    v: PAIR_PROTOCOL_VERSION,
    stkPub: keys.stkPub,
    eBoxPub: keys.eBoxPub,
    nonce: keys.nonce,
    sessionId: keys.sessionId,
    hint: buildPairHint(keys.stkPub, config),
  };
}
