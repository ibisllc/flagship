/**
 * Tests for the install-time endorsement-verification gate.
 *
 * Two things are covered here:
 *
 *  1. The verify-endorsement.mjs helper itself, against
 *     hand-constructed `.maintainers/` trees + small synthetic git
 *     repos:
 *       - clean chain + matching commit → exits 0
 *       - missing `.maintainers/` → exits non-zero
 *       - commit hash not endorsed → exits non-zero
 *       - tampered mandate (signature broken) → exits non-zero
 *       - tampered intermediate-merkle-root → exits non-zero
 *       - mismatched intermediate-commits (extra commit) → exits non-zero
 *
 *  2. The bootstrap script is structurally wired so that:
 *       - the verification step lives BETWEEN validate_ref and the
 *         curl-and-execute of install.sh
 *       - the script will exit if the verifier exits non-zero
 *
 *  Tests (1) actually spawn node on the helper; tests (2) parse the
 *  shell source. We don't try to run busybox sh end-to-end here —
 *  bootstrapRefValidation.test.ts already shows the pattern for that.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateKeypair,
  intermediateMerkleRoot,
  signMandate,
  signReleaseEndorsement,
  type Mandate,
  type ReleaseEndorsement,
} from "@ibisllc/maintainers";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HELPER = path.join(REPO_ROOT, "scripts", "verify-endorsement.mjs");
const BOOTSTRAP_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "flagship-bootstrap.start",
);

function kp(seedByte: number) {
  const b = new Uint8Array(32);
  b[0] = seedByte;
  return generateKeypair(b);
}

interface Fixture {
  cwd: string;
  cleanup: () => void;
  commits: string[];
  primary: ReturnType<typeof kp>;
  endorsement: ReleaseEndorsement;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setupFixture(opts: { seedByte: number }): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-verify-"));
  // Init a tiny git repo.
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  const commits: string[] = [];
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(cwd, `f${i}.txt`), `c${i}`, "utf8");
    git(cwd, ["add", "."]);
    execFileSync("git", ["commit", "-q", "-m", `c${i}`], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `2026-05-0${i}T00:00:00Z`,
        GIT_COMMITTER_DATE: `2026-05-0${i}T00:00:00Z`,
      },
    });
    commits.push(git(cwd, ["rev-parse", "HEAD"]).toLowerCase());
  }

  const primary = kp(opts.seedByte);

  // Write .maintainers/ with a valid root v2 mandate + one
  // endorsement covering all three commits. **LOCKED Phase-2 v2
  // model**: NO policy.json (root or per-track) — the succession rule
  // is folded INLINE into the self-signed root Mandate; the helper
  // anchors the track FORWARD from this mandate's `mandatePinHash`.
  const dotM = path.join(cwd, ".maintainers");
  fs.mkdirSync(path.join(dotM, "tracks", "release", "mandates"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dotM, "endorsements"), { recursive: true });

  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const mandate: Mandate = signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: "11111111-1111-4111-8111-111111111111",
      track: "release",
      holder: primary.pubKey,
      issuedAt,
      expiresAt,
      successors: [primary.pubKey],
      approvalRule: { kind: "threshold", threshold: 1 },
      minSuccessors: 1,
      maxDurationSeconds: 365 * 24 * 60 * 60,
      defaultDurationSeconds: 60 * 24 * 60 * 60,
      project: { name: "Flagship-test", tracks: ["release"] },
      signedBy: primary.pubKey,
    },
    [{ privKey: primary.privKey }],
  );
  fs.writeFileSync(
    path.join(dotM, "tracks", "release", "mandates", "genesis.json"),
    JSON.stringify(mandate),
    "utf8",
  );

  const endorsement = signReleaseEndorsement(
    {
      kind: "ReleaseEndorsement",
      version: 1,
      releaseId: "22222222-2222-4222-8222-222222222222",
      semverTag: "v0.1.0",
      commitHash: commits[2]!,
      previousReleaseId: null,
      previousCommitHash: null,
      intermediateCommits: commits,
      intermediateMerkleRoot: intermediateMerkleRoot(commits),
      endorsedNotes: null,
      issuedAt: new Date().toISOString(),
      signedBy: primary.pubKey,
    },
    [{ privKey: primary.privKey }],
  );
  fs.writeFileSync(
    path.join(dotM, "endorsements", "v0.1.0.json"),
    JSON.stringify(endorsement),
    "utf8",
  );

  return {
    cwd,
    cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
    commits,
    primary,
    endorsement,
  };
}

function runHelper(opts: { cwd: string; commitHash: string }): {
  code: number;
  stdout: string;
  stderr: string;
} {
  // Use the same `node --import tsx` invocation the bootstrap uses.
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      HELPER,
      "--git-repo-path",
      opts.cwd,
      "--commit-hash",
      opts.commitHash,
    ],
    { encoding: "utf8" },
  );
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("verify-endorsement.mjs helper", () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = setupFixture({ seedByte: 17 });
  });
  afterAll(() => {
    fx.cleanup();
  });

  it("exits 0 when the HEAD commit is endorsed by a valid mandate chain", () => {
    const r = runHelper({ cwd: fx.cwd, commitHash: fx.commits[2]! });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/verify-endorsement: OK/);
  });

  it("exits non-zero when --git-repo-path has no .maintainers/", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-no-m-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: empty });
      const r = runHelper({ cwd: empty, commitHash: "0".repeat(40) });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/no-maintainers-folder/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("exits non-zero when the supplied commit is not endorsed", () => {
    const wrong = "0".repeat(40);
    const r = runHelper({ cwd: fx.cwd, commitHash: wrong });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/commit-not-endorsed|head-commit-missing/);
  });

  it("rejects a malformed --commit-hash", () => {
    const r = runHelper({ cwd: fx.cwd, commitHash: "not-hex" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid-commit-hash/);
  });

  it("rejects a tampered mandate (signature no longer verifies)", () => {
    const tampered = setupFixture({ seedByte: 19 });
    try {
      const mandatePath = path.join(
        tampered.cwd,
        ".maintainers",
        "tracks",
        "release",
        "mandates",
        "genesis.json",
      );
      const m = JSON.parse(fs.readFileSync(mandatePath, "utf8")) as Mandate;
      m.issuedAt = "2020-01-01T00:00:00.000Z";
      fs.writeFileSync(mandatePath, JSON.stringify(m), "utf8");

      // v2: the helper anchors the track at the FIRST mandate's
      // `mandatePinHash`, recomputed over the (tampered) bytes — so the
      // pin still matches the file, but the root's Ed25519 signature
      // (made over the ORIGINAL canonical bytes) no longer verifies ⇒
      // `root-signature-invalid` ⇒ chain.root === null ⇒ a hard
      // fail-closed (`mandate-chain-invalid`). Same surfacing as the
      // c4.5d cli self-correction.
      const r = runHelper({ cwd: tampered.cwd, commitHash: tampered.commits[2]! });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/mandate-chain-invalid/);
    } finally {
      tampered.cleanup();
    }
  });

  it("rejects an endorsement whose intermediates don't match git history", () => {
    const fx2 = setupFixture({ seedByte: 21 });
    try {
      const ePath = path.join(
        fx2.cwd,
        ".maintainers",
        "endorsements",
        "v0.1.0.json",
      );
      const e = JSON.parse(fs.readFileSync(ePath, "utf8")) as ReleaseEndorsement;
      // Add a fake intermediate that's not in the local git history.
      e.intermediateCommits = [...e.intermediateCommits, "f".repeat(40)];
      // Recompute the Merkle root so the signature path can't catch it
      // first — we want the git-walk to be what trips.
      e.intermediateMerkleRoot = intermediateMerkleRoot(e.intermediateCommits);
      // Re-sign with the primary key.
      const signed = signReleaseEndorsement(
        {
          kind: e.kind,
          version: e.version,
          releaseId: e.releaseId,
          semverTag: e.semverTag,
          commitHash: e.commitHash,
          previousReleaseId: e.previousReleaseId,
          previousCommitHash: e.previousCommitHash,
          intermediateCommits: e.intermediateCommits,
          intermediateMerkleRoot: e.intermediateMerkleRoot,
          endorsedNotes: e.endorsedNotes,
          issuedAt: e.issuedAt,
          signedBy: e.signedBy,
        },
        [{ privKey: fx2.primary.privKey }],
      );
      fs.writeFileSync(ePath, JSON.stringify(signed), "utf8");

      const r = runHelper({ cwd: fx2.cwd, commitHash: fx2.commits[2]! });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/intermediate-missing-locally|intermediate-count-mismatch/);
    } finally {
      fx2.cleanup();
    }
  });
});

describe("flagship-bootstrap.start wires the endorsement gate in the right place", () => {
  const source = fs.readFileSync(BOOTSTRAP_PATH, "utf8");

  it("calls validate_ref BEFORE the verification gate", () => {
    const validateIdx = source.lastIndexOf("validate_ref \"$REF\" \"installerGitRef\"");
    // Use the EXEC line, not the doc comment about verify-endorsement.
    // The exec line is the `node --import tsx scripts/verify-endorsement.mjs`
    // invocation; documentation references appear earlier in the file
    // and would cause indexOf() to falsely report verify "before"
    // validate.
    const verifyIdx = source.indexOf("node --import tsx scripts/verify-endorsement.mjs");
    expect(validateIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeGreaterThan(validateIdx);
  });

  it("calls the verification gate BEFORE curl-ing install.sh", () => {
    const verifyIdx = source.indexOf("verify-endorsement.mjs");
    const curlIdx = source.indexOf("curl -fsSL \"$INSTALLER_URL\"");
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(curlIdx).toBeGreaterThan(verifyIdx);
  });

  it("aborts the bootstrap if the verifier fails", () => {
    // The relevant block must have a conditional + exit 1 between
    // the verifier invocation and the install.sh fetch.
    const block = source.slice(
      source.indexOf("verify-endorsement.mjs"),
      source.indexOf("INSTALLER_URL"),
    );
    expect(block).toMatch(/exit 1/);
    expect(block).toMatch(/refusing to install/);
  });

  it("documents why we shell out to node (path-to-pure-shell)", () => {
    expect(source).toMatch(/path-to-pure-shell|statically-linked/);
  });
});
