import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { SWK_DERIVE_LABELS, opaqueSecretOps } from "./opaqueKey.js";
import type { Bytes } from "./types.js";

/**
 * HKDF-SHA256 from the workload key. When the key is an opaque stand-in (held by keyd), the
 * derivation happens there and only the labelled subkey comes back.
 */
export function hkdfFromSwk(swk: Bytes, salt: Bytes, info: string): Bytes {
  const opaque = opaqueSecretOps(swk);
  if (opaque) {
    if (!SWK_DERIVE_LABELS.has(info)) throw new Error("this derivation label is not allowed for the workload key");
    return opaque.derive(salt, info);
  }
  return hkdf(sha256, swk, salt, new TextEncoder().encode(info), 32);
}
