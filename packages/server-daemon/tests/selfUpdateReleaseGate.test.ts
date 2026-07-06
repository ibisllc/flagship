/**
 * The AUTHENTICITY half of the self-update 2-of-2 gate: the real ReleaseGate
 * over the maintainers release-endorsement machinery. These tests drive the
 * gate's DECISION logic through its injected seams (worktree/ref status
 * readers + the git lineage walk); the underlying crypto verification is
 * `verifyMaintainersFolder`, covered by releaseVerifier.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { ReleaseEndorsement } from "@ibisllc/maintainers";
import { buildMaintainersReleaseGate } from "../src/selfUpdateReleaseGate.js";
import type { ReleaseStatus } from "../src/releaseVerifier.js";

const TARGET = "2222222222222222222222222222222222222222";
const PIN = "aa".repeat(32);

function endorsementFor(commitHash: string): ReleaseEndorsement {
  return {
    kind: "ReleaseEndorsement",
    version: 1,
    releaseId: "r-1",
    semverTag: "v1.2.3",
    commitHash,
    previousReleaseId: null,
    previousCommitHash: null,
    intermediateMerkleRoot: "",
    intermediateCommits: [],
    issuedAt: "2026-07-01T00:00:00Z",
    signedBy: "holder",
    signatures: [],
  } as unknown as ReleaseEndorsement;
}

function statusWith(endorsements: ReleaseEndorsement[]): ReleaseStatus {
  return {
    rootDir: "/opt/flagship/.maintainers",
    rootPolicyPresent: true,
    tracks: [],
    currentRelease: endorsements[endorsements.length - 1] ?? null,
    validEndorsements: endorsements,
    endorsementErrors: [],
    pendingTakeoverAlarm: null,
  };
}

describe("buildMaintainersReleaseGate", () => {
  it("FAIL-CLOSES when the baked maintainer pin is unconfigured (providers never consulted)", () => {
    let consulted = 0;
    const gate = buildMaintainersReleaseGate({
      repoPath: "/opt/flagship",
      pinnedMandateHash: "",
      statusForWorktree: () => {
        consulted++;
        return statusWith([endorsementFor(TARGET)]);
      },
      statusForRef: () => {
        consulted++;
        return null;
      },
      verifyWalk: () => ({ ok: true }),
    });
    expect(() => gate.assertCommitEndorsed(TARGET)).toThrow(/pinned-mandate hash is unconfigured/);
    expect(consulted).toBe(0);
  });

  it("passes an endorsed commit found in the worktree snapshot (walk verified)", () => {
    const walked: string[] = [];
    const gate = buildMaintainersReleaseGate({
      repoPath: "/opt/flagship",
      pinnedMandateHash: PIN,
      statusForWorktree: () => statusWith([endorsementFor(TARGET)]),
      statusForRef: () => null,
      verifyWalk: (e) => {
        walked.push(e.commitHash);
        return { ok: true };
      },
    });
    expect(() => gate.assertCommitEndorsed(TARGET)).not.toThrow();
    expect(walked).toEqual([TARGET]);
    // Case-insensitive match on the commit hash.
    expect(() => gate.assertCommitEndorsed(TARGET.toUpperCase())).not.toThrow();
  });

  it("falls back to fetched refs when the worktree lacks the (newer) endorsement", () => {
    const refsAsked: string[] = [];
    const gate = buildMaintainersReleaseGate({
      repoPath: "/opt/flagship",
      pinnedMandateHash: PIN,
      refCandidates: ["FETCH_HEAD", "origin/main"],
      statusForWorktree: () => statusWith([]),
      statusForRef: (ref) => {
        refsAsked.push(ref);
        return ref === "origin/main" ? statusWith([endorsementFor(TARGET)]) : null;
      },
      verifyWalk: () => ({ ok: true }),
    });
    expect(() => gate.assertCommitEndorsed(TARGET)).not.toThrow();
    expect(refsAsked).toEqual(["FETCH_HEAD", "origin/main"]);
  });

  it("rejects a commit with no valid endorsement anywhere", () => {
    const gate = buildMaintainersReleaseGate({
      repoPath: "/opt/flagship",
      pinnedMandateHash: PIN,
      statusForWorktree: () => statusWith([endorsementFor("1".repeat(40))]),
      statusForRef: () => statusWith([]),
      verifyWalk: () => ({ ok: true }),
    });
    expect(() => gate.assertCommitEndorsed(TARGET)).toThrow(/no valid maintainer release endorsement/);
  });

  it("rejects an endorsed commit whose local git lineage walk fails (hostile-mirror defense)", () => {
    const gate = buildMaintainersReleaseGate({
      repoPath: "/opt/flagship",
      pinnedMandateHash: PIN,
      statusForWorktree: () => statusWith([endorsementFor(TARGET)]),
      statusForRef: () => null,
      verifyWalk: () => ({
        ok: false,
        reason: "intermediate-order-mismatch",
        detail: "at index 0",
      }),
    });
    expect(() => gate.assertCommitEndorsed(TARGET)).toThrow(/failed the local git lineage walk/);
  });

  it("rejects an empty target commit", () => {
    const gate = buildMaintainersReleaseGate({
      repoPath: "/opt/flagship",
      pinnedMandateHash: PIN,
      statusForWorktree: () => statusWith([endorsementFor(TARGET)]),
      statusForRef: () => null,
      verifyWalk: () => ({ ok: true }),
    });
    expect(() => gate.assertCommitEndorsed("")).toThrow(/empty target commit/);
  });
});
