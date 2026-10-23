/**
 * Attested community adapters (SECURITY-HARDENING-PLAN.md 10.3, SEC-ADAPTER-002).
 *
 * A content hash proves only that bytes match their name. Two signed documents say more:
 *
 *   attestation  Flagship's AI-vetting pipeline passed (or failed, or was unavailable for) ONE
 *                adapter digest of ONE repo on ONE base revision, under a named validator, review
 *                policy and reviewer model, with an evidence hash and capability digest, valid until
 *                `expiresAt`. A `revoked` attestation withdraws the digest for good: it beats every
 *                attestation of that digest, earlier or later. It is not a human security review.
 *   index        a signed, append-only, rollback-protected list of attestations and withdrawals,
 *                with an expiry. A box keeps the highest sequence it has seen and refuses any lower
 *                one, so a stale or replayed index cannot bring a withdrawn adapter back.
 *
 * Signing keys are pinned with validity windows so they can rotate. A model may triage and explain;
 * only these signatures, made by the pipeline's key and not by the model, count.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import { capabilitiesOf, capabilityDigest } from "./manifestCapabilities.js";
import { parseManifest } from "./manifest.js";
import { splitAdapterFile } from "./repoAdapter.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_ADAPTER_ATTESTATION = "flagship/adapter-attestation/v1";
export const TAG_ADAPTER_INDEX = "flagship/adapter-index/v1";

export type VettingOutcome = "pass" | "fail" | "unavailable" | "revoked";
const OUTCOMES: readonly VettingOutcome[] = ["pass", "fail", "unavailable", "revoked"];

export interface AdapterAttestation {
  /** SHA-256 of the exact adapter file. */
  adapterDigestHex: string;
  /** The upstream repo the adapter names (`source.repo`). */
  repo: string;
  /** The exact upstream revision the adapter was written against. */
  baseRevision: string;
  /** Digest of the authority the adapted app asks for (`capabilityDigest`). */
  capabilityDigestHex: string;
  /** Version of the deterministic checks that ran before any model saw it. */
  validatorVersion: string;
  /** Version of the review policy (prompt, categories, thresholds). */
  policyVersion: string;
  /** The reviewer model asked for. */
  reviewerModel: string;
  /** The model version that answered (`-` when none did). */
  modelVersion: string;
  /** SHA-256 of the static-check and review evidence. */
  evidenceSha256Hex: string;
  outcome: VettingOutcome;
  issuedAt: number;
  expiresAt: number;
}

export interface SignedAdapterAttestation {
  attestation: AdapterAttestation;
  signerPubHex: string;
  signatureHex: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export function canonicalAdapterAttestation(a: AdapterAttestation): Bytes {
  for (const k of ["adapterDigestHex", "capabilityDigestHex", "evidenceSha256Hex"] as const) {
    if (!HEX64.test(a[k])) throw new Error(`${k} must be 64 lowercase hex characters`);
  }
  if (!REVISION.test(a.baseRevision)) throw new Error("baseRevision must be a full lowercase commit hash");
  if (!/^https:\/\/[^\s|]+$/.test(a.repo)) throw new Error("repo must be an https repo address");
  for (const k of ["validatorVersion", "policyVersion", "reviewerModel", "modelVersion"] as const) {
    if (!a[k] || a[k].length > 128) throw new Error(`${k} must be 1..128 characters`);
    legacyFieldGuard(k, a[k]);
  }
  if (!OUTCOMES.includes(a.outcome)) throw new Error("bad outcome");
  if (!Number.isSafeInteger(a.issuedAt) || a.issuedAt < 0) throw new Error("bad issuedAt");
  if (!Number.isSafeInteger(a.expiresAt) || a.expiresAt <= a.issuedAt) throw new Error("bad expiresAt");
  return new TextEncoder().encode(
    [
      TAG_ADAPTER_ATTESTATION,
      a.adapterDigestHex,
      a.repo,
      a.baseRevision,
      a.capabilityDigestHex,
      a.validatorVersion,
      a.policyVersion,
      a.reviewerModel,
      a.modelVersion,
      a.evidenceSha256Hex,
      a.outcome,
      a.issuedAt,
      a.expiresAt,
    ].join("|"),
  );
}

export function attestationDigest(a: AdapterAttestation): string {
  return hex(sha256(canonicalAdapterAttestation(a)));
}

export function signAdapterAttestation(a: AdapterAttestation, key: Keypair): SignedAdapterAttestation {
  return { attestation: a, signerPubHex: hex(key.publicKey), signatureHex: hex(ed.sign(canonicalAdapterAttestation(a), key.privateKey)) };
}

export interface PinnedVettingKey {
  pubHex: string;
  notBefore: number;
  notAfter: number;
}

function pinnedAt(keys: readonly PinnedVettingKey[], pubHex: string, at: number): PinnedVettingKey | undefined {
  return keys.find((k) => k.pubHex === pubHex && k.notBefore <= at && at < k.notAfter);
}

function unhex(h: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Error("bad hex");
  return Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
}

export function verifyAdapterAttestation(signed: SignedAdapterAttestation, pinned: readonly PinnedVettingKey[]): boolean {
  try {
    if (!pinnedAt(pinned, signed.signerPubHex, signed.attestation.issuedAt)) return false;
    return ed.verify(unhex(signed.signatureHex), canonicalAdapterAttestation(signed.attestation), unhex(signed.signerPubHex));
  } catch {
    return false;
  }
}

export type AdapterStanding =
  | { state: "vetted"; attestation: AdapterAttestation }
  | { state: "revoked" | "failed" | "unavailable" | "expired" | "none" };

const RANK: Record<VettingOutcome, number> = { pass: 0, unavailable: 1, fail: 2, revoked: 3 };

/**
 * Where one adapter digest stands, from attestations that already verified. A revocation is final;
 * otherwise the latest attestation decides (on a tie the more cautious outcome), and a pass counts
 * only before its own expiry.
 */
export function adapterStanding(attestations: readonly AdapterAttestation[], adapterDigestHex: string, now: number): AdapterStanding {
  const mine = attestations.filter((a) => a.adapterDigestHex === adapterDigestHex);
  if (mine.some((a) => a.outcome === "revoked")) return { state: "revoked" };
  const latest = mine.reduce<AdapterAttestation | null>(
    (best, a) => (!best || a.issuedAt > best.issuedAt || (a.issuedAt === best.issuedAt && RANK[a.outcome] > RANK[best.outcome]) ? a : best),
    null,
  );
  if (!latest) return { state: "none" };
  if (latest.outcome === "fail") return { state: "failed" };
  if (latest.outcome === "unavailable") return { state: "unavailable" };
  if (now >= latest.expiresAt || now < latest.issuedAt - 5 * 60_000) return { state: "expired" };
  return { state: "vetted", attestation: latest };
}

/** The capability digest an adapter file's manifest asks for, or null when it is not a valid adapter file. */
export function adapterFileCapabilityDigest(fileText: string): string | null {
  const split = splitAdapterFile(fileText);
  if (!split.ok || !split.adapter) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(split.manifestJson);
  } catch {
    return null;
  }
  const parsed = parseManifest(raw);
  return parsed.ok ? capabilityDigest(capabilitiesOf(parsed.manifest)) : null;
}

