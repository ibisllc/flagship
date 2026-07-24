/**
 * Tests for the daemon's offline release-verifier (LOCKED Phase-2 v2).
 *
 * Coverage:
 *   - reads `.maintainers/` v2 mandates from disk and reports the
 *     verify-forward-from-pin current authority
 *   - a tampered mandate breaks the pin anchor (fail-closed)
 *   - reports the current release endorsement when one is present
 *     (holder-signed, v2)
 *   - `verifyEndorsementChainAgainstGit` walks a real local git repo
 *     and accepts the intermediate-commit list when it matches; rejects
 *     mismatches in count or presence (unchanged by v2)
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  generateKeypair,
  intermediateMerkleRoot,
  mandatePinHash,
  signMandate,
  signReleaseEndorsement,
  type Mandate,
  type ReleaseEndorsement,
} from "@ibisllc/maintainers";
import {
  verifyEndorsementChainAgainstGit,
  verifyMaintainersFolder,
} from "../src/releaseVerifier.js";

const ISO_GENESIS = "2026-05-01T00:00:00.000Z";
const ISO_NEXT = "2026-06-01T00:00:00.000Z";
const ISO_AFTER_EXPIRY = "2026-07-15T00:00:00.000Z";
const DAY = 86400;

function kp(seedByte: number) {
  const b = new Uint8Array(32);
  b[0] = seedByte;
  return generateKeypair(b);
}

function makeRepoWith(seedByte: number): {
  rootDir: string;
  cleanup: () => void;
  primary: ReturnType<typeof kp>;
  backup: ReturnType<typeof kp>;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-rv-"));
  const dotM = path.join(tmp, ".maintainers");
  fs.mkdirSync(path.join(dotM, "tracks", "release", "mandates"), { recursive: true });
  fs.mkdirSync(path.join(dotM, "keys"), { recursive: true });
  const primary = kp(seedByte);
  const backup = kp(seedByte + 1);
  // No policy.json (root or track) in v2 — the succession rule is folded
  // into each mandate. A KeyFile is kept only for holder-name lookup.
  fs.writeFileSync(
    path.join(dotM, "keys", "primary@example.com.json"),
    JSON.stringify({
      kind: "KeyFile",
      version: 1,
      pubkey: primary.pubKey,
      displayName: "Primary",
      currentEmail: "primary@example.com",
      emailHistory: [],
      metadata: {},
      introductionMandate: "00000000-0000-0000-0000-000000000000",
      signature: "x",
    }),
    "utf8",
  );
  return { rootDir: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }), primary, backup };
}

function mkMandate(
  primary: ReturnType<typeof kp>,
  over: Partial<Omit<Mandate, "signatures">> = {},
): Mandate {
  const unsigned: Omit<Mandate, "signatures"> = {
    kind: "Mandate",
    version: 1,
    mandateId: "11111111-1111-4111-8111-111111111111",
    track: "release",
    holder: primary.pubKey,
    issuedAt: ISO_GENESIS,
    expiresAt: ISO_AFTER_EXPIRY,
    successors: [primary.pubKey],
    approvalRule: { kind: "threshold", threshold: 1 },
    minSuccessors: 1,
    maxDurationSeconds: 365 * DAY,
    defaultDurationSeconds: 60 * DAY,
    signedBy: primary.pubKey,
    ...over,
  };
  return signMandate(unsigned, [{ privKey: primary.privKey }]);
}

function writeMandate(rootDir: string, m: Mandate): void {
  fs.writeFileSync(
    path.join(
      rootDir,
      ".maintainers",
      "tracks",
      m.track,
      "mandates",
      `${m.issuedAt.replace(/[:.]/g, "")}-${m.mandateId.slice(0, 8)}.json`,
    ),
    JSON.stringify(m),
    "utf8",
  );
}

function writeEndorsement(rootDir: string, e: ReleaseEndorsement): void {
  const dir = path.join(rootDir, ".maintainers", "endorsements");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${e.semverTag}.json`), JSON.stringify(e), "utf8");
}

describe("verifyMaintainersFolder (v2 verify-forward-from-pin)", () => {
  it("reports current authority when the chain is valid", () => {
    const repo = makeRepoWith(11);
    try {
      const genesis = mkMandate(repo.primary, {
        successors: [repo.primary.pubKey, repo.backup.pubKey],
      });
      writeMandate(repo.rootDir, genesis);

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
        pinnedMandateHash: mandatePinHash(genesis),
      });
      expect(status.rootPolicyPresent).toBe(true);
      const releaseTrack = status.tracks.find((t) => t.track === "release");
      expect(releaseTrack?.hasPolicy).toBe(true);
      expect(releaseTrack?.validMandates).toBe(1);
      expect(releaseTrack?.currentHolder).toBe(repo.primary.pubKey);
      expect(releaseTrack?.successors).toEqual([
        repo.primary.pubKey,
        repo.backup.pubKey,
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it("a tampered mandate breaks the pin anchor (fail-closed)", () => {
    const repo = makeRepoWith(13);
    try {
      const genesis = mkMandate(repo.primary);
      const pin = mandatePinHash(genesis); // pin of the UNtampered bytes
      // Tamper issuedAt: the on-disk mandate no longer hashes to the pin.
      const tampered: Mandate = { ...genesis, issuedAt: "2026-04-01T00:00:00.000Z" };
      writeMandate(repo.rootDir, tampered);

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
        pinnedMandateHash: pin,
      });
      const releaseTrack = status.tracks.find((t) => t.track === "release");
      expect(releaseTrack?.validMandates).toBe(0);
      expect(releaseTrack?.currentHolder).toBe(null);
      expect(releaseTrack?.rejections.some((r) => r.reason === "pin-not-in-log")).toBe(
        true,
      );
    } finally {
      repo.cleanup();
    }
  });

  it("surfaces a valid release endorsement as currentRelease", () => {
    const repo = makeRepoWith(15);
    try {
      const genesis = mkMandate(repo.primary);
      writeMandate(repo.rootDir, genesis);

      const commit = "a".repeat(40);
      const intermediates = [commit];
      const endorsement = signReleaseEndorsement(
        {
          kind: "ReleaseEndorsement",
          version: 1,
          releaseId: "33333333-3333-4333-8333-333333333333",
          semverTag: "v0.1.0",
          commitHash: commit,
          previousReleaseId: null,
          previousCommitHash: null,
          intermediateCommits: intermediates,
          intermediateMerkleRoot: intermediateMerkleRoot(intermediates),
          endorsedNotes: "first cut",
          issuedAt: ISO_NEXT,
          signedBy: repo.primary.pubKey,
        },
        [{ privKey: repo.primary.privKey }],
      );
      writeEndorsement(repo.rootDir, endorsement);

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
        pinnedMandateHash: mandatePinHash(genesis),
      });
      expect(status.validEndorsements).toHaveLength(1);
      expect(status.currentRelease?.commitHash).toBe(commit);
      expect(status.endorsementErrors).toHaveLength(0);
    } finally {
      repo.cleanup();
    }
  });

  it("returns an empty verdict when .maintainers/ is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-rv-empty-"));
    try {
      const status = verifyMaintainersFolder({ gitRepoPath: tmp });
      expect(status.rootPolicyPresent).toBe(false);
      expect(status.tracks).toEqual([]);
      expect(status.currentRelease).toBe(null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an empty pin fails closed even with a valid on-disk chain", () => {
    const repo = makeRepoWith(17);
    try {
      writeMandate(repo.rootDir, mkMandate(repo.primary));
      // An explicit empty pin ⇒ the empty-pin fail-closed invariant.
      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
        pinnedMandateHash: "",
      });
      const releaseTrack = status.tracks.find((t) => t.track === "release");
      expect(releaseTrack?.validMandates).toBe(0);
      expect(releaseTrack?.currentHolder).toBe(null);
      expect(releaseTrack?.rejections.some((r) => r.reason === "no-pin")).toBe(true);
    } finally {
      repo.cleanup();
    }
  });
});

// ----- PRE-RELEASE POSTURE: ca-track fallback (rollout-plan §2) -----------

/**
 * Build a `.maintainers/` folder whose mandates live under an arbitrary track
 * name (so we can create a `ca` track, or both `ca` and `release`, instead of
 * the `release`-only helper above). Endorsements are signed by `signer`.
 */
