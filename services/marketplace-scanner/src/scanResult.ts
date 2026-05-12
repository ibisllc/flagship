/**
 * Build + sign a MarketplaceScanResult envelope.
 *
 * Wire-compatible with packages/control-plane/src/marketplace.ts's
 * handleMarketplaceScanResult handler.
 */

import { ed25519 } from "@noble/curves/ed25519.js";

const TAG_MARKETPLACE_SCAN = "flagship/marketplace-scan/v1";

export interface ScanResult {
  creator: string;
  slug: string;
  grade: "A" | "B" | "C" | "D" | "F";
  reportKey: string; // R2 object key
  imageDigestHex: string; // sha256 of the scanned docker image
  scannedAt: number;
}

function canonicalScanResult(r: ScanResult): Uint8Array {
  return new TextEncoder().encode(
    [
      TAG_MARKETPLACE_SCAN,
      r.creator,
      r.slug,
      r.grade,
      r.reportKey,
      r.imageDigestHex,
      r.scannedAt,
    ].join("|"),
  );
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function signScanResult(r: ScanResult, privKeyHex: string): {
  request: ScanResult;
  signature: string;
} {
  const bytes = canonicalScanResult(r);
  const sig = ed25519.sign(bytes, hexToBytes(privKeyHex));
  return { request: r, signature: bytesToHex(sig) };
}

/** Verify a scan-result signature — used by the control-plane handler. */
export function verifyScanResult(r: ScanResult, signatureHex: string, pubKeyHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), canonicalScanResult(r), hexToBytes(pubKeyHex));
  } catch {
    return false;
  }
}
