#!/usr/bin/env node
/**
 * Install-time helper invoked by packages/installer-apkovl/scripts/
 * flagship-bootstrap.start AFTER `validate_ref`. Refuses to run
 * `install.sh` unless the git ref the trailer pinned actually
 * resolves to a commit that has a signed ReleaseEndorsement from the
 * current release-track authority in the repo's own
 * `.maintainers/` folder.
 *
 * Usage:
 *   verify-endorsement.mjs \
 *     --git-repo-path <path-to-local-clone> \
 *     --commit-hash <40-char-hex>
 *
 * Exits 0 on success; non-zero (with a stderr message) on any
 * failure. The bootstrap script propagates the exit status.
 *
 * Why a node script instead of pure shell: the verifier needs
 * Ed25519 + SHA-256 + Merkle-root recomputation + the maintainers
 * canonical-bytes format. Re-implementing all that in busybox sh
 * would be a footgun. The bootstrap clones the Flagship repo + runs
 * `npm ci` BEFORE invoking this helper, so node + the
 * @ibisllc/maintainers library are guaranteed available.
 *
 * (A path-to-pure-shell is possible — pre-bundle a single
 * statically-linked verify binary into the apkovl, then call it
 * directly without cloning first — but is out of scope for v1
 * alpha.)
 *
 * This helper intentionally does its own .maintainers/ disk read
 * instead of importing the daemon's releaseVerifier. The bootstrap
 * runs BEFORE `tsc -b` produces the daemon's compiled output, so we
 * keep the dep surface to "@ibisllc/maintainers" + node fs only.
 *
 * **LOCKED Phase-2 v2 model.** Each track is verified FORWARD from a
 * pinned mandate (`verifyMandateChainFromPin`); the succession policy
 * is INLINE in each `Mandate` (there is no `policy.json` — the v2
 * model dissolved the unsigned-policy hole, L2); endorsements verify
 * holder-signs against the v2 release chain (`verifyChainOf
 * Endorsements`); "expired" is simply `currentAuthority === null`
 * (no holder-in-window vs after-expiry split).
 *
 * **No baked pin (the c4.5a/b/c/d preview pattern).** This helper
 * inspects an arbitrary cloned `.maintainers/` with NO compiled-in
 * `MAINTAINER_PINNED_MANDATE_HASH`, so it anchors each track at the
 * FIRST on-repo mandate's `mandatePinHash` (`safePinHash`). The v2
 * security boundary is UNCHANGED: real trust is the pin a downstream
 * consumer (the daemon's `releaseVerifier`, the webapp, iOS/Android)
 * BAKES into its signed build and walks forward from — distributing
 * the correct pin rides the existing signed-release trust. An empty
 * mandate list ⇒ `verifyMandateChainFromPin("", …)` ⇒
 * `rootError:"no-pin"` ⇒ fail-closed (the #30 invariant, generalised).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  currentAuthority,
  mandatePinHash,
  verifyChainOfEndorsements,
  verifyMandateChainFromPin,
  intermediateMerkleRoot,
} from "@ibisllc/maintainers";

function fail(reason, detail) {
  process.stderr.write(`verify-endorsement: ${reason}`);
  if (detail) process.stderr.write(`: ${detail}`);
  process.stderr.write("\n");
  process.exit(1);
}

function parseArgs() {
  const out = { gitRepoPath: "", commitHash: "" };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--git-repo-path") out.gitRepoPath = process.argv[++i] ?? "";
    else if (a === "--commit-hash") out.commitHash = process.argv[++i] ?? "";
    else fail("unknown-flag", a);
  }
  if (!out.gitRepoPath) fail("missing-flag", "--git-repo-path");
  if (!out.commitHash) fail("missing-flag", "--commit-hash");
  if (!/^[0-9a-f]{40}$/i.test(out.commitHash)) {
    fail("invalid-commit-hash", "must be a 40-char hex string");
  }
  return {
    gitRepoPath: path.resolve(out.gitRepoPath),
    commitHash: out.commitHash.toLowerCase(),
  };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function isMandate(x) {
  if (typeof x !== "object" || x === null) return false;
  return (
    x.kind === "Mandate" &&
    x.version === 1 &&
    typeof x.mandateId === "string" &&
    typeof x.track === "string" &&
    typeof x.holder === "string" &&
    typeof x.issuedAt === "string" &&
    typeof x.expiresAt === "string" &&
    Array.isArray(x.successors) &&
    typeof x.approvalRule === "object" &&
    x.approvalRule !== null &&
    typeof x.minSuccessors === "number" &&
    typeof x.maxDurationSeconds === "number" &&
    typeof x.signedBy === "string" &&
    Array.isArray(x.signatures)
  );
}

/**
 * v2 on-disk convention: `tracks/<track>/mandates/*.json`,
 * filename-sorted (the canonical-log substitute), filtered to
 * `version === 1`. No policy.json (root or per-track) — the
 * succession rule lives inline in each mandate.
 */
