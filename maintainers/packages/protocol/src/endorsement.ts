/**
 * ReleaseEndorsement verification.
 *
 * Implements §5 of docs/spec/v1.md. Given a chain of release
 * endorsements + the verified track's mandate state, confirm that each
 * endorsement (a) is signed by the authority current at its issuedAt,
 * (b) chains correctly to its predecessor, and (c) carries an
 * intermediateMerkleRoot consistent with its intermediateCommits list.
 *
 * The git-history portion (each intermediate commit existing locally
 * and the first-parent walk visiting exactly those commits in order)
 * is NOT enforced in this package — that requires a git-aware
 * environment. We expose `verifyChainOfEndorsements` for the
 * cryptographic + structural checks; consumers add the git-walk on
 * top.
 */

import { canonicalReleaseEndorsement } from "./canonical.js";
import { intermediateMerkleRoot, verify } from "./crypto.js";
import { currentAuthority, type VerifiedTrack } from "./verifier.js";
import type { ApprovalRule, ReleaseEndorsement } from "./types.js";

export type EndorsementResult =
  | { ok: true; endorsement: ReleaseEndorsement }
  | { ok: false; reason: EndorsementFailReason; index: number; detail?: string };

export type EndorsementFailReason =
  | "signature-invalid"
  | "approval-rule-unsatisfied"
  | "signer-not-authorized"
  | "no-authority-at-issuance"
  | "merkle-root-mismatch"
  | "predecessor-mismatch"
  | "genesis-must-have-no-predecessor"
  | "non-genesis-must-have-predecessor"
  | "duplicate-release-id";

export interface VerifiedEndorsements {
  endorsements: ReleaseEndorsement[];
  validEndorsements: ReleaseEndorsement[];
  rejections: { endorsement: ReleaseEndorsement; reason: EndorsementFailReason; detail?: string }[];
}

/**
 * Verify a chain of release endorsements against a verified release-track.
 * Endorsements MUST be in canonical-log order (oldest first).
 */
export function verifyChainOfEndorsements(
  endorsements: ReleaseEndorsement[],
  releaseTrack: VerifiedTrack,
  trackApprovalRule: ApprovalRule,
): VerifiedEndorsements {
  const seenIds = new Set<string>();
  const valid: ReleaseEndorsement[] = [];
  const rejections: VerifiedEndorsements["rejections"] = [];

  for (let i = 0; i < endorsements.length; i++) {
    const e = endorsements[i]!;
    const prev = valid[valid.length - 1];

    const result = verifySingleEndorsement(e, prev, releaseTrack, trackApprovalRule, seenIds);
    if (result.ok) {
      valid.push(e);
      seenIds.add(e.releaseId);
    } else {
      rejections.push({ endorsement: e, reason: result.reason, detail: result.detail });
    }
  }

  return { endorsements, validEndorsements: valid, rejections };
}

function verifySingleEndorsement(
  e: ReleaseEndorsement,
  prev: ReleaseEndorsement | undefined,
  releaseTrack: VerifiedTrack,
  approvalRule: ApprovalRule,
  seenIds: Set<string>,
): EndorsementResult {
  if (seenIds.has(e.releaseId)) {
    return { ok: false, reason: "duplicate-release-id", index: -1 };
  }

  // Genesis-vs-non-genesis structural check
  if (!prev) {
    if (e.previousReleaseId !== null || e.previousCommitHash !== null) {
      return {
        ok: false,
        reason: "genesis-must-have-no-predecessor",
        index: -1,
      };
    }
  } else {
    if (e.previousReleaseId === null || e.previousCommitHash === null) {
      return {
        ok: false,
        reason: "non-genesis-must-have-predecessor",
        index: -1,
      };
    }
    if (e.previousReleaseId !== prev.releaseId || e.previousCommitHash !== prev.commitHash) {
      return {
        ok: false,
        reason: "predecessor-mismatch",
        index: -1,
        detail: `expected previousReleaseId=${prev.releaseId} previousCommitHash=${prev.commitHash}; got ${e.previousReleaseId}/${e.previousCommitHash}`,
      };
    }
  }

  // Merkle root re-derivation
  let expectedRoot: string;
  try {
    expectedRoot = intermediateMerkleRoot(e.intermediateCommits);
  } catch (err) {
    return {
      ok: false,
      reason: "merkle-root-mismatch",
      index: -1,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (expectedRoot !== e.intermediateMerkleRoot) {
    return {
      ok: false,
      reason: "merkle-root-mismatch",
      index: -1,
      detail: `recomputed root ${expectedRoot} does not match field ${e.intermediateMerkleRoot}`,
    };
  }

  // Signature verification
  const bytes = canonicalReleaseEndorsement(e);
  for (let i = 0; i < e.signatures.length; i++) {
    const s = e.signatures[i]!;
    if (!verify(s.sig, bytes, s.pubkey)) {
      return {
        ok: false,
        reason: "signature-invalid",
        index: -1,
        detail: `signature ${i} did not verify`,
      };
    }
  }

  // Authority check
  const authority = currentAuthority(releaseTrack, new Date(Date.parse(e.issuedAt)));
  if (!authority) {
    return { ok: false, reason: "no-authority-at-issuance", index: -1 };
  }

  // Approval-rule satisfaction against authority
  const signerPubkeys = new Set(e.signatures.map((s) => s.pubkey));
  if (!signerPubkeys.has(e.signedBy)) {
    return {
      ok: false,
      reason: "signer-not-authorized",
      index: -1,
      detail: "signedBy field not present in signatures",
    };
  }
  // Authorized set: holder + (configured signers if specific list)
  if (approvalRule.kind === "threshold" && approvalRule.of === "anyAuthorizedSigner") {
    // "any" = holder of the active mandate
    if (e.signedBy !== authority.holder) {
      return {
        ok: false,
        reason: "signer-not-authorized",
        index: -1,
        detail: `endorsement signedBy ${e.signedBy} but current authority holder is ${authority.holder}`,
      };
    }
    if (approvalRule.threshold > signerPubkeys.size) {
      return { ok: false, reason: "approval-rule-unsatisfied", index: -1 };
    }
  } else if (approvalRule.kind === "threshold") {
    // Specific pubkey list
    const required = new Set(approvalRule.of);
    let matches = 0;
    for (const pk of signerPubkeys) if (required.has(pk)) matches++;
    if (matches < approvalRule.threshold) {
      return { ok: false, reason: "approval-rule-unsatisfied", index: -1 };
    }
  }

  return { ok: true, endorsement: e };
}
