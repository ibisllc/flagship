/**
 * Endorsement-chain verification tests. Builds a valid release-track,
 * issues endorsements signed by the track's current holder, and
 * confirms acceptance + rejection paths.
 */
import { describe, expect, it } from "vitest";
import { generateKeypair, intermediateMerkleRoot } from "../src/crypto.js";
import { signMandate, signReleaseEndorsement } from "../src/signing.js";
import { verifyTrack } from "../src/verifier.js";
import { verifyChainOfEndorsements } from "../src/endorsement.js";
import type { Mandate, ReleaseEndorsement, TrackPolicy } from "../src/types.js";

function keypair(seedByte: number): { privKey: string; pubKey: string } {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

const policy: TrackPolicy = {
  track: "release",
  defaultMandateDuration: "60d",
  approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
};

function makeReleaseTrack(): { mandates: Mandate[]; alice: { privKey: string; pubKey: string } } {
  const alice = keypair(1);
  const genesis = signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: "g1",
      track: "release",
      holder: alice.pubKey,
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
      successors: [],
      signedBy: alice.pubKey,
    },
    [{ privKey: alice.privKey }],
  );
  return { mandates: [genesis], alice };
}

const HASH = (n: number): string =>
  n.toString(16).padStart(2, "0").repeat(20); // 40 hex chars

function mkEndorsement(
  signer: { privKey: string; pubKey: string },
  opts: {
    releaseId: string;
    semverTag: string;
    commitHash: string;
    intermediateCommits: string[];
    previousReleaseId: string | null;
    previousCommitHash: string | null;
    issuedAt?: string;
  },
): ReleaseEndorsement {
  return signReleaseEndorsement(
    {
      kind: "ReleaseEndorsement",
      version: 1,
      releaseId: opts.releaseId,
      semverTag: opts.semverTag,
      commitHash: opts.commitHash,
      previousReleaseId: opts.previousReleaseId,
      previousCommitHash: opts.previousCommitHash,
      intermediateCommits: opts.intermediateCommits,
      intermediateMerkleRoot: intermediateMerkleRoot(opts.intermediateCommits),
      endorsedNotes: null,
      issuedAt: opts.issuedAt ?? "2026-02-01T00:00:00Z",
      signedBy: signer.pubKey,
    },
    [{ privKey: signer.privKey }],
  );
}

