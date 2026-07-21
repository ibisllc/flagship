/**
 * Dev→prod promotion wall (feat/dev-prod-dataspace, spec §5–6).
 *
 * Two envelopes gate the transition from the synthetic dev dataspace to a real
 * production data principal:
 *
 *  1. `ServicePromoteOrder` — the OWNER (or admin root, when the account is
 *     admin-pinned) authorizes promoting an exact artifact to prod. The author
 *     (the vibecode model / imported repo) has NO tool that mints this; it is a
 *     phone action. Binds `artifactDigest` so only the reviewed bytes promote.
 *
 *  2. `CodeSecurityAttestation` — a REVIEW AUTHORITY (Flagship-operated or a
 *     maintainer delegate), distinct from the author, signs a verdict over the
 *     SAME `artifactDigest`. The daemon's promote consumer refuses to create the
 *     prod data principal unless a valid, unexpired attestation for that exact
 *     digest is present (spec §6 — the paid review gate).
 *
 * Honest framing: this gates WHEN prod data becomes reachable and records WHO
 * reviewed the exact bytes. It does not make deployed code incapable of
 * exfiltration at runtime — that residual risk is what the review itself, plus
 * runtime container hardening, address.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

const TAG_SERVICE_PROMOTE = "flagship/service-promote/v1";
const TAG_CODE_SECURITY_ATTESTATION = "flagship/code-security-attestation/v1";

/**
 * Owner/admin authorization to promote `(creator, slug)` on `serverId` from the
 * dev dataspace to production. `artifactDigest` is the hex SHA-256 of the
 * deployed artifact tree — the promotion (and the attestation, below) are bound
 * to these exact bytes, so a later edit cannot ride a prior approval to prod.
 */
export interface ServicePromoteOrder {
  serverId: ServerId;
  creator: string;
  slug: string;
  /** Hex SHA-256 of the exact artifact being promoted. */
  artifactDigest: string;
  issuedAt: number;
}

function canonicalServicePromote(r: ServicePromoteOrder): Bytes {
  legacyFieldGuard("creator", r.creator);
  legacyFieldGuard("slug", r.slug);
  legacyFieldGuard("artifactDigest", r.artifactDigest);
  return new TextEncoder().encode(
    [TAG_SERVICE_PROMOTE, r.serverId, r.creator, r.slug, r.artifactDigest, r.issuedAt].join("|"),
  );
}

export function signServicePromote(r: ServicePromoteOrder, signer: Keypair): Bytes {
  return ed.sign(canonicalServicePromote(r), signer.privateKey);
}

export function verifyServicePromote(r: ServicePromoteOrder, sig: Bytes, signerPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalServicePromote(r), signerPub);
  } catch {
    return false;
  }
}

/** Review verdict. `pass` is the only verdict that unlocks promotion. */
export type AttestationVerdict = "pass" | "fail";

/**
 * Signed by the review authority over the exact `artifactDigest`. `scanners`
 * is a free-form record of the tool versions that produced the verdict (kept in
 * the signature so the record is tamper-evident). `expiresAt` bounds how long a
 * verdict is honoured — a stale attestation is refused, forcing re-review.
 */
export interface CodeSecurityAttestation {
  serverId: ServerId;
  creator: string;
  slug: string;
  artifactDigest: string;
  verdict: AttestationVerdict;
  /** e.g. "trivy@0.50.0,flagship-checks@3". Bound into the signature. */
  scanners: string;
  issuedAt: number;
  expiresAt: number;
}

function canonicalAttestation(a: CodeSecurityAttestation): Bytes {
  legacyFieldGuard("creator", a.creator);
  legacyFieldGuard("slug", a.slug);
  legacyFieldGuard("artifactDigest", a.artifactDigest);
  legacyFieldGuard("verdict", a.verdict);
  legacyFieldGuard("scanners", a.scanners);
  return new TextEncoder().encode(
    [
      TAG_CODE_SECURITY_ATTESTATION,
      a.serverId,
      a.creator,
      a.slug,
      a.artifactDigest,
      a.verdict,
      a.scanners,
      a.issuedAt,
      a.expiresAt,
    ].join("|"),
  );
}

export function signCodeSecurityAttestation(a: CodeSecurityAttestation, reviewKey: Keypair): Bytes {
  return ed.sign(canonicalAttestation(a), reviewKey.privateKey);
}

export function verifyCodeSecurityAttestation(
  a: CodeSecurityAttestation,
  sig: Bytes,
  reviewPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalAttestation(a), reviewPub);
  } catch {
    return false;
  }
}
