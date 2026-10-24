#!/usr/bin/env node
// endorse-release — mint a maintainer ReleaseEndorsement for a target commit so
// a running box will accept an "Update this server" order to it.
//
// PRE-RELEASE POSTURE (docs/update-server-rollout-plan.md §2): endorsements ride
// the `ca` track (the single YubiKey holder also endorses releases) until a
// dedicated release track exists. The daemon gate prefers a real `release` track
// and falls back to `ca`, so this script defaults `--track ca`.
//
// It is a thin, SAFE wrapper around the `maintainers` CLI `endorsement` verb:
//   * it computes the endorsement's git lineage the way the BOX will re-walk it
//     (genesis ⇒ the full first-parent history to the target; subsequent ⇒ only
//     the delta since the previous endorsement) so the on-box lineage check
//     (verifyEndorsementChainAgainstGit) cannot reject a correctly-formed
//     endorsement;
//   * it PREVIEWS everything (target, from, genesis?, #intermediates, merkle
//     root, the signing key's bound pubkey vs the current ca holder) with NO
//     signature and NO write — a real dry-run the `endorsement` verb lacks;
//   * only with --sign does it invoke the real CLI (YubiKey tap) and stage the
//     written endorsement.
//   * once a release PQ key exists (docs/runbooks/pq-release-key.md) it also
//     signs the hybrid companion, flagship/release-endorsement/v2: the ML-DSA-65
//     seed is decrypted with a YubiKey (PIN + touch), the YubiKey signs the
//     Ed25519 half, and the result goes to .maintainers/release-pq/endorsements/.
//     Once RELEASE_PQ_PIN names the key, boxes refuse a release without it.
//
// Usage:
//   node scripts/endorse-release.mjs --to <ref|sha> [--from <ref|sha>] \
//        [--tag vX.Y.Z] [--signing-key <src>] [--track ca] [--path .maintainers] \
//        [--sign] [--no-pq] [--key-file <f>] [--identity <stubs>]
//   node scripts/endorse-release.mjs --pq-only <releaseId|file> [--signing-key <src>] [--sign]
//
//   --to          target commit to endorse (default: HEAD). Resolved to a full
//                 40-hex sha.
//   --from        the box's CURRENT commit, for a sanity check that the target
//                 descends from it (does NOT change a genesis endorsement's
//                 bytes; informational there). Read it from the box's
//                 server-detail `currentCommit`.
//   --tag         semver tag stamped on the endorsement (default: derived from
//                 the target date, e.g. v0.0.0-2026-07-24-e1384d66).
//   --signing-key CLI key source. Default: yubikey-piv:slot=9c (the ca holder's
//                 YubiKey). For a NON-production dummy-box drill use
//                 file:/path/to/holder-privkey.hex.
//   --track       maintainers track (default: ca).
//   --path        maintainers folder (default: .maintainers).
//   --sign        actually sign (YubiKey tap / file key) and write. Omit for a
//                 dry-run preview.
//   --no-pq       skip the PQ companion (refused once RELEASE_PQ_PIN is set).
//   --pq-only     sign only the PQ companion for an endorsement already
//                 committed (e.g. the last classical-only release).
//   --key-file    the YubiKey-encrypted ML-DSA seed (default
//                 ~/.flagship-release/pq-release-key.age).
//   --identity    age-plugin-yubikey identity stubs (default
//                 ~/.flagship-release/yubikey-identities.txt).
//   --fake-yubikey <dir>  TEST MODE (see pq-release-key.mjs).
//
// Exit codes: 0 ok, 1 error, 2 usage.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { intermediateMerkleRoot } from "@ibisllc/maintainers";
import { releasePqPinConfigured } from "@flagship/protocol";
import {
  DEFAULT_KEY_FILE,
  loadEd25519Signer,
  loadMaintainersCli,
  readBindings,
  signReleaseCompanion,
  vaultFromFlags,
} from "./pq-release-key.mjs";

