/**
 * The generated name a page owner sees for a visitor (docs/voici-and-messages.md §6.2): the first four characters of
 * RFC 4648 base32 (uppercase A-Z2-7) of SHA-256 over the RAW 32-byte pseudonym key P, e.g. "4F3A" style codes. The
 * apps show it after a localized prefix ("Visitor "); `voiciPseudonymName` returns the English form.
 *
 * Exported API: voiciPseudonymCode, voiciPseudonymName.
 */
import { sha256 } from "@noble/hashes/sha256";
import { base32Encode } from "./builderPairing.js";
import { hexToBytes, isLowerHex } from "./webEnvelope.js";

/** Four base32 characters for a pseudonym public key (Ed25519, lowercase hex). */
export function voiciPseudonymCode(pseudonymPubHex: string): string {
  if (!isLowerHex(pseudonymPubHex, 32)) throw new Error("pseudonym key must be 32 bytes of lowercase hex");
  return base32Encode(sha256(hexToBytes(pseudonymPubHex))).slice(0, 4);
}

export function voiciPseudonymName(pseudonymPubHex: string, prefix = "Visitor "): string {
  return prefix + voiciPseudonymCode(pseudonymPubHex);
}