function readMaintainersFolder(rootDir) {
  const out = {
    rootDir,
    mandatesByTrack: new Map(),
    endorsements: [],
  };
  if (!fs.existsSync(rootDir)) return out;
  const tracksDir = path.join(rootDir, "tracks");
  if (fs.existsSync(tracksDir)) {
    for (const name of fs.readdirSync(tracksDir).sort()) {
      const trackDir = path.join(tracksDir, name);
      if (!fs.statSync(trackDir).isDirectory()) continue;
      const mandatesDir = path.join(trackDir, "mandates");
      const arr = [];
      if (fs.existsSync(mandatesDir)) {
        for (const f of fs.readdirSync(mandatesDir).sort()) {
          if (!f.endsWith(".json")) continue;
          const parsed = readJson(path.join(mandatesDir, f));
          if (isMandate(parsed)) arr.push(parsed);
        }
      }
      out.mandatesByTrack.set(name, arr);
    }
  }
  const endorsementsDir = path.join(rootDir, "endorsements");
  if (fs.existsSync(endorsementsDir)) {
    for (const f of fs.readdirSync(endorsementsDir).sort()) {
      if (!f.endsWith(".json")) continue;
      const parsed = readJson(path.join(endorsementsDir, f));
      if (parsed && parsed.kind === "ReleaseEndorsement") out.endorsements.push(parsed);
    }
    out.endorsements.sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
  }
  return out;
}

function safePinHash(m) {
  try {
    return mandatePinHash(m);
  } catch {
    // An adversarial first mandate that won't canonicalize ⇒ no anchor
    // ⇒ pin-not-in-log ⇒ fail-closed.
    return "";
  }
}

/**
 * Forward-verify a track anchored at its FIRST on-repo mandate's
 * `mandatePinHash` (the no-baked-pin preview anchor — this helper has
 * no compiled-in pin; see the header). An empty log ⇒ empty pin ⇒
 * `rootError:"no-pin"` ⇒ fail-closed.
 */
function verifyTrackChain(mandates) {
  const pin = mandates.length > 0 ? safePinHash(mandates[0]) : "";
  return verifyMandateChainFromPin(pin, mandates);
}

function verifyMaintainers(store) {
  const verifiedTracks = new Map();
  for (const [name, mandates] of store.mandatesByTrack.entries()) {
    const chain = verifyTrackChain(mandates);
    // L1 fail-closed: no anchor (empty/forked/tampered pin, malformed
    // root) ⇒ no verifiable v2 chain for this track.
    if (chain.root === null) {
      fail(
        "mandate-chain-invalid",
        `track ${name}: ${chain.rootError ?? "no-forward-chain"}`,
      );
    }
    if (chain.rejections.length > 0) {
      const first = chain.rejections[0];
      fail(
        "mandate-chain-invalid",
        `track ${name}: ${first.reason}${first.detail ? ` (${first.detail})` : ""}`,
      );
    }
    verifiedTracks.set(name, chain);
  }
  const releaseChain = verifiedTracks.get("release");
  if (!releaseChain) {
    fail("no-release-track", "mandates for `release` track missing");
  }
  if (store.endorsements.length === 0) {
    fail("no-endorsements", "`.maintainers/endorsements/` is empty");
  }
  const result = verifyChainOfEndorsements(store.endorsements, releaseChain);
  if (result.rejections.length > 0) {
    const first = result.rejections[0];
    fail(
      "endorsement-chain-invalid",
      `${first.endorsement.releaseId.slice(0, 8)}…: ${first.reason}${first.detail ? ` (${first.detail})` : ""}`,
    );
  }
  return result.validEndorsements;
}