const CLI_DIR =
  process.env.FLAGSHIP_MAINTAINERS_DIR ?? new URL("../maintainers", import.meta.url).pathname;
const CLI = path.join(CLI_DIR, "packages", "cli", "bin", "maintainers");

// loadSignerBoundPubKey lives in the CLI (a private workspace pkg whose `main`
// is TS source); its built dist is loaded on demand so --pq-only and the tests
// run without it.
async function loadSignerBoundPubKey(source) {
  if (source.startsWith("file:")) return (await loadEd25519Signer(source)).pubHex;
  const lib = await loadMaintainersCli();
  if (!lib) throw new Error("maintainers CLI not found (set FLAGSHIP_MAINTAINERS_DIR to its clone, built)");
  return lib.keysource.loadSignerBoundPubKey(source);
}

function parseArgs(argv) {
  const out = { sign: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sign") out.sign = true;
    else if (a === "--no-pq") out.noPq = true;
    else if (a === "--pq-only") out.pqOnly = argv[++i];
    else if (a === "--key-file") out.keyFile = argv[++i];
    else if (a === "--identity") (out.identities ??= []).push(argv[++i]);
    else if (a === "--fake-yubikey") out.fakeYubikey = path.resolve(argv[++i]);
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--tag") out.tag = argv[++i];
    else if (a === "--signing-key") out.signingKey = argv[++i];
    else if (a === "--track") out.track = argv[++i];
    else if (a === "--path") out.path = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function resolveSha(ref) {
  let sha;
  try {
    sha = git(["rev-parse", "--verify", `${ref}^{commit}`]).toLowerCase();
  } catch {
    fail(`cannot resolve "${ref}" to a commit`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`"${ref}" did not resolve to a 40-hex sha (got ${sha})`);
  return sha;
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

/** Newest valid endorsement already committed, or null (⇒ this is genesis). */
function latestEndorsement(rootDir) {
  const dir = path.join(rootDir, "endorsements");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  let newest = null;
  for (const f of files) {
    let e;
    try {
      e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (e && e.kind === "ReleaseEndorsement" && typeof e.commitHash === "string") {
      if (!newest || Date.parse(e.issuedAt) >= Date.parse(newest.issuedAt)) newest = e;
    }
  }
  return newest;
}

function firstParentList(range) {
  const raw = git(["rev-list", "--first-parent", "--reverse", range]);
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n");
    process.stdout.write(src.slice(1, src.findIndex((l, i) => i > 2 && !l.startsWith("//"))).join("\n") + "\n");
    return 0;
  }

  const rootDir = args.path ?? ".maintainers";
  const track = args.track ?? "ca";
  const signingKey = args.signingKey ?? "yubikey-piv:slot=9c";
  const pq = pqPlan(args, rootDir);
  if (pq.error) fail(pq.error);
  if (args.pqOnly) return pqOnly(args, rootDir, signingKey);
  const target = resolveSha(args.to ?? "HEAD");
  const from = args.from ? resolveSha(args.from) : null;

  const prev = latestEndorsement(rootDir);
  const isGenesis = prev === null;

  // Compute intermediates the way the BOX re-walks them:
  //   genesis   ⇒ full first-parent history up to the target (range = <target>)
  //   otherwise ⇒ only the delta since the previous endorsement's commit.
  let intermediates;
  if (isGenesis) {
    intermediates = firstParentList(target);
  } else {
    const prevCommit = prev.commitHash.toLowerCase();
    if (prevCommit === target) fail(`target ${target.slice(0, 12)} is already the latest endorsed commit`);
    intermediates = firstParentList(`${prevCommit}..${target}`);
    if (intermediates.length === 0) {
      fail(
        `no first-parent commits between the previous endorsement (${prevCommit.slice(0, 12)}) ` +
          `and target ${target.slice(0, 12)} — is the target an ancestor, or not on the same line?`,
      );
    }
  }
  const merkle = intermediateMerkleRoot(intermediates);

  // Sanity: is `from` (the box's current commit) an ancestor of the target?
  let fromReachable = null;
  if (from) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", from, target]);
      fromReachable = true;
    } catch {
      fromReachable = false;
    }
  }

  // The signing key's bound pubkey WITHOUT a tap/sign (public read), so the
  // preview can flag a wrong key before the human taps.
  let boundPub = null;
  let boundPubErr = null;
  try {
    boundPub = (await loadSignerBoundPubKey(signingKey)).toLowerCase();
  } catch (e) {
    boundPubErr = e instanceof Error ? e.message : String(e);
  }

  // The current ca-track holder, for a match check.
  let holder = null;
  try {
    const status = execFileSync("node", [CLI, "status", "--path", rootDir], { encoding: "utf8" });
    const m = status.match(new RegExp(`track: ${track}[\\s\\S]*?current holder:\\s*([0-9a-f]{64})`));
    if (m) holder = m[1].toLowerCase();
  } catch {
    /* status is advisory */
  }

  const tag =
    args.tag ??
    `v0.0.0-${new Date().toISOString().slice(0, 10)}-${target.slice(0, 8)}`;

  // ---- preview ----------------------------------------------------------
  process.stdout.write("\n=== endorse-release preview ===\n");
  process.stdout.write(`  track:            ${track}\n`);
  process.stdout.write(`  target commit:    ${target}\n`);
  process.stdout.write(`  from (box):       ${from ?? "(not supplied)"}\n`);
  if (from) {
    process.stdout.write(
      `  from→target:      ${fromReachable ? "OK (target descends from the box's commit)" : "⚠️  target is NOT a descendant of the box commit — the box may reject the order"}\n`,
    );
  }
  process.stdout.write(`  endorsement kind: ${isGenesis ? "GENESIS (first endorsement — covers full history)" : `chains from ${prev.commitHash.slice(0, 12)} (release ${prev.releaseId})`}\n`);
  process.stdout.write(`  intermediates:    ${intermediates.length} commit(s)\n`);
  process.stdout.write(`  merkle root:      ${merkle}\n`);
  process.stdout.write(`  semver tag:       ${tag}\n`);
  process.stdout.write(`  signing key:      ${signingKey}\n`);
  process.stdout.write(`  signer pubkey:    ${boundPub ?? `(could not read: ${boundPubErr})`}\n`);
  process.stdout.write(`  PQ companion:     ${pq.describe}\n`);
  if (holder) {
    const match = boundPub && boundPub === holder;
    process.stdout.write(
      `  ca holder:        ${holder} ${boundPub ? (match ? "✓ matches signing key" : "⚠️  DOES NOT MATCH — this key is not the current authority; the endorsement will be rejected") : ""}\n`,
    );
  }
  process.stdout.write("\n");

  if (!args.sign) {
    process.stdout.write("DRY RUN — nothing signed, nothing written. Re-run with --sign to mint it.\n\n");
    return 0;
  }

  if (boundPub && holder && boundPub !== holder) {
    fail("signing key is not the current ca-track holder — refusing to mint an endorsement that will be rejected. Override the check by fixing --signing-key.");
  }

  // ---- real signed run --------------------------------------------------
  // Genesis needs the full intermediate list; hand it to the CLI via a temp
  // file (its `auto` mode would only cover the head commit). Non-genesis uses
  // `auto` with the previous commit, which computes the identical delta.
  const cliArgs = [
    CLI,
    "endorsement",
    "--commit",
    target,
    "--tag",
    tag,
    "--track",
    track,
    "--path",
    rootDir,
    "--signing-key",
    signingKey,
  ];
  let tmpFile = null;
  if (isGenesis) {
    tmpFile = path.join(os.tmpdir(), `flagship-endorse-intermediates-${process.pid}.txt`);
    fs.writeFileSync(tmpFile, intermediates.join("\n") + "\n", "utf8");
    cliArgs.push("--intermediates", `file:${tmpFile}`);
  } else {
    cliArgs.push(
      "--previous-id",
      prev.releaseId,
      "--previous-commit",
      prev.commitHash.toLowerCase(),
      "--intermediates",
      "auto",
    );
  }

  process.stdout.write("Invoking the maintainers CLI — approve the signature on your token when prompted…\n\n");
  try {
    execFileSync("node", cliArgs, { stdio: "inherit" });
  } catch (e) {
    fail(`endorsement signing failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (tmpFile) {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  if (pq.sign) {
    const written = latestEndorsement(rootDir);
    if (!written || written.commitHash.toLowerCase() !== target) {
      fail("the maintainers CLI did not leave an endorsement for the target; no PQ companion signed");
    }
    try {
      await writeCompanion(args, rootDir, signingKey, written);
    } catch (e) {
      fail(
        `the v1 endorsement was written but the PQ companion failed: ${e instanceof Error ? e.message : String(e)}. ` +
          `Fix it and run: node scripts/endorse-release.mjs --pq-only ${written.releaseId} --sign`,
      );
    }
  }

  // Stage the freshly-written endorsement so the operator only has to commit.
  try {
    execFileSync("git", ["add", path.join(rootDir, "endorsements")], { stdio: "inherit" });
    if (pq.sign) execFileSync("git", ["add", path.join(rootDir, "release-pq", "endorsements")], { stdio: "inherit" });
  } catch {
    /* the operator can add it manually */
  }
  process.stdout.write(
    `\nDone. Review + commit the new endorsement under ${rootDir}/endorsements/, then push so the box can fetch it.\n`,
  );
  return 0;
}

/** Whether this run signs the PQ companion, and why. */
function pqPlan(args, rootDir) {
  const pinned = releasePqPinConfigured();
  const bound = readBindings(rootDir).length > 0;
  if (args.noPq) {
    if (pinned) return { error: "--no-pq: RELEASE_PQ_PIN names a release key, so boxes would refuse a release without the PQ companion" };
    return { sign: false, describe: "skipped (--no-pq)" };
  }
  if (pinned && !bound) return { error: `RELEASE_PQ_PIN is set but ${rootDir}/release-pq/bindings/ holds no binding` };
  if (pinned) return { sign: true, describe: "REQUIRED (the pin names the release key); signed after the v1 endorsement" };
  if (bound) return { sign: true, describe: "signed (a release-key binding exists; the pin is not set yet, so boxes don't need it)" };
  return { sign: false, describe: "none (no release PQ key yet: docs/runbooks/pq-release-key.md)" };
}

async function writeCompanion(args, rootDir, signingKey, endorsement) {
  const { file, keyId } = await signReleaseCompanion({
    root: rootDir,
    endorsement,
    signingKey,
    vault: vaultFromFlags(args),
    keyFile: path.resolve(args.keyFile ?? DEFAULT_KEY_FILE),
    out: (s) => process.stdout.write(s + "\n"),
  });
  process.stdout.write(`PQ companion (key ${keyId.slice(0, 16)}) written to ${file}\n`);
  return file;
}

async function pqOnly(args, rootDir, signingKey) {
  let e = null;
  if (fs.existsSync(args.pqOnly) && fs.statSync(args.pqOnly).isFile()) e = JSON.parse(fs.readFileSync(args.pqOnly, "utf8"));
  else {
    const dir = path.join(rootDir, "endorsements");
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith(".json")) continue;
      try {
        const x = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (x?.releaseId === args.pqOnly) e = x;
      } catch {
        /* skip */
      }
    }
  }
  if (!e || e.kind !== "ReleaseEndorsement") fail(`no ReleaseEndorsement "${args.pqOnly}"`);
  process.stdout.write(`\n=== endorse-release --pq-only ===\n  release:  ${e.semverTag} (${e.releaseId})\n  commit:   ${e.commitHash}\n  signedBy: ${e.signedBy}\n\n`);
  if (!args.sign) {
    process.stdout.write("DRY RUN: nothing signed, nothing written. Re-run with --sign.\n\n");
    return 0;
  }
  await writeCompanion(args, rootDir, signingKey, e);
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  },
);
