/**
 * The signed runtime manifest published at flagshipserver.com/runtime (release plan G2): the same facts as
 * `release/runtime-lock.json` (which the signed release artifact carries), signed by the release keys on their own,
 * so an owner can check "which Node, which checksum" without trusting the connection to `.com`.
 *
 * Canonical bytes, tag first, `|`-separated like every signed message:
 *
 *   flagship/runtime-manifest/v1|<runtime>|<version>|<lockSha256>|<securityFloor>|<sequence>|<issuedAt>|<validUntil>|<revoked>
 *
 * `revoked` is the sorted, comma-joined list of upstream signer fingerprints the manifest withdraws (40 lowercase hex
 * each), or `-`. A verifier refuses a manifest that is past `validUntil` (freeze resistance), whose `sequence` is not
 * above the last one it accepted (rollback and replay), whose `lockSha256` is not the SHA-256 of the lock it carries,
 * or whose lock still names a revoked signer. Signatures and the PQ companions follow the box artifact's rules
 * (boxArtifact.ts, boxArtifactPq.ts): k-of-n distinct authorised Ed25519 keys and, once the pin names a key, each
 * signer's hybrid companion over `flagship/runtime-manifest/v2|<sha256 of the v1 bytes>|<signer>|<key id>`.
 * Rust twin: rust/crates/flagship-updater/src/runtime/manifest.rs. Vectors: test-vectors/runtime-manifest/.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ed } from "./edSync.js";
import { assertCanonicalField, hex } from "./canonicalBase.js";
import { BOX_ARTIFACT_PQ_BINDING_SUBJECT, boxArtifactV1Digest, verifiedBoxArtifactBindings, type BoxArtifactPqPin } from "./boxArtifactPq.js";
import { hybridSign, hybridVerify, pqKeyId, SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 } from "./pqHybrid.js";
import { isVerifiedPqKeyBinding } from "./pqTrust.js";
import { compareSemver, type ReleaseTrust } from "./boxArtifact.js";
import type { Bytes } from "./types.js";

export const TAG_RUNTIME_MANIFEST = "flagship/runtime-manifest/v1";
export const TAG_RUNTIME_MANIFEST_V2 = "flagship/runtime-manifest/v2";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface RuntimeManifest {
  runtime: "node";
  version: string;
  /** SHA-256 of the exact bytes of release/runtime-lock.json. */
  lockSha256: string;
  securityFloor: string;
  sequence: number;
  issuedAt: number;
  validUntil: number;
  /** Upstream signer fingerprints withdrawn by this manifest. */
  revokedSigners: readonly string[];
}

export interface RuntimeManifestPq {
  keyId: string;
  signatureHex: string;
}

export interface RuntimeManifestSignature {
  keyHex: string;
  signatureHex: string;
  pq?: RuntimeManifestPq;
}

export function assertRuntimeManifest(m: RuntimeManifest): void {
  if (m.runtime !== "node") throw new Error("runtime-manifest: runtime must be node");
  if (!SEMVER.test(m.version) || !SEMVER.test(m.securityFloor)) throw new Error("runtime-manifest: version and securityFloor must be major.minor.patch");
  if (!HEX64.test(m.lockSha256)) throw new Error("runtime-manifest: lockSha256 must be 64 lowercase hex characters");
  for (const [n, v] of [["sequence", m.sequence], ["issuedAt", m.issuedAt], ["validUntil", m.validUntil]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`runtime-manifest: bad ${n}`);
  }
  if (m.validUntil <= m.issuedAt) throw new Error("runtime-manifest: validUntil must be after issuedAt");
  if (m.revokedSigners.some((f) => !HEX40.test(f))) throw new Error("runtime-manifest: a revoked signer is not 40 lowercase hex characters");
  assertCanonicalField(m.version, "runtime-manifest", "version");
}

export function canonicalRuntimeManifest(m: RuntimeManifest): Bytes {
  assertRuntimeManifest(m);
  const revoked = m.revokedSigners.length ? [...m.revokedSigners].sort().join(",") : "-";
  return new TextEncoder().encode(
    [TAG_RUNTIME_MANIFEST, m.runtime, m.version, m.lockSha256, m.securityFloor, m.sequence, m.issuedAt, m.validUntil, revoked].join("|"),
  );
}

export function canonicalRuntimeManifestV2(canonicalV1: Bytes, signerHex: string, keyIdHex: string): Bytes {
  return new TextEncoder().encode([TAG_RUNTIME_MANIFEST_V2, boxArtifactV1Digest(canonicalV1), signerHex.toLowerCase(), keyIdHex].join("|"));
}

export function signRuntimeManifest(m: RuntimeManifest, privateKey: Bytes): RuntimeManifestSignature {
  return { keyHex: hex(ed.getPublicKey(privateKey)), signatureHex: hex(ed.sign(canonicalRuntimeManifest(m), privateKey)) };
}

