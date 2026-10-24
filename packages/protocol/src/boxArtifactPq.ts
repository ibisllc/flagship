/**
 * The PQ half of a box release artifact's k-of-n signatures (architecture v2; same rollout as
 * the release endorsement's v2 companion, pq-suites.md §12 and §16). DRAFT, pending Q01 review.
 *
 * Each authorized Ed25519 signer of `flagship/box-artifact/v1` may add a companion signed with
 * the hybrid suite under `<its Ed25519 key> || <its ML-DSA-65 key>`:
 *
 *   flagship/box-artifact/v2|<sha256 of the v1 canonical bytes>|<signer Ed25519 hex>|<keyId>
 *
 * The ML-DSA key is bound to the signer's Ed25519 key with a `flagship/pq-key-binding/v1`
 * (role `release-key`, subject `flagship-box-artifact`), carried in the manifest file
 * (`pqBindings`); the binding's hybrid key id must be in the code pin `BOX_ARTIFACT_PQ_PIN`.
 *
 * Empty pin: classical k-of-n as before (today). Once the pin names a key, a signer counts toward
 * the threshold only with its verified companion, so stripping the PQ half leaves too few
 * signers; the only manifests still accepted on Ed25519 alone are the ones signed before the
 * cut-over, listed by digest in the pin (`legacyManifests`). Same rules in the installer's shell
 * verifier (installer/verify-box-artifact.sh) and the shared vectors
 * (test-vectors/box-artifact/pq-vectors.json).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { hybridSign, hybridVerify, pqKeyId, SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 } from "./pqHybrid.js";
import { pqBindingPublicKey, pqKeyBindingFromWire, verifyPqKeyBinding, type VerifiedPqKeyBinding } from "./pqTrust.js";
import { BOX_RELEASE } from "./boxReleaseConfig.js";
import type { Bytes } from "./types.js";

export const TAG_BOX_ARTIFACT_V2 = "flagship/box-artifact/v2";
export const BOX_ARTIFACT_PQ_BINDING_SUBJECT = "flagship-box-artifact";

export interface BoxArtifactPqPin {
  version: 1;
  /** `pqKeyId(0x0002, ed25519 || mldsa65)` of each accepted artifact signing key, lowercase hex. */
  keyIds: readonly string[];
  /** SHA-256 (hex) of the v1 canonical bytes of each manifest signed before the PQ cut-over. */
  legacyManifests: readonly string[];
}

/** From release/box-artifact-trust.json `pq`, through the generated boxReleaseConfig.ts. */
export const BOX_ARTIFACT_PQ_PIN: BoxArtifactPqPin = Object.freeze({
  version: 1,
  keyIds: Object.freeze([...BOX_RELEASE.trust.pq.keyIds]) as readonly string[],
  legacyManifests: Object.freeze([...BOX_RELEASE.trust.pq.legacyManifests]) as readonly string[],
});

/** A signer's PQ companion, beside its Ed25519 signature in the manifest file. */
export interface BoxArtifactPqSignature {
  keyId: string;
  /** The hybrid signature over the v2 statement, hex. */
  signatureHex: string;
}

const HEX32 = /^[0-9a-f]{64}$/;

export function boxArtifactPqPinConfigured(pin: BoxArtifactPqPin = BOX_ARTIFACT_PQ_PIN): boolean {
  return Array.isArray(pin?.keyIds) && pin.keyIds.length > 0;
}

/** SHA-256 of the manifest's v1 canonical bytes, hex. */
export function boxArtifactV1Digest(canonicalV1: Bytes): string {
  return toHex(sha256(canonicalV1));
}

export function canonicalBoxArtifactV2(canonicalV1: Bytes, signerHex: string, keyIdHex: string): Bytes {
  return new TextEncoder().encode([TAG_BOX_ARTIFACT_V2, boxArtifactV1Digest(canonicalV1), signerHex.toLowerCase(), keyIdHex].join("|"));
}

/** The pinned artifact-key bindings that verify, by Ed25519 key. */
export function verifiedBoxArtifactBindings(wires: readonly unknown[], pin: BoxArtifactPqPin, now: number): Map<string, VerifiedPqKeyBinding> {
  const pinned = new Set(pin.keyIds.map((k) => k.toLowerCase()));
  const out = new Map<string, VerifiedPqKeyBinding>();
  for (const raw of wires) {
    try {
      const w = pqKeyBindingFromWire(raw);
      const keyId = toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pqBindingPublicKey(w)));
      if (!pinned.has(keyId)) continue;
      const b = verifyPqKeyBinding(w, { role: "release-key", subjectId: BOX_ARTIFACT_PQ_BINDING_SUBJECT, ed25519PubHex: w.ed25519PubHex, now });
      if (!out.has(b.ed25519PubHex)) out.set(b.ed25519PubHex, b);
    } catch {
      // a binding that does not verify simply does not count
    }
  }
  return out;
}

/** True when `pq` is `signer`'s verified companion over this manifest. */
export function verifyBoxArtifactPq(
  canonicalV1: Bytes,
  signerHex: string,
  pq: unknown,
  bindings: ReadonlyMap<string, VerifiedPqKeyBinding>,
): boolean {
  if (!pq || typeof pq !== "object") return false;
  const { keyId, signatureHex } = pq as Partial<BoxArtifactPqSignature>;
  if (typeof keyId !== "string" || !HEX32.test(keyId) || typeof signatureHex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(signatureHex)) return false;
  const b = bindings.get(signerHex.toLowerCase());
  if (!b || b.keyIdHex !== keyId) return false;
  try {
    hybridVerify(b.hybridPublicKey, TAG_BOX_ARTIFACT_V2, canonicalBoxArtifactV2(canonicalV1, signerHex, keyId), fromHex(signatureHex));
    return true;
  } catch {
    return false;
  }
}

/** Sign the companion with a hybrid secret key (Ed25519 seed || ML-DSA-65 seed). */
export function signBoxArtifactPq(canonicalV1: Bytes, hybridSecretKey: Bytes, hybridPublicKey: Bytes): BoxArtifactPqSignature {
  const signerHex = toHex(hybridPublicKey.subarray(0, 32));
  const keyId = toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, hybridPublicKey));
  const sig = hybridSign(hybridSecretKey, TAG_BOX_ARTIFACT_V2, canonicalBoxArtifactV2(canonicalV1, signerHex, keyId), { deterministic: true });
  return { keyId, signatureHex: toHex(sig) };
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