describe("verifyChainOfEndorsements", () => {
  it("accepts a single genesis endorsement", () => {
    const track = makeReleaseTrack();
    const verified = verifyTrack("release", policy, track.mandates);
    const e = mkEndorsement(track.alice, {
      releaseId: "r1",
      semverTag: "v0.1.0",
      commitHash: HASH(1),
      intermediateCommits: [],
      previousReleaseId: null,
      previousCommitHash: null,
    });
    const result = verifyChainOfEndorsements([e], verified, policy.approvalRule);
    expect(result.validEndorsements).toHaveLength(1);
    expect(result.rejections).toHaveLength(0);
  });

  it("accepts a chain of two endorsements", () => {
    const track = makeReleaseTrack();
    const verified = verifyTrack("release", policy, track.mandates);
    const e1 = mkEndorsement(track.alice, {
      releaseId: "r1",
      semverTag: "v0.1.0",
      commitHash: HASH(1),
      intermediateCommits: [],
      previousReleaseId: null,
      previousCommitHash: null,
    });
    const e2 = mkEndorsement(track.alice, {
      releaseId: "r2",
      semverTag: "v0.2.0",
      commitHash: HASH(5),
      intermediateCommits: [HASH(2), HASH(3), HASH(4), HASH(5)],
      previousReleaseId: "r1",
      previousCommitHash: HASH(1),
      issuedAt: "2026-03-01T00:00:00Z",
    });
    const result = verifyChainOfEndorsements([e1, e2], verified, policy.approvalRule);
    expect(result.validEndorsements).toHaveLength(2);
  });

  it("rejects a genesis endorsement that has a previous*", () => {
    const track = makeReleaseTrack();
    const verified = verifyTrack("release", policy, track.mandates);
    const e = mkEndorsement(track.alice, {
      releaseId: "r1",
      semverTag: "v0.1.0",
      commitHash: HASH(1),
      intermediateCommits: [],
      previousReleaseId: "r0",
      previousCommitHash: HASH(0),
    });
    const result = verifyChainOfEndorsements([e], verified, policy.approvalRule);
    expect(result.rejections[0]?.reason).toBe("genesis-must-have-no-predecessor");
  });

  it("rejects a non-genesis without previousReleaseId", () => {
    const track = makeReleaseTrack();
    const verified = verifyTrack("release", policy, track.mandates);
    const e1 = mkEndorsement(track.alice, {
      releaseId: "r1",
      semverTag: "v0.1.0",
      commitHash: HASH(1),
      intermediateCommits: [],
      previousReleaseId: null,
      previousCommitHash: null,
    });
    const e2 = mkEndorsement(track.alice, {
      releaseId: "r2",
      semverTag: "v0.2.0",
      commitHash: HASH(2),
      intermediateCommits: [HASH(2)],
      previousReleaseId: null, // wrong — should reference r1
      previousCommitHash: null,
      issuedAt: "2026-03-01T00:00:00Z",
    });
    const result = verifyChainOfEndorsements([e1, e2], verified, policy.approvalRule);
    expect(result.validEndorsements).toHaveLength(1);
    expect(result.rejections[0]?.reason).toBe("non-genesis-must-have-predecessor");
  });

  it("rejects a mismatched predecessor pointer", () => {
    const track = makeReleaseTrack();
    const verified = verifyTrack("release", policy, track.mandates);
    const e1 = mkEndorsement(track.alice, {
      releaseId: "r1",
      semverTag: "v0.1.0",
      commitHash: HASH(1),
      intermediateCommits: [],
      previousReleaseId: null,
      previousCommitHash: null,
    });
    const e2 = mkEndorsement(track.alice, {
      releaseId: "r2",
      semverTag: "v0.2.0",
      commitHash: HASH(5),
      intermediateCommits: [HASH(5)],
      previousReleaseId: "WRONG-PREV",
      previousCommitHash: HASH(99),
      issuedAt: "2026-03-01T00:00:00Z",
    });
    const result = verifyChainOfEndorsements([e1, e2], verified, policy.approvalRule);
    expect(result.rejections[0]?.reason).toBe("predecessor-mismatch");
  });

  it("rejects an endorsement with tampered intermediateCommits", () => {
    const track = makeReleaseTrack();
    const verified = verifyTrack("release", policy, track.mandates);
    const correctCommits = [HASH(2), HASH(3), HASH(4)];
    const e: ReleaseEndorsement = mkEndorsement(track.alice, {
      releaseId: "r1",
      semverTag: "v0.1.0",
      commitHash: HASH(4),
      intermediateCommits: correctCommits,
      previousReleaseId: null,
      previousCommitHash: null,
    });
    // Now mutate the intermediateCommits without recomputing the root
    const tampered: ReleaseEndorsement = {
      ...e,
      intermediateCommits: [HASH(2), HASH(99), HASH(4)],
    };
    const result = verifyChainOfEndorsements([tampered], verified, policy.approvalRule);
    expect(result.rejections[0]?.reason).toBe("merkle-root-mismatch");
  });

  it("rejects an endorsement signed by a non-authority", () => {
    const track = makeReleaseTrack();
    const verified = verifyTrack("release", policy, track.mandates);
    const eve = keypair(99);
    const e = mkEndorsement(eve, {
      releaseId: "r1",
      semverTag: "v0.1.0",
      commitHash: HASH(1),
      intermediateCommits: [],
      previousReleaseId: null,
      previousCommitHash: null,
    });
    const result = verifyChainOfEndorsements([e], verified, policy.approvalRule);
    // signer-not-authorized: eve isn't the current holder
    expect(result.rejections[0]?.reason).toBe("signer-not-authorized");
  });

  it("rejects an endorsement issued after the track's authority expired", () => {
    const track = makeReleaseTrack();
    const verified = verifyTrack("release", policy, track.mandates);
    const e = mkEndorsement(track.alice, {
      releaseId: "r1",
      semverTag: "v0.1.0",
      commitHash: HASH(1),
      intermediateCommits: [],
      previousReleaseId: null,
      previousCommitHash: null,
      issuedAt: "2028-01-01T00:00:00Z", // after track expires
    });
    const result = verifyChainOfEndorsements([e], verified, policy.approvalRule);
    expect(result.rejections[0]?.reason).toBe("no-authority-at-issuance");
  });
});
