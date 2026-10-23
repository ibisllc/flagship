#!/usr/bin/env node
// The gym's box release (SEC-INSTALL-001): every bootstrap installs a signed box artifact for one exact
// commit named by release/box-release.json, so the gym needs an artifact for ITS commit, signed with
// the gym's own key (release/box-artifact-trust.json on the gym branch). This holds the decisions;
// scripts/gym-box-artifact.sh does the building, signing, uploading and committing.
//
//   node scripts/gym-box-release.mjs plan   --worktree <gym worktree> [--base-url <url>]
//   node scripts/gym-box-release.mjs write  --worktree <gym worktree> --commit <sha> --sequence <n> --base-url <url>
//
// `plan` prints JSON: { action: "skip" | "build", commit, sequence, reason }. It skips when
// box-release.json already names the commit the artifact would be built from.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GYM_ARTIFACT_BASE = "https://gym.flagshipserver.com/build/iso";

/** Anti-rollback sequence that grows with time: a minute-resolution UTC stamp, as an integer. */
export function sequenceFor(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return Number(`${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`);
}

/**
 * What to do for a gym branch. `head` is the branch tip, `parent` its parent, `changedByHead` the files the tip
 * changed, `current` the parsed box-release.json at the tip. The release commit the gym writes changes only
 * release files, so a tip like that, naming its own parent, is already current.
 */
export function plan({ head, parent, changedByHead, current, now = new Date() }) {
  const releaseOnly = changedByHead.length > 0 && changedByHead.every((f) => f.startsWith("release/") || /boxReleaseConfig\.ts$/.test(f) || /BoxRelease\.(swift|kt)$/.test(f) || f.endsWith("lib/boxRelease.js") || /boxInstallerScripts\.ts$/.test(f));
  if (releaseOnly && current.commit === parent) return { action: "skip", commit: current.commit, sequence: current.sequence, reason: "the gym's tip is its own release commit and names its parent" };
  if (current.commit === head) return { action: "skip", commit: head, sequence: current.sequence, reason: "box-release.json already names the tip" };
  const seq = Math.max(sequenceFor(now), (current.sequence ?? 0) + 1);
  return { action: "build", commit: head, sequence: seq, reason: "the artifact for the tip has not been built" };
}

function git(wt, ...args) {
  return execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
}

export function planForWorktree(wt, now = new Date()) {
  const head = git(wt, "rev-parse", "HEAD");
  const parent = git(wt, "rev-parse", "HEAD~1");
  const changedByHead = git(wt, "diff", "--name-only", "HEAD~1", "HEAD").split("\n").filter(Boolean);
  const current = JSON.parse(readFileSync(join(wt, "release/box-release.json"), "utf8"));
  return plan({ head, parent, changedByHead, current, now });
}

export function writeRelease(wt, { commit, sequence, baseUrl = GYM_ARTIFACT_BASE }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be 40 lowercase hex");
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("sequence must be a positive integer");
  const path = join(wt, "release/box-release.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.commit = commit;
  doc.sequence = sequence;
  doc.artifactBase = baseUrl.replace(/\/+$/, "");
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

function arg(name, argv) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && /gym-box-release\.mjs$/.test(process.argv[1])) {
  const [cmd, ...rest] = process.argv.slice(2);
  const wt = arg("worktree", rest);
  if (!wt) {
    console.error("usage: gym-box-release.mjs plan|write --worktree <dir> [--commit sha --sequence n --base-url url]");
    process.exit(2);
  }
  if (cmd === "plan") console.log(JSON.stringify(planForWorktree(wt)));
  else if (cmd === "write") {
    const out = writeRelease(wt, { commit: arg("commit", rest), sequence: Number(arg("sequence", rest)), baseUrl: arg("base-url", rest) });
    console.log(JSON.stringify(out));
  } else {
    console.error(`unknown command ${cmd}`);
    process.exit(2);
  }
}
