import type { ClaimIdentity } from "./claimService.js";

/** The keyd calls a claim needs (KeydCustodian implements them). */
export interface KeydBoxSigner {
  boxPublicKey(): Uint8Array;
  pqPublicKeyHex(): string | null;
  signHybridAsBox(msg: Uint8Array): Uint8Array;
}

/**
 * On a keyd box the box key never leaves keyd, so the claim receipt is signed there: keyd takes
 * `flagship/box-claim-receipt/v1` only hybrid and only naming its own two keys (packages/keyd
 * policy.ts). A keyd without an ML-DSA key cannot sign a receipt, so the claim refuses early.
 */
export function keydClaimIdentity(keyd: KeydBoxSigner, bootKeyBindingSha256 = ""): ClaimIdentity {
  const mldsa = keyd.pqPublicKeyHex();
  if (!mldsa) throw new Error("keyd holds no ML-DSA key; a claim receipt needs both box keys");
  const ed = Buffer.from(keyd.boxPublicKey()).toString("hex");
  return {
    stkHybridPubHex: ed + mldsa,
    bootKeyBindingSha256,
    sign: (purpose, payload) => {
      const head = new TextDecoder().decode(payload.subarray(0, purpose.length + 1));
      if (head !== `${purpose}|`) throw new Error("the receipt does not start with its purpose");
      return keyd.signHybridAsBox(payload);
    },
  };
}
