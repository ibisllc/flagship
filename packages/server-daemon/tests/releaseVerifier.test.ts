/**
 * Tests for the daemon's offline release-verifier.
 *
 * Coverage:
 *   - reads `.maintainers/` from disk and reports current authority
 *   - rejects a tampered mandate
 *   - reports current release endorsement when one is present
 *   - `verifyEndorsementChainAgainstGit` walks a real local git repo
 *     and accepts the intermediate-commit list when it matches
 *   - the same helper rejects mismatches in count or order
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  generateKeypair,
  intermediateMerkleRoot,
  signMandate,
  signReleaseEndorsement,
  type Mandate,
  type ReleaseEndorsement,
  type TrackPolicy,
} from "@maintainers/protocol";
import {
  verifyEndorsementChainAgainstGit,
  verifyMaintainersFolder,
} from "../src/releaseVerifier.js";

const ISO_GENESIS = "2026-05-01T00:00:00.000Z";
const ISO_NEXT = "2026-06-01T00:00:00.000Z";
const ISO_AFTER_EXPIRY = "2026-07-15T00:00:00.000Z";

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
  fs.writeFileSync(
    path.join(dotM, "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { name: "Flagship-test" },
      tracks: ["release"],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dotM, "tracks", "release", "policy.json"),
    JSON.stringify({
      track: "release",
      defaultMandateDuration: "60d",
      approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
    } satisfies TrackPolicy),
    "utf8",
  );
  const primary = kp(seedByte);
  const backup = kp(seedByte + 1);
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
      introductionMandate: "fixture",
      signature: "x",
    }),
    "utf8",
  );
  return { rootDir: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }), primary, backup };
}

function writeMandate(rootDir: string, m: Mandate): void {
  fs.writeFileSync(
    path.join(rootDir, ".maintainers", "tracks", m.track, "mandates", `${m.issuedAt.replace(/[:.]/g, "")}-${m.mandateId.slice(0, 8)}.json`),
    JSON.stringify(m),
    "utf8",
  );
}

function writeEndorsement(rootDir: string, e: ReleaseEndorsement): void {
  const dir = path.join(rootDir, ".maintainers", "endorsements");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${e.semverTag}.json`), JSON.stringify(e), "utf8");
}

describe("verifyMaintainersFolder", () => {
  it("reports current authority when the chain is valid", () => {
    const repo = makeRepoWith(11);
    try {
      const genesis = signMandate(
        {
          kind: "Mandate",
          version: 1,
          mandateId: "11111111-1111-4111-8111-111111111111",
          track: "release",
          holder: repo.primary.pubKey,
          issuedAt: ISO_GENESIS,
          expiresAt: ISO_AFTER_EXPIRY,
          successors: [repo.primary.pubKey, repo.backup.pubKey],
          signedBy: repo.primary.pubKey,
        },
        [{ privKey: repo.primary.privKey }],
      );
      writeMandate(repo.rootDir, genesis);

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
      });
      expect(status.rootPolicyPresent).toBe(true);
      const releaseTrack = status.tracks.find((t) => t.track === "release");
      expect(releaseTrack?.validMandates).toBe(1);
      expect(releaseTrack?.currentHolder).toBe(repo.primary.pubKey);
      expect(releaseTrack?.successors).toEqual([repo.primary.pubKey, repo.backup.pubKey]);
    } finally {
      repo.cleanup();
    }
  });

  it("rejects a tampered mandate (signature does not verify)", () => {
    const repo = makeRepoWith(13);
    try {
      const genesis = signMandate(
        {
          kind: "Mandate",
          version: 1,
          mandateId: "11111111-1111-4111-8111-111111111111",
          track: "release",
          holder: repo.primary.pubKey,
          issuedAt: ISO_GENESIS,
          expiresAt: ISO_AFTER_EXPIRY,
          successors: [repo.primary.pubKey],
          signedBy: repo.primary.pubKey,
        },
        [{ privKey: repo.primary.privKey }],
      );
      // Tamper: flip the issuedAt so the signature no longer verifies.
      const tampered: Mandate = { ...genesis, issuedAt: "2026-04-01T00:00:00.000Z" };
      writeMandate(repo.rootDir, tampered);

      const status = verifyMaintainersFolder({
        gitRepoPath: repo.rootDir,
        now: new Date(ISO_NEXT),
      });
      const releaseTrack = status.tracks.find((t) => t.track === "release");
      expect(releaseTrack?.validMandates).toBe(0);
      expect(releaseTrack?.rejections.length).toBeGreaterThan(0);
      expect(releaseTrack?.rejections[0]?.reason).toMatch(/signature-invalid|approval/);
    } finally {
      repo.cleanup();
    }
  });

  it("surfaces a valid release endorsement as currentRelease", () => {
    const repo = makeRepoWith(15);
    try {
      const genesis = signMandate(
        {
          kind: "Mandate",
          version: 1,
          mandateId: "11111111-1111-4111-8111-111111111111",
          track: "release",
          holder: repo.primary.pubKey,
          issuedAt: ISO_GENESIS,
          expiresAt: ISO_AFTER_EXPIRY,
          successors: [repo.primary.pubKey],
          signedBy: repo.primary.pubKey,
        },
        [{ privKey: repo.primary.privKey }],
      );
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
});

// ----- verifyEndorsementChainAgainstGit ----------------------------------

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
