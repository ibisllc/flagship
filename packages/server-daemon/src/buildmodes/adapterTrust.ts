/**
 * Whether this box may apply a community adapter (SECURITY-HARDENING-PLAN.md 10.3 and 17.2,
 * SEC-ADAPTER-002). Acceptance is a property of one service and one exact digest, never of the
 * public catalog:
 *
 *   repo-authored   in the exact source commit the owner chose: untrusted app code, same provenance.
 *   ai-vetted       a valid attestation from a pinned vetting key, listed in the current signed index,
 *                   not withdrawn, for THIS digest, base revision and capability digest. It only
 *                   authorizes use where the service admin has chosen standing trust in vetted
 *                   digests; the model's verdict alone never does.
 *   community       an inert diff until an admin picks the exact digest. Failed or missing review is
 *                   shown and acknowledged, never hidden behind a "safe" badge.
 *
 * A digest that does not match its bytes cannot be made valid by clicking through a warning.
 */
import { createHash } from "node:crypto";
import {
  verifyAdapterAttestation,
  verifyAdapterIndex,
  attestationDigest,
  type AdapterAttestation,
  type AdapterIndexBody,
  type IndexHighWater,
  type PinnedVettingKey,
} from "@flagship/protocol";

export type Provenance = "repo-authored" | "ai-vetted" | "community";

export interface AdapterCandidate {
  /** SHA-256 the index names it by. */
  digestHex: string;
  /** The adapter's actual bytes, to check the digest against. */
  bytes: Uint8Array;
  baseRevision: string;
  capabilityDigestHex: string;
  provenance: Provenance;
}

export interface ServicePolicy {
  /** Exact digests an admin chose by hand, with the digest of the authority they approved. */
  manual: Array<{ digestHex: string; capabilityDigestHex: string; acknowledgedReview: "pass" | "fail" | "missing"; at: number }>;
  /** Standing trust in currently attested digests (revocable). */
  standingVetted: boolean;
  /** The authority an earlier vetted adapter was approved for; a change needs approval again. */
  approvedCapabilityDigestHex: string | null;
}

export type TrustDecision =
  | { use: true; basis: "repo-authored" | "manual" | "standing-vetted"; review: "pass" | "fail" | "missing" | "unavailable" }
  | { use: false; code: "integrity" | "withdrawn" | "needs-acceptance" | "capability-expanded" | "index-unusable" | "review-failed"; reason: string };

export interface IndexState {
  highWater: IndexHighWater | null;
  /** Attestations delivered with the current index, by attestation digest. */
  attestations: Map<string, { attestation: AdapterAttestation; signerPubHex: string; signatureHex: string }>;
  withdrawn: Set<string>;
  usable: boolean;
  expiresAt: number;
}

export class AdapterTrust {
  private state: IndexState = { highWater: null, attestations: new Map(), withdrawn: new Set(), usable: false, expiresAt: 0 };

  constructor(
    private readonly pinned: () => readonly PinnedVettingKey[],
    private readonly now: () => number = () => Date.now(),
  ) {}

  get highWater(): IndexHighWater | null {
    return this.state.highWater;
  }

  /** Take a new signed index with its attestations. Refuses a rollback, a fork, an expired or unsigned one. */
  accept(
    signed: { index: AdapterIndexBody; signerPubHex: string; signatureHex: string },
    attestations: Array<{ attestation: AdapterAttestation; signerPubHex: string; signatureHex: string }>,
  ): { ok: true } | { ok: false; reason: string } {
    const verdict = verifyAdapterIndex(signed, this.pinned(), this.state.highWater, this.now());
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const listed = new Set(signed.index.attestationDigests);
    const byDigest = new Map<string, (typeof attestations)[number]>();
    for (const a of attestations) {
      let d: string;
      try {
        d = attestationDigest(a.attestation);
      } catch {
        continue;
      }
      // Only attestations the signed index lists, and only ones whose own signature verifies.
      if (listed.has(d) && verifyAdapterAttestation(a, this.pinned())) byDigest.set(d, a);
    }
    this.state = {
      highWater: { sequence: signed.index.sequence, digestHex: verdict.digestHex },
      attestations: byDigest,
      withdrawn: new Set(signed.index.withdrawn),
      usable: true,
      expiresAt: signed.index.expiresAt,
    };
    return { ok: true };
  }

  /** The index lapses by its own expiry; a box with no current index treats attestations as absent. */
  private indexUsable(): boolean {
    return this.state.usable && this.now() < this.state.expiresAt;
  }

  review(c: AdapterCandidate): "pass" | "fail" | "unavailable" | "missing" {
    if (!this.indexUsable()) return "missing";
    for (const a of this.state.attestations.values()) {
      const t = a.attestation;
      if (t.adapterDigestHex === c.digestHex && t.baseRevision === c.baseRevision && t.capabilityDigestHex === c.capabilityDigestHex) return t.outcome;
    }
    return "missing";
  }

  decide(c: AdapterCandidate, policy: ServicePolicy): TrustDecision {
    // The bytes must be what the digest says; nothing the owner clicks changes that.
    if (createHash("sha256").update(c.bytes).digest("hex") !== c.digestHex) {
      return { use: false, code: "integrity", reason: "the adapter does not match its digest" };
    }
    if (this.state.withdrawn.has(c.digestHex)) {
      return { use: false, code: "withdrawn", reason: "this adapter was withdrawn" };
    }
    const review = this.review(c);
    if (c.provenance === "repo-authored") return { use: true, basis: "repo-authored", review };

    const manual = policy.manual.find((m) => m.digestHex === c.digestHex);
    if (manual) {
      if (manual.capabilityDigestHex !== c.capabilityDigestHex) {
        return { use: false, code: "capability-expanded", reason: "the adapter now asks for different authority than you approved" };
      }
      return { use: true, basis: "manual", review };
    }

    if (c.provenance === "ai-vetted" && policy.standingVetted) {
      if (!this.indexUsable()) return { use: false, code: "index-unusable", reason: "the vetting index is missing, expired or not trusted" };
      if (review === "fail") return { use: false, code: "review-failed", reason: "the vetting review failed" };
      if (review !== "pass") return { use: false, code: "needs-acceptance", reason: "no passing attestation covers this exact adapter" };
      if (policy.approvedCapabilityDigestHex && policy.approvedCapabilityDigestHex !== c.capabilityDigestHex) {
        return { use: false, code: "capability-expanded", reason: "the vetted adapter asks for more authority than you approved" };
      }
      return { use: true, basis: "standing-vetted", review: "pass" };
    }
    return { use: false, code: "needs-acceptance", reason: "an admin has not chosen this exact adapter" };
  }
}
