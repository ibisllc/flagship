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
//
// Usage:
//   node scripts/endorse-release.mjs --to <ref|sha> [--from <ref|sha>] \
//        [--tag vX.Y.Z] [--signing-key <src>] [--track ca] [--path .maintainers] \
//        [--sign]
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
//
// Exit codes: 0 ok, 1 error, 2 usage.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { intermediateMerkleRoot } from "@ibisllc/maintainers";
// loadSignerBoundPubKey lives in the CLI (a private workspace pkg whose `main`
// is TS source); import its built dist directly so plain node can load it.
const { loadSignerBoundPubKey } = await import(
  new URL("../maintainers/packages/cli/dist/lib/keysource.js", import.meta.url).pathname
);

const CLI = new URL(
  "../maintainers/packages/cli/bin/maintainers",
  import.meta.url,
).pathname;

function parseArgs(argv) {
  const out = { sign: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sign") out.sign = true;
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
    process.stdout.write(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 46).join("\n") + "\n");
    return 0;
  }

  const rootDir = args.path ?? ".maintainers";
  const track = args.track ?? "ca";
  const signingKey = args.signingKey ?? "yubikey-piv:slot=9c";
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

  // Stage the freshly-written endorsement so the operator only has to commit.
  try {
    execFileSync("git", ["add", path.join(rootDir, "endorsements")], { stdio: "inherit" });
  } catch {
    /* the operator can add it manually */
  }
  process.stdout.write(
    `\nDone. Review + commit the new endorsement under ${rootDir}/endorsements/, then push so the box can fetch it.\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  },
);