function makeMultiTrackRepo(): {
  rootDir: string;
  cleanup: () => void;
  ca: ReturnType<typeof kp>;
  rel: ReturnType<typeof kp>;
  stranger: ReturnType<typeof kp>;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-rv-multi-"));
  fs.mkdirSync(path.join(tmp, ".maintainers", "keys"), { recursive: true });
  return {
    rootDir: tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    ca: kp(40),
    rel: kp(60),
    stranger: kp(80),
  };
}

function mandateOnTrack(
  track: string,
  signer: ReturnType<typeof kp>,
): Mandate {
  const unsigned: Omit<Mandate, "signatures"> = {
    kind: "Mandate",
    version: 1,
    mandateId: "22222222-2222-4222-8222-222222222222",
    track,
    holder: signer.pubKey,
    issuedAt: ISO_GENESIS,
    expiresAt: ISO_AFTER_EXPIRY,
    successors: [signer.pubKey],
    approvalRule: { kind: "threshold", threshold: 1 },
    minSuccessors: 1,
    maxDurationSeconds: 365 * DAY,
    defaultDurationSeconds: 60 * DAY,
    signedBy: signer.pubKey,
  };
  return signMandate(unsigned, [{ privKey: signer.privKey }]);
}

function writeMandateOnTrack(rootDir: string, m: Mandate): void {
  const dir = path.join(rootDir, ".maintainers", "tracks", m.track, "mandates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${m.issuedAt.replace(/[:.]/g, "")}-${m.track}.json`),
    JSON.stringify(m),
    "utf8",
  );
}

