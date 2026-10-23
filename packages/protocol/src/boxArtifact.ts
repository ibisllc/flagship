/**
 * The box release artifact manifest (SEC-REL-001, SEC-INSTALL-001; plan §8.2).
 *
 * A production box runs ONE immutable file: the daemon, its production
 * dependencies, the Node runtime, the unit files and the migrations, built in
 * clean CI. Installing it resolves nothing from npm, apt, GitHub or NodeSource.
 * This manifest names that file by digest and binds it to the exact source
 * commit, lockfile, runtime and build provenance, and release authorities sign
 * the manifest's canonical bytes. A box (or an installer) accepts the artifact
 * only when
 *   1. the file's SHA-256 equals `artifactSha256` and its size equals
 *      `artifactBytes`,
 *   2. at least `threshold` distinct authorized keys signed the manifest,
 *   3. `sequence` is higher than the last one it ran (no rollback), and
 *   4. the Node it ships is at or above the published security floor.
 *
 * Canonical bytes: `|`-separated, tag first, like every other signed message.
 * The same bytes are checked in TypeScript, in the installer's shell
 * (openssl) and in the vectors (packages/protocol/test-vectors/box-artifact).
 */

import { ed } from "./edSync.js";
import { assertCanonicalField, hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_BOX_ARTIFACT = "flagship/box-artifact/v1";

export type BoxArch = "amd64" | "arm64";
export const BOX_ARCHES: readonly BoxArch[] = ["amd64", "arm64"];

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface BoxArtifactManifest {
  /** Full 40-hex source commit. Never a branch, tag or abbreviation. */
  commit: string;
  arch: BoxArch;
  /** SHA-256 of the artifact file, hex. */
  artifactSha256: string;
  artifactBytes: number;
  /** The Node runtime inside the artifact, `major.minor.patch`. */
  nodeVersion: string;
  /** SHA-256 of the official Node archive it was taken from. */
  nodeSha256: string;
  /** SHA-256 of the package-lock.json the production dependencies were installed from. */
  lockSha256: string;
  sbomSha256: string;
  /** SHA-256 of the build provenance record (builder identity, inputs, steps). */
  provenanceSha256: string;
  /** The oldest installer/verifier that may act on this manifest. */
  minVerifier: number;
  /** Strictly increasing per release line; a box never runs a lower one. */
  sequence: number;
  issuedAt: number;
}

/** Throws unless every field is the shape the canonical form promises. */
export function assertBoxArtifactManifest(m: BoxArtifactManifest): void {
  if (!HEX40.test(m.commit)) throw new Error("box-artifact: commit must be 40 lowercase hex characters");
  if (!BOX_ARCHES.includes(m.arch)) throw new Error("box-artifact: bad arch");
  for (const [n, v] of [
    ["artifactSha256", m.artifactSha256], ["nodeSha256", m.nodeSha256], ["lockSha256", m.lockSha256],
    ["sbomSha256", m.sbomSha256], ["provenanceSha256", m.provenanceSha256],
  ] as const) {
    if (!HEX64.test(v)) throw new Error(`box-artifact: ${n} must be 64 lowercase hex characters`);
  }
  if (!SEMVER.test(m.nodeVersion)) throw new Error("box-artifact: nodeVersion must be major.minor.patch");
  for (const [n, v] of [["artifactBytes", m.artifactBytes], ["minVerifier", m.minVerifier], ["sequence", m.sequence], ["issuedAt", m.issuedAt]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`box-artifact: bad ${n}`);
  }
  if (m.artifactBytes === 0) throw new Error("box-artifact: empty artifact");
  assertCanonicalField(m.nodeVersion, "box-artifact", "nodeVersion");
}

export function canonicalBoxArtifact(m: BoxArtifactManifest): Bytes {
  assertBoxArtifactManifest(m);
  return new TextEncoder().encode(
    [
      TAG_BOX_ARTIFACT, m.commit, m.arch, m.artifactSha256, m.artifactBytes, m.nodeVersion, m.nodeSha256,
      m.lockSha256, m.sbomSha256, m.provenanceSha256, m.minVerifier, m.sequence, m.issuedAt,
    ].join("|"),
  );
}

export interface BoxArtifactSignature {
  /** The signer's Ed25519 public key, hex (32 bytes). */
  keyHex: string;
  /** The signature over `canonicalBoxArtifact`, hex (64 bytes). */
  signatureHex: string;
}

export function signBoxArtifact(m: BoxArtifactManifest, privateKey: Bytes): BoxArtifactSignature {
  return {
    keyHex: hex(ed.getPublicKey(privateKey)),
    signatureHex: hex(ed.sign(canonicalBoxArtifact(m), privateKey)),
  };
}

export interface ReleaseTrust {
  /** Distinct authorized public keys, hex. */
  keys: readonly string[];
  /** How many distinct authorized keys must sign. At least 1. */
  threshold: number;
}

export type BoxArtifactRefusal =
  | "bad-manifest"
  | "bad-trust"
  | "not-enough-signatures"
  | "digest-mismatch"
  | "size-mismatch"
  | "commit-mismatch"
  | "arch-mismatch"
  | "verifier-too-old"
  | "rollback"
  | "node-below-floor";

export interface VerifyBoxArtifactOptions {
  trust: ReleaseTrust;
  /** The digest the owner's recipe named, and the commit it named. When given they must match. */
  expectedArtifactSha256?: string;
  expectedCommit?: string;
  expectedArch?: BoxArch;
  /** The digest and size actually measured on the downloaded file. */
  measuredSha256?: string;
  measuredBytes?: number;
  /** This verifier's own version (compared with `minVerifier`). */
  verifierVersion: number;
  /** The highest sequence this box has already run; the manifest must be higher. */
  lastSequence?: number;
  /** The Node security floor, `major.minor.patch`. */
  nodeFloor?: string;
}

export type VerifyBoxArtifactResult =
  | { ok: true; signers: string[] }
  | { ok: false; code: BoxArtifactRefusal; detail?: string };

/** Compare two `major.minor.patch` strings. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

/** Verify a manifest end to end. Nothing here trusts a field it did not check. */
export function verifyBoxArtifact(
  m: BoxArtifactManifest,
  signatures: readonly BoxArtifactSignature[],
  o: VerifyBoxArtifactOptions,
): VerifyBoxArtifactResult {
  let bytes: Bytes;
  try {
    bytes = canonicalBoxArtifact(m);
  } catch (e) {
    return { ok: false, code: "bad-manifest", detail: (e as Error).message };
  }
  const authorized = new Set(o.trust.keys.map((k) => k.toLowerCase()));
  if (
    !Number.isInteger(o.trust.threshold) || o.trust.threshold < 1 ||
    authorized.size < o.trust.threshold || [...authorized].some((k) => !HEX64.test(k))
  ) {
    return { ok: false, code: "bad-trust" };
  }
  const signed = new Set<string>();
  for (const s of signatures) {
    const key = s.keyHex.toLowerCase();
    if (!authorized.has(key) || signed.has(key)) continue;
    try {
      if (ed.verify(Uint8Array.from(Buffer.from(s.signatureHex, "hex")), bytes, Uint8Array.from(Buffer.from(key, "hex")))) signed.add(key);
    } catch {
      // a malformed signature simply does not count
    }
  }
  if (signed.size < o.trust.threshold) {
    return { ok: false, code: "not-enough-signatures", detail: `${signed.size} of ${o.trust.threshold}` };
  }
  if (o.expectedArtifactSha256 !== undefined && o.expectedArtifactSha256.toLowerCase() !== m.artifactSha256) return { ok: false, code: "digest-mismatch", detail: "recipe" };
  if (o.measuredSha256 !== undefined && o.measuredSha256.toLowerCase() !== m.artifactSha256) return { ok: false, code: "digest-mismatch", detail: "file" };
  if (o.measuredBytes !== undefined && o.measuredBytes !== m.artifactBytes) return { ok: false, code: "size-mismatch" };
  if (o.expectedCommit !== undefined && o.expectedCommit.toLowerCase() !== m.commit) return { ok: false, code: "commit-mismatch" };
  if (o.expectedArch !== undefined && o.expectedArch !== m.arch) return { ok: false, code: "arch-mismatch" };
  if (m.minVerifier > o.verifierVersion) return { ok: false, code: "verifier-too-old" };
  if (o.lastSequence !== undefined && m.sequence <= o.lastSequence) return { ok: false, code: "rollback" };
  if (o.nodeFloor !== undefined && compareSemver(m.nodeVersion, o.nodeFloor) < 0) return { ok: false, code: "node-below-floor", detail: m.nodeVersion };
  return { ok: true, signers: [...signed].sort() };
}

/**
 * The oldest Node a box may run (plan §8.1; release/security-floor.json is the
 * same number for the tools that cannot import this). Node 20 reached end of
 * life on 2026-03-24 and the 2026-10-21 24.22.1 / 22.23.4 releases carry the
 * root-store and blocked-key fixes. Re-check against nodejs.org when raising it.
 */
export const NODE_SECURITY_FLOOR = "24.22.1";

export interface NodeRuntimeStatus {
  version: string;
  floor: string;
  belowFloor: boolean;
}

/** Where a running Node stands against the floor. `version` is `process.versions.node`. */
export function nodeRuntimeStatus(version: string, floor: string = NODE_SECURITY_FLOOR): NodeRuntimeStatus {
  const v = SEMVER.test(version) ? version : "0.0.0";
  return { version, floor, belowFloor: compareSemver(v, floor) < 0 };
}
