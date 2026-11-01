/**
 * Whether a box may run an artifact its owner built (release plan G9, Appendix G section 4;
 * docs/architecture-v2/owner-builds.md).
 *
 * Two cases, never confused:
 * - The owner's build is byte for byte the endorsed artifact (same SHA-256 and size as a manifest the
 *   pinned release keys signed). It IS the endorsed release: install it with that manifest; nothing
 *   new is trusted.
 * - It differs. It is the owner's own code, not Flagship's, and only an explicit owner record may let
 *   it run: `flagship/local-build-policy/v1`, signed by the account's admin root, naming this server,
 *   the commit, the architecture, the exact artifact SHA-256 and the builder, with an end time. Even
 *   then the box takes it only when its own setting allows owner builds, which is OFF by default and
 *   has no switch in 0.3: every differing build is refused. The record never becomes, and is never
 *   reported as, a Flagship endorsement.
 */

export const LOCAL_BUILD_POLICY_TAG = "flagship/local-build-policy/v1";
/** The longest an owner's permission for one build may last. */
export const LOCAL_BUILD_POLICY_MAX_MS = 30 * 24 * 3_600_000;

export interface LocalBuildPolicy {
  serverDomain: string;
  commit: string;
  arch: "amd64" | "arm64";
  artifactSha256: string;
  /** The SHA-256 of the build's provenance file (its builder id says "owner-local"). */
  provenanceSha256: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function canonicalLocalBuildPolicy(p: LocalBuildPolicy): Uint8Array {
  if (!DOMAIN.test(p.serverDomain)) throw new Error("bad server domain");
  if (!/^[0-9a-f]{40}$/.test(p.commit)) throw new Error("bad commit");
  if (p.arch !== "amd64" && p.arch !== "arm64") throw new Error("bad arch");
  if (!HEX64.test(p.artifactSha256) || !HEX64.test(p.provenanceSha256)) throw new Error("bad digest");
  if (!Number.isSafeInteger(p.issuedAtMs) || !Number.isSafeInteger(p.expiresAtMs) || p.expiresAtMs <= p.issuedAtMs) throw new Error("bad window");
  if (p.expiresAtMs - p.issuedAtMs > LOCAL_BUILD_POLICY_MAX_MS) throw new Error("window too long");
  return new TextEncoder().encode(
    [LOCAL_BUILD_POLICY_TAG, p.serverDomain, p.commit, p.arch, p.artifactSha256, p.provenanceSha256, p.issuedAtMs, p.expiresAtMs].join("|"),
  );
}

export type ArtifactAdmission =
  | { ok: true; basis: "endorsed" }
  | { ok: true; basis: "owner-local-build" }
  | { ok: false; code: "not-endorsed" | "local-build-policy-off" | "policy-bad" | "policy-signature" | "policy-mismatch" | "policy-expired" };

export interface AdmissionInput {
  measured: { sha256: string; bytes: number };
  commit: string;
  arch: "amd64" | "arm64";
  serverDomain: string;
  /** The endorsed manifest for this commit and arch, already verified against the pinned release keys, if there is one. */
  endorsed?: { artifactSha256: string; artifactBytes: number } | null;
  /** The owner's record and its signature, when the owner made one. */
  policy?: { record: LocalBuildPolicy; signature: Uint8Array } | null;
  provenanceSha256?: string;
  /** The box's setting. Off unless the owner turned it on; 0.3 has no way to turn it on. */
  ownerBuildsAllowed?: boolean;
  /** Verifies an admin-root signature over the canonical bytes (the box's pinned admin root). */
  verifyAdminRoot?: (msg: Uint8Array, sig: Uint8Array) => boolean;
  nowMs: number;
}

export function admitArtifact(i: AdmissionInput): ArtifactAdmission {
  if (i.endorsed && i.endorsed.artifactSha256 === i.measured.sha256 && i.endorsed.artifactBytes === i.measured.bytes) {
    return { ok: true, basis: "endorsed" };
  }
  if (!i.policy) return { ok: false, code: "not-endorsed" };
  if (i.ownerBuildsAllowed !== true) return { ok: false, code: "local-build-policy-off" };
  let bytes: Uint8Array;
  try {
    bytes = canonicalLocalBuildPolicy(i.policy.record);
  } catch {
    return { ok: false, code: "policy-bad" };
  }
  if (!i.verifyAdminRoot || !i.verifyAdminRoot(bytes, i.policy.signature)) return { ok: false, code: "policy-signature" };
  const r = i.policy.record;
  if (r.serverDomain !== i.serverDomain || r.commit !== i.commit || r.arch !== i.arch || r.artifactSha256 !== i.measured.sha256 || r.provenanceSha256 !== i.provenanceSha256) {
    return { ok: false, code: "policy-mismatch" };
  }
  if (i.nowMs < r.issuedAtMs || i.nowMs >= r.expiresAtMs) return { ok: false, code: "policy-expired" };
  return { ok: true, basis: "owner-local-build" };
}