function endorsedBy(
  signer: ReturnType<typeof kp>,
  commit: string,
): ReleaseEndorsement {
  const intermediates = [commit];
  return signReleaseEndorsement(
    {
      kind: "ReleaseEndorsement",
      version: 1,
      releaseId: "44444444-4444-4444-8444-444444444444",
      semverTag: "v9.9.9",
      commitHash: commit,
      previousReleaseId: null,
      previousCommitHash: null,
      intermediateCommits: intermediates,
      intermediateMerkleRoot: intermediateMerkleRoot(intermediates),
      endorsedNotes: null,
      issuedAt: ISO_NEXT,
      signedBy: signer.pubKey,
    },
    [{ privKey: signer.privKey }],
  );
}

describe("release endorsement ca-track fallback (rollout-plan §2)", () => {
  it("accepts a ca-holder-signed endorsement when only the ca track exists", () => {
    const repo = makeMultiTrackRepo();
    try {
      const caGenesis = mandateOnTrack("ca", repo.ca);
      writeMandateOnTrack(repo.rootDir, caGenesis);
      const commit = "c".repeat(40);
      writeEndorsement(repo.rootDir, endorsedBy(repo.ca, commit));

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
        pinnedMandateHash: mandatePinHash(caGenesis),
      });
      expect(status.validEndorsements).toHaveLength(1);
      expect(status.currentRelease?.commitHash).toBe(commit);
      expect(status.endorsementErrors).toHaveLength(0);
    } finally {
      repo.cleanup();
    }
  });

  it("rejects an endorsement signed by a NON-holder key (fallback is not a bypass)", () => {
    const repo = makeMultiTrackRepo();
    try {
      const caGenesis = mandateOnTrack("ca", repo.ca);
      writeMandateOnTrack(repo.rootDir, caGenesis);
      const commit = "d".repeat(40);
      // Signed by a stranger key that holds no mandate on any track.
      writeEndorsement(repo.rootDir, endorsedBy(repo.stranger, commit));

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
        pinnedMandateHash: mandatePinHash(caGenesis),
      });
      expect(status.validEndorsements).toHaveLength(0);
      expect(status.currentRelease).toBe(null);
      expect(status.endorsementErrors.length).toBeGreaterThan(0);
    } finally {
      repo.cleanup();
    }
  });

  it("PRECEDENCE: a real release track wins — a ca-only endorsement is NOT accepted when release exists", () => {
    const repo = makeMultiTrackRepo();
    try {
      // Both tracks exist; pin anchors the ca track. The release track has its
      // own (different) holder. An endorsement signed by the CA holder must be
      // rejected because the release chain — which wins — did not authorize it.
      const caGenesis = mandateOnTrack("ca", repo.ca);
      const relGenesis = mandateOnTrack("release", repo.rel);
      writeMandateOnTrack(repo.rootDir, caGenesis);
      writeMandateOnTrack(repo.rootDir, relGenesis);
      const commit = "e".repeat(40);
      writeEndorsement(repo.rootDir, endorsedBy(repo.ca, commit));

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
        // Pin the RELEASE genesis so the release track is the anchored, valid
        // chain and therefore preferred by resolveReleaseChain.
        pinnedMandateHash: mandatePinHash(relGenesis),
      });
      expect(status.validEndorsements).toHaveLength(0);
      expect(status.currentRelease).toBe(null);
    } finally {
      repo.cleanup();
    }
  });

  it("PRECEDENCE: a real release track wins — its OWN holder's endorsement is accepted even with a ca track present", () => {
    const repo = makeMultiTrackRepo();
    try {
      const caGenesis = mandateOnTrack("ca", repo.ca);
      const relGenesis = mandateOnTrack("release", repo.rel);
      writeMandateOnTrack(repo.rootDir, caGenesis);
      writeMandateOnTrack(repo.rootDir, relGenesis);
      const commit = "f".repeat(40);
      writeEndorsement(repo.rootDir, endorsedBy(repo.rel, commit));

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
        pinnedMandateHash: mandatePinHash(relGenesis),
      });
      expect(status.validEndorsements).toHaveLength(1);
      expect(status.currentRelease?.commitHash).toBe(commit);
    } finally {
      repo.cleanup();
    }
  });
});