function verifyGitChain(endorsement, gitRepoPath) {
  const runGit = (args) => execFileSync("git", ["-C", gitRepoPath, ...args], { encoding: "utf8" });
  for (const c of endorsement.intermediateCommits) {
    try {
      runGit(["cat-file", "-e", c]);
    } catch {
      fail("intermediate-missing-locally", `commit ${c} not in clone`);
    }
  }
  try {
    runGit(["cat-file", "-e", endorsement.commitHash]);
  } catch {
    fail("head-commit-missing-locally", `commitHash ${endorsement.commitHash} not in clone`);
  }
  const range = endorsement.previousCommitHash
    ? `${endorsement.previousCommitHash}..${endorsement.commitHash}`
    : endorsement.commitHash;
  let raw;
  try {
    raw = runGit(["rev-list", "--first-parent", "--reverse", range]);
  } catch (err) {
    fail("rev-list-failed", err && err.message ? err.message : String(err));
  }
  const walk = raw
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);
  if (walk.length !== endorsement.intermediateCommits.length) {
    fail(
      "intermediate-count-mismatch",
      `git walk visited ${walk.length} commits but endorsement carries ${endorsement.intermediateCommits.length}`,
    );
  }
  for (let i = 0; i < walk.length; i++) {
    if (walk[i] !== String(endorsement.intermediateCommits[i]).toLowerCase()) {
      fail(
        "intermediate-order-mismatch",
        `at index ${i}: walk has ${walk[i]} but endorsement has ${endorsement.intermediateCommits[i]}`,
      );
    }
  }
  // Recompute the Merkle root as a belt-and-suspenders check (the
  // protocol verifier already does this; we do it once more so the
  // install-time path never trusts a stripped-down build).
  const recomputed = intermediateMerkleRoot(endorsement.intermediateCommits);
  if (recomputed !== endorsement.intermediateMerkleRoot) {
    fail(
      "merkle-root-mismatch",
      `recomputed ${recomputed} != endorsement ${endorsement.intermediateMerkleRoot}`,
    );
  }
}

function main() {
  const args = parseArgs();
  if (!fs.existsSync(args.gitRepoPath)) fail("git-repo-path-missing", args.gitRepoPath);
  const rootDir = path.join(args.gitRepoPath, ".maintainers");
  if (!fs.existsSync(rootDir)) fail("no-maintainers-folder", rootDir);

  const store = readMaintainersFolder(rootDir);
  const validEndorsements = verifyMaintainers(store);

  // Confirm we still have an active authority at this moment (a
  // hostile mirror could rewrite history but not produce a fresh
  // mandate satisfying the predecessor's inline approvalRule — the v2
  // forward-walk would reject it). v2: "active" is simply
  // `currentAuthority !== null` (no holder-in-window split).
  const releaseChain = verifyTrackChain(
    store.mandatesByTrack.get("release") ?? [],
  );
  const authority = currentAuthority(releaseChain, new Date());
  if (!authority) {
    fail(
      "no-current-authority",
      "the release track has no active mandate at the current time — succession required",
    );
  }

  const match = validEndorsements.find(
    (e) => String(e.commitHash).toLowerCase() === args.commitHash,
  );
  if (!match) {
    const tips = validEndorsements
      .slice(-3)
      .map((e) => `${e.semverTag} → ${String(e.commitHash).slice(0, 12)}…`)
      .join("; ");
    fail(
      "commit-not-endorsed",
      `HEAD ${args.commitHash.slice(0, 12)}… is not endorsed; latest endorsements: ${tips}`,
    );
  }
  verifyGitChain(match, args.gitRepoPath);
  process.stdout.write(
    `verify-endorsement: OK — commit ${args.commitHash.slice(0, 12)}… endorsed as ${match.semverTag}\n`,
  );
  process.exit(0);
}

main();
