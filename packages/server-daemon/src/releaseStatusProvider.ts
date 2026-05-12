/**
 * Bridges the offline `releaseVerifier` to the BFF wire format.
 *
 * Why split this out: `releaseVerifier.ts` returns the internal
 * `ReleaseStatus` shape (rich types from @maintainers/protocol).
 * `screens/types.ts` is the wire contract used by webapp + phone +
 * mobile clients. Keeping the reshape in one place means the wire
 * shape can evolve independently of the verifier's internals.
 */

import {
  verifyMaintainersFolder,
  type ReleaseStatus,
} from "./releaseVerifier.js";
import type {
  ReleaseStatusEndorsementSummary,
  ReleaseStatusResponse,
  ReleaseStatusTakeoverAlarm,
  ReleaseStatusTrackSummary,
} from "./screens/types.js";

export interface ReleaseStatusProvider {
  /** Returns the current verdict. Caller is responsible for caching. */
  status(): ReleaseStatus;
}

/**
 * Default provider: reads `.maintainers/` from the given git clone
 * path on every call. The daemon's update gate + BFF caller decides
 * whether to cache.
 *
 * Errors during read are swallowed and surface as `rootPolicyPresent
 * = false` — the same shape the verifier emits when there's no
 * `.maintainers/` at all. The intent: a busted folder shouldn't crash
 * the daemon's HTTP surface; it shows up in the UI as "no policy."
 */
export class FsReleaseStatusProvider implements ReleaseStatusProvider {
  constructor(private readonly opts: { gitRepoPath: string; now?: () => Date }) {}

  status(): ReleaseStatus {
    try {
      return verifyMaintainersFolder({
        gitRepoPath: this.opts.gitRepoPath,
        now: this.opts.now?.(),
      });
    } catch {
      return {
        rootDir: `${this.opts.gitRepoPath}/.maintainers`,
        rootPolicyPresent: false,
        tracks: [],
        currentRelease: null,
        validEndorsements: [],
        endorsementErrors: [],
        pendingTakeoverAlarm: null,
      };
    }
  }
}

export function toReleaseStatusResponse(status: ReleaseStatus): ReleaseStatusResponse {
  const tracks: ReleaseStatusTrackSummary[] = status.tracks.map((t) => ({
    track: t.track,
    hasPolicy: t.hasPolicy,
    totalMandates: t.totalMandates,
    validMandates: t.validMandates,
    currentHolderPubkey: t.currentHolder,
    currentMandateExpiresAt: t.currentMandateExpiresAt,
    successorPubkeyPrefixes: t.successors.map((p) => p.slice(0, 12)),
    rejectionReasons: t.rejections.map((r) =>
      r.detail ? `${r.reason}: ${r.detail}` : r.reason,
    ),
  }));

  const validEndorsements: ReleaseStatusEndorsementSummary[] = status.validEndorsements.map(
    (e) => ({
      releaseId: e.releaseId,
      semverTag: e.semverTag,
      commitHash: e.commitHash,
      previousReleaseId: e.previousReleaseId,
      previousCommitHash: e.previousCommitHash,
      intermediateCount: e.intermediateCommits.length,
      issuedAt: e.issuedAt,
      signedByPubkey: e.signedBy,
    }),
  );

  const currentRelease =
    validEndorsements.length > 0
      ? validEndorsements[validEndorsements.length - 1] ?? null
      : null;

  const pendingTakeoverAlarm: ReleaseStatusTakeoverAlarm | null = status.pendingTakeoverAlarm
    ? {
        track: status.pendingTakeoverAlarm.track,
        previousMandateId: status.pendingTakeoverAlarm.previousMandate,
        newMandateId: status.pendingTakeoverAlarm.newMandate,
        previousHolder: status.pendingTakeoverAlarm.previousHolder,
        newHolder: status.pendingTakeoverAlarm.newHolder,
        detectedAt: status.pendingTakeoverAlarm.detectedAt,
      }
    : null;

  return {
    rootPolicyPresent: status.rootPolicyPresent,
    tracks,
    currentRelease,
    validEndorsements,
    endorsementErrors: status.endorsementErrors,
    pendingTakeoverAlarm,
  };
}
