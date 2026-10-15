/**
 * LUKS-unlock-on-boot domain — the box-sealed-key custody envelopes
 * (PutSealedLuksKey, ConsumeUnlockKey). The auto-unlock lease is the
 * box-sealed AutoUnlockLeaseV2 in phoneEndpoint.ts; the plaintext v1 lease
 * (flagship/auto-unlock-lease/v1 + revoke-auto-unlock-lease/v1) is gone.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and guards are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

/**
 * LUKS-unlock-on-boot endpoints (RELAY + box-sealed-lease model).
 *
 * Flow:
 *   1. At install time, the daemon seals the LUKS root key with the
 *      user's BAK pubkey and POSTs `PutSealedLuksKey` to .com (signed
 *      by the server identity key).
 *   2. At boot, the box self-unlocks from a box-sealed lease
 *      (AutoUnlockLeaseV2: the key sealed for its STK, which only it can
 *      open), or falls back to the relay (an STK-signed `SecretRequest`
 *      the phone answers with a sealed reply).
 *
 * NOTE: the legacy plaintext `DepositUnlockKey` path (where .com held
 * the unsealed key in a form it could read) has been removed. .com now
 * only ever stores ciphertext it cannot read.
 */
export interface PutSealedLuksKey {
  serverId: ServerId;
  sealedKey: Bytes;
  issuedAt: number;
}

export interface ConsumeUnlockKey {
  serverId: ServerId;
  /** 32-byte nonce; rejected if it matches the previous accepted one. */
  nonce: Bytes;
  issuedAt: number;
}

const TAG_PUT_SEALED_LUKS_KEY = "flagship/put-sealed-luks-key/v1";
const TAG_CONSUME_UNLOCK_KEY = "flagship/consume-unlock-key/v1";

function canonicalPutSealedLuksKey(r: PutSealedLuksKey): Bytes {
  return new TextEncoder().encode(
    [TAG_PUT_SEALED_LUKS_KEY, r.serverId, hex(r.sealedKey), r.issuedAt].join("|"),
  );
}

function canonicalConsumeUnlockKey(r: ConsumeUnlockKey): Bytes {
  return new TextEncoder().encode(
    [TAG_CONSUME_UNLOCK_KEY, r.serverId, hex(r.nonce), r.issuedAt].join("|"),
  );
}

export function signPutSealedLuksKey(r: PutSealedLuksKey, identity: Keypair): Bytes {
  return ed.sign(canonicalPutSealedLuksKey(r), identity.privateKey);
}
export function verifyPutSealedLuksKey(r: PutSealedLuksKey, sig: Bytes, identityPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPutSealedLuksKey(r), identityPub);
  } catch {
    return false;
  }
}

export function signConsumeUnlockKey(r: ConsumeUnlockKey, identity: Keypair): Bytes {
  return ed.sign(canonicalConsumeUnlockKey(r), identity.privateKey);
}
export function verifyConsumeUnlockKey(r: ConsumeUnlockKey, sig: Bytes, identityPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalConsumeUnlockKey(r), identityPub);
  } catch {
    return false;
  }
}