// ----- verifyEndorsementChainAgainstGit (unchanged by v2) ----------------

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setupGitRepoWith3Commits(): {
  cwd: string;
  cleanup: () => void;
  commits: string[];
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-rv-git-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  const commits: string[] = [];
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(cwd, `f${i}.txt`), `c${i}`, "utf8");
    git(cwd, ["add", "."]);
    execFileSync(
      "git",
      ["commit", "-q", "-m", `c${i}`],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: `2026-05-0${i}T00:00:00Z`,
          GIT_COMMITTER_DATE: `2026-05-0${i}T00:00:00Z`,
        },
      },
    );
    commits.push(git(cwd, ["rev-parse", "HEAD"]).toLowerCase());
  }
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }), commits };
}

describe("verifyEndorsementChainAgainstGit", () => {
  it("accepts an endorsement whose intermediates exactly match the first-parent walk", () => {
    const repo = setupGitRepoWith3Commits();
    try {
      // Genesis endorsement covering all 3 commits up to HEAD.
      const e: ReleaseEndorsement = {
        kind: "ReleaseEndorsement",
        version: 1,
        releaseId: "00000000-0000-4000-8000-000000000001",
        semverTag: "v0.1.0",
        commitHash: repo.commits[2]!,
        previousReleaseId: null,
        previousCommitHash: null,
        intermediateCommits: repo.commits,
        intermediateMerkleRoot: intermediateMerkleRoot(repo.commits),
        endorsedNotes: null,
        issuedAt: ISO_NEXT,
        signedBy: "ab".repeat(32),
        signatures: [],
      };
      const r = verifyEndorsementChainAgainstGit(e, repo.cwd);
      expect(r.ok).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it("rejects when an intermediate is missing locally", () => {
    const repo = setupGitRepoWith3Commits();
    try {
      const fake = "f".repeat(40);
      const intermediates = [...repo.commits, fake];
      const e: ReleaseEndorsement = {
        kind: "ReleaseEndorsement",
        version: 1,
        releaseId: "00000000-0000-4000-8000-000000000002",
        semverTag: "v0.2.0",
        commitHash: repo.commits[2]!,
        previousReleaseId: null,
        previousCommitHash: null,
        intermediateCommits: intermediates,
        intermediateMerkleRoot: intermediateMerkleRoot(intermediates),
        endorsedNotes: null,
        issuedAt: ISO_NEXT,
        signedBy: "ab".repeat(32),
        signatures: [],
      };
      const r = verifyEndorsementChainAgainstGit(e, repo.cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("intermediate-missing-locally");
      }
    } finally {
      repo.cleanup();
    }
  });

  it("rejects when the intermediates list is shorter than the actual walk", () => {
    const repo = setupGitRepoWith3Commits();
    try {
      // Claim only 2 intermediates but the walk visits 3.
      const truncated = [repo.commits[0]!, repo.commits[1]!];
      const e: ReleaseEndorsement = {
        kind: "ReleaseEndorsement",
        version: 1,
        releaseId: "00000000-0000-4000-8000-000000000003",
        semverTag: "v0.3.0",
        commitHash: repo.commits[2]!,
        previousReleaseId: null,
        previousCommitHash: null,
        intermediateCommits: truncated,
        intermediateMerkleRoot: intermediateMerkleRoot(truncated),
        endorsedNotes: null,
        issuedAt: ISO_NEXT,
        signedBy: "ab".repeat(32),
        signatures: [],
      };
      const r = verifyEndorsementChainAgainstGit(e, repo.cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("intermediate-count-mismatch");
      }
    } finally {
      repo.cleanup();
    }
  });
});
