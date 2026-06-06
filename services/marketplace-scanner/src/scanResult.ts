/**
 * Build + sign a MarketplaceScanResult envelope.
 *
 * WIRE CONTRACT: this is the *same* envelope that
 * `packages/control-plane/src/marketplace.ts`'s
 * `handleMarketplaceScanResult` verifies via the landed
 * `verifyMarketplaceScanResult`. We deliberately do NOT hand-roll the
 * canonical bytes here — we reuse `@flagship/protocol`'s
 * `signMarketplaceScanResult` so the signature round-trips through the
 * landed verifier byte-for-byte. (An earlier scaffold hand-rolled a
 * `flagship/marketplace-scan/v1` tag — WRONG; the landed protocol tag
 * is `flagship/marketplace-scan-result/v1`. Reusing the protocol fn
 * makes drift impossible.)
 */

import {
  ed,
  signMarketplaceScanResult,
  verifyMarketplaceScanResult,
  type Keypair,
  type MarketplaceScanResult,
} from "@flagship/protocol";

/** Re-export the protocol type under the local name for callers. */
export type ScanResult = MarketplaceScanResult;

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Derive the scanner Ed25519 keypair from its 32-byte private hex. */
export function scannerKeypairFromHex(privKeyHex: string): Keypair {
  const privateKey = hexToBytes(privKeyHex);
  if (privateKey.length !== 32) {
    throw new Error("FLAGSHIP_SCANNER_PRIV_HEX must be 32 bytes (64 hex chars)");
  }
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

/**
 * Build the signed body `.com` expects:
 * `{ request: MarketplaceScanResult, signature: <hex> }`.
 *
 * The signature is produced by the protocol package's signer, so it
 * verifies under the landed `verifyMarketplaceScanResult` with the
 * matching pubkey (the one set on `.com` as
 * `MARKETPLACE_SCANNER_PUBKEY_HEX`).
 */
export function signScanResult(
  r: ScanResult,
  scanner: Keypair | string,
): { request: ScanResult; signature: string } {
  const kp = typeof scanner === "string" ? scannerKeypairFromHex(scanner) : scanner;
  const sig = signMarketplaceScanResult(r, kp);
  return { request: r, signature: bytesToHex(sig) };
}

/**
 * Verify a scan-result signature. Delegates to the landed protocol
 * verifier — identical bytes to what `.com` runs. Provided so tests
 * can assert the round-trip without re-importing the handler.
 */
export function verifyScanResult(
  r: ScanResult,
  signatureHex: string,
  pubKeyHex: string,
): boolean {
  try {
    return verifyMarketplaceScanResult(r, hexToBytes(signatureHex), hexToBytes(pubKeyHex));
  } catch {
    return false;
  }
}