/** Sign the companion with a hybrid secret key (Ed25519 seed || ML-DSA-65 seed). */
export function signRuntimeManifestPq(canonicalV1: Bytes, hybridSecretKey: Bytes, hybridPublicKey: Bytes): RuntimeManifestPq {
  const signerHex = hex(hybridPublicKey.subarray(0, 32));
  const keyId = hex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, hybridPublicKey));
  const sig = hybridSign(hybridSecretKey, TAG_RUNTIME_MANIFEST_V2, canonicalRuntimeManifestV2(canonicalV1, signerHex, keyId), { deterministic: true });
  return { keyId, signatureHex: hex(sig) };
}

function fromHex(s: string): Bytes {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

export type RuntimeManifestRefusal =
  | "bad-manifest"
  | "bad-trust"
  | "not-enough-signatures"
  | "pq-signature-required"
  | "lock-mismatch"
  | "expired"
  | "rollback"
  | "signer-revoked";

export interface VerifyRuntimeManifestOptions {
  trust: ReleaseTrust;
  pqPin?: BoxArtifactPqPin;
  pqBindings?: readonly unknown[];
  /** The exact bytes of the lock the manifest carries. */
  lockText: string;
  /** Upstream signer fingerprints the lock names (from the parsed lock). */
  lockSigners: readonly string[];
  now: number;
  /** The highest sequence already accepted; this one must be higher. */
  lastSequence?: number;
}

export type VerifyRuntimeManifestResult = { ok: true; signers: string[] } | { ok: false; code: RuntimeManifestRefusal; detail?: string };

export function verifyRuntimeManifest(
  m: RuntimeManifest,
  signatures: readonly RuntimeManifestSignature[],
  o: VerifyRuntimeManifestOptions,
): VerifyRuntimeManifestResult {
  let bytes: Bytes;
  try {
    bytes = canonicalRuntimeManifest(m);
  } catch (e) {
    return { ok: false, code: "bad-manifest", detail: (e as Error).message };
  }
  const authorized = new Set(o.trust.keys.map((k) => k.toLowerCase()));
  if (!Number.isInteger(o.trust.threshold) || o.trust.threshold < 1 || authorized.size < o.trust.threshold || [...authorized].some((k) => !HEX64.test(k))) {
    return { ok: false, code: "bad-trust" };
  }
  const pin = o.pqPin;
  const needPq = !!pin && pin.keyIds.length > 0 && !pin.legacyManifests.includes(boxArtifactV1Digest(bytes));
  const bindings = needPq && pin ? verifiedBoxArtifactBindings(o.pqBindings ?? [], pin, o.now) : new Map();
  const signed = new Set<string>();
  let classicalOnly = 0;
  for (const s of signatures) {
    const key = s.keyHex.toLowerCase();
    if (!authorized.has(key) || signed.has(key)) continue;
    try {
      if (!ed.verify(fromHex(s.signatureHex), bytes, fromHex(key))) continue;
    } catch {
      continue;
    }
    if (needPq) {
      const b = bindings.get(key);
      const pq = s.pq;
      let ok = false;
      if (b && isVerifiedPqKeyBinding(b) && pq && b.keyIdHex === pq.keyId && b.role === "release-key" && b.subjectId === BOX_ARTIFACT_PQ_BINDING_SUBJECT && b.ed25519PubHex === key) {
        try {
          hybridVerify(b.hybridPublicKey, TAG_RUNTIME_MANIFEST_V2, canonicalRuntimeManifestV2(bytes, key, pq.keyId), fromHex(pq.signatureHex));
          ok = true;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        classicalOnly += 1;
        continue;
      }
    }
    signed.add(key);
  }
  if (signed.size < o.trust.threshold) {
    if (needPq && signed.size + classicalOnly >= o.trust.threshold) return { ok: false, code: "pq-signature-required", detail: `${signed.size} of ${o.trust.threshold} with their PQ signature` };
    return { ok: false, code: "not-enough-signatures", detail: `${signed.size} of ${o.trust.threshold}` };
  }
  if (hex(sha256(new TextEncoder().encode(o.lockText))) !== m.lockSha256) return { ok: false, code: "lock-mismatch" };
  if (o.now > m.validUntil) return { ok: false, code: "expired" };
  if (o.lastSequence !== undefined && m.sequence <= o.lastSequence) return { ok: false, code: "rollback" };
  const revoked = new Set(m.revokedSigners);
  if (o.lockSigners.some((f) => revoked.has(f.toLowerCase()))) return { ok: false, code: "signer-revoked" };
  if (compareSemver(m.version, m.securityFloor) < 0) return { ok: false, code: "bad-manifest", detail: "version below its own floor" };
  return { ok: true, signers: [...signed].sort() };
}