export interface AdapterIndexBody {
  /** Strictly increasing. A box refuses a lower number than the highest it has seen. */
  sequence: number;
  /** Digest of the previous index, or `genesis`: the chain is append-only. */
  prevDigestHex: string;
  issuedAt: number;
  expiresAt: number;
  /** Digests of the attestations this index lists (the attestations travel beside it). */
  attestationDigests: string[];
  /** Adapter digests withdrawn (complaints, a later failed re-review). Withdrawal beats attestation. */
  withdrawn: string[];
}

export interface SignedAdapterIndex {
  index: AdapterIndexBody;
  signerPubHex: string;
  signatureHex: string;
}

/** What `.com` serves at `/api/adapters/index`: the signed index and every attestation it lists. */
export interface AdapterIndexDocument {
  schema: 1;
  index: SignedAdapterIndex;
  attestations: SignedAdapterAttestation[];
}

export function canonicalAdapterIndex(b: AdapterIndexBody): Bytes {
  if (!Number.isSafeInteger(b.sequence) || b.sequence < 1) throw new Error("bad sequence");
  if (b.prevDigestHex !== "genesis" && !HEX64.test(b.prevDigestHex)) throw new Error("bad prevDigestHex");
  if (!Number.isSafeInteger(b.issuedAt) || !Number.isSafeInteger(b.expiresAt) || b.expiresAt <= b.issuedAt) throw new Error("bad validity");
  for (const d of [...b.attestationDigests, ...b.withdrawn]) if (!HEX64.test(d)) throw new Error("bad digest in index");
  const list = (xs: string[]) => [...new Set(xs)].sort().join(",");
  return new TextEncoder().encode([TAG_ADAPTER_INDEX, b.sequence, b.prevDigestHex, b.issuedAt, b.expiresAt, list(b.attestationDigests), list(b.withdrawn)].join("|"));
}

export function adapterIndexDigest(b: AdapterIndexBody): string {
  return hex(sha256(canonicalAdapterIndex(b)));
}

export function signAdapterIndex(b: AdapterIndexBody, key: Keypair): SignedAdapterIndex {
  return { index: b, signerPubHex: hex(key.publicKey), signatureHex: hex(ed.sign(canonicalAdapterIndex(b), key.privateKey)) };
}

export type IndexVerdict =
  | { ok: true; digestHex: string }
  | { ok: false; reason: "bad-signature" | "unknown-key" | "expired" | "not-yet-valid" | "rollback" | "fork" | "gap" };

/** What a box remembers about the index between checks. */
export interface IndexHighWater {
  sequence: number;
  digestHex: string;
}

export function verifyAdapterIndex(
  signed: SignedAdapterIndex,
  pinned: readonly PinnedVettingKey[],
  highWater: IndexHighWater | null,
  now: number,
): IndexVerdict {
  const b = signed.index;
  try {
    const key = pinnedAt(pinned, signed.signerPubHex, b.issuedAt);
    // A key past its window signs nothing new, even with an issuedAt from inside it.
    if (!key || now >= key.notAfter) return { ok: false, reason: "unknown-key" };
    if (!ed.verify(unhex(signed.signatureHex), canonicalAdapterIndex(b), unhex(signed.signerPubHex))) return { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  if (now >= b.expiresAt) return { ok: false, reason: "expired" };
  if (b.issuedAt > now + 5 * 60_000) return { ok: false, reason: "not-yet-valid" };
  const digestHex = adapterIndexDigest(b);
  if (highWater) {
    if (b.sequence < highWater.sequence) return { ok: false, reason: "rollback" };
    if (b.sequence === highWater.sequence) return digestHex === highWater.digestHex ? { ok: true, digestHex } : { ok: false, reason: "fork" };
    // A newer index must extend the one we hold, or this one is a fork or skips history we never saw.
    if (b.sequence === highWater.sequence + 1 && b.prevDigestHex !== highWater.digestHex) return { ok: false, reason: "fork" };
  } else if (b.sequence === 1 && b.prevDigestHex !== "genesis") {
    return { ok: false, reason: "fork" };
  }
  return { ok: true, digestHex };
}
