/**
 * Attested community adapters (SECURITY-HARDENING-PLAN.md 10.3, SEC-ADAPTER-002).
 *
 * A content hash proves only that bytes match their name. Two signed documents say more:
 *
 *   attestation  Flagship's AI-vetting pipeline passed (or failed, or was unavailable for) ONE
 *                adapter digest on ONE base revision, with a named validator and model version,
 *                evidence hash and capability digest. It is not a human security review and says so.
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
import type { Bytes, Keypair } from "./types.js";

export const TAG_ADAPTER_ATTESTATION = "flagship/adapter-attestation/v1";
export const TAG_ADAPTER_INDEX = "flagship/adapter-index/v1";

export type VettingOutcome = "pass" | "fail" | "unavailable";

export interface AdapterAttestation {
  adapterDigestHex: string;
  /** The exact upstream revision the adapter was written against. */
  baseRevision: string;
  /** Digest of the authority the adapted app asks for (`capabilityDigest`). */
  capabilityDigestHex: string;
  validatorVersion: string;
  modelVersion: string;
  /** SHA-256 of the test and review evidence. */
  evidenceSha256Hex: string;
  outcome: VettingOutcome;
  issuedAt: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function canonicalAdapterAttestation(a: AdapterAttestation): Bytes {
  for (const k of ["adapterDigestHex", "capabilityDigestHex", "evidenceSha256Hex"] as const) {
    if (!HEX64.test(a[k])) throw new Error(`${k} must be 64 lowercase hex characters`);
  }
  for (const k of ["baseRevision", "validatorVersion", "modelVersion"] as const) legacyFieldGuard(k, a[k]);
  if (!["pass", "fail", "unavailable"].includes(a.outcome)) throw new Error("bad outcome");
  if (!Number.isSafeInteger(a.issuedAt) || a.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode(
    [TAG_ADAPTER_ATTESTATION, a.adapterDigestHex, a.baseRevision, a.capabilityDigestHex, a.validatorVersion, a.modelVersion, a.evidenceSha256Hex, a.outcome, a.issuedAt].join("|"),
  );
}

export function attestationDigest(a: AdapterAttestation): string {
  return hex(sha256(canonicalAdapterAttestation(a)));
}

export function signAdapterAttestation(a: AdapterAttestation, key: Keypair): { attestation: AdapterAttestation; signerPubHex: string; signatureHex: string } {
  return { attestation: a, signerPubHex: hex(key.publicKey), signatureHex: hex(ed.sign(canonicalAdapterAttestation(a), key.privateKey)) };
}

export interface PinnedVettingKey {
  pubHex: string;
  notBefore: number;
  notAfter: number;
}

function keyValidAt(keys: readonly PinnedVettingKey[], pubHex: string, at: number): boolean {
  return keys.some((k) => k.pubHex === pubHex && k.notBefore <= at && at < k.notAfter);
}

function unhex(h: string): Bytes {
  return Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
}

export function verifyAdapterAttestation(
  signed: { attestation: AdapterAttestation; signerPubHex: string; signatureHex: string },
  pinned: readonly PinnedVettingKey[],
): boolean {
  try {
    if (!keyValidAt(pinned, signed.signerPubHex, signed.attestation.issuedAt)) return false;
    return ed.verify(unhex(signed.signatureHex), canonicalAdapterAttestation(signed.attestation), unhex(signed.signerPubHex));
  } catch {
    return false;
  }
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

export function canonicalAdapterIndex(b: AdapterIndexBody): Bytes {
  if (!Number.isSafeInteger(b.sequence) || b.sequence < 1) throw new Error("bad sequence");
  if (b.prevDigestHex !== "genesis" && !HEX64.test(b.prevDigestHex)) throw new Error("bad prevDigestHex");
  if (!Number.isSafeInteger(b.issuedAt) || !Number.isSafeInteger(b.expiresAt) || b.expiresAt <= b.issuedAt) throw new Error("bad validity");
  for (const d of [...b.attestationDigests, ...b.withdrawn]) if (!HEX64.test(d)) throw new Error("bad digest in index");
  const list = (xs: string[]) => [...xs].sort().join(",");
  return new TextEncoder().encode([TAG_ADAPTER_INDEX, b.sequence, b.prevDigestHex, b.issuedAt, b.expiresAt, list(b.attestationDigests), list(b.withdrawn)].join("|"));
}

export function adapterIndexDigest(b: AdapterIndexBody): string {
  return hex(sha256(canonicalAdapterIndex(b)));
}

export function signAdapterIndex(b: AdapterIndexBody, key: Keypair): { index: AdapterIndexBody; signerPubHex: string; signatureHex: string } {
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
  signed: { index: AdapterIndexBody; signerPubHex: string; signatureHex: string },
  pinned: readonly PinnedVettingKey[],
  highWater: IndexHighWater | null,
  now: number,
): IndexVerdict {
  const b = signed.index;
  try {
    if (!keyValidAt(pinned, signed.signerPubHex, b.issuedAt)) return { ok: false, reason: "unknown-key" };
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
