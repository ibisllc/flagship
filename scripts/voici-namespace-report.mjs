#!/usr/bin/env node
// voici-namespace-report — the read-only checks to run before migration 0127 (docs/voici-namespace-spec.md,
// Migration steps 1 to 3). It only runs SELECTs, and never renames anything: it lists what the owner must decide.
//
//   1. every existing username against the format (D12: 3 to 63 of a-z 0-9 -, no leading, trailing or double hyphen)
//   2. safety-key duplicates (lower case, hyphens removed, 0 read as o, 1 as l) among usernames, custom link names and
//      codes: of two rows with one key the migration gives the registry row to the older claim (usernames first, then
//      codes, then link names) and the other keeps working without one
//   3. reserved words (packages/control-plane/src/reservedNames.json) whose key an existing row already holds: that
//      row keeps it, and the migration leaves the word out
//
//   node scripts/voici-namespace-report.mjs                    prod D1 (flagship-state) with wrangler, read-only
//   node scripts/voici-namespace-report.mjs --gym              the gym D1 (flagship-state-gym, wrangler.gym.toml)
//   node scripts/voici-namespace-report.mjs --from <file.json> {usernames:[{username,claimedAt}], names:[{display,state,username}],
//                                                              codes:[{code,username,retired}]} (offline, tests)
//   --json                                                     the findings as JSON
//
// Exit 0 when nothing needs deciding, 3 when something does, 1 on error.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { voiciNameKey, voiciNameProblem } from "@flagship/protocol";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESERVED = JSON.parse(fs.readFileSync(path.join(REPO, "packages/control-plane/src/reservedNames.json"), "utf8")).words;

const QUERIES = {
  usernames: "SELECT username, claimed_at FROM usernames ORDER BY claimed_at, username",
  names: "SELECT display, state, username, set_at FROM voici_names ORDER BY set_at, display",
  codes: "SELECT code, username, retired_at, created_at FROM voici_links ORDER BY created_at, code",
};

function d1(sql, gym) {
  const args = ["wrangler", "d1", "execute", gym ? "flagship-state-gym" : "flagship-state", ...(gym ? ["--config", "wrangler.gym.toml"] : []), "--remote", "--json", "--command", sql];
  const r = spawnSync("npx", args, { cwd: path.join(REPO, "apps", "com"), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    const out = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
    const missing = /no such (table|column)/.test(out) ? " (no such table or column)" : "";
    throw new Error(`wrangler d1 execute failed (wrangler login?)${missing}: ${out.trim().split("\n").slice(-3).join(" ")}`);
  }
  const out = JSON.parse(r.stdout);
  return (Array.isArray(out) ? out[0] : out).results ?? [];
}

/** A table or column that does not exist yet (prod before 0111) reads as empty. */
function d1OrEmpty(sql, gym) {
  try {
    return d1(sql, gym);
  } catch (e) {
    if (/no such table|no such column/.test(e.message)) return [];
    throw e;
  }
}

export function load(gym) {
  return {
    usernames: d1(QUERIES.usernames, gym).map((r) => ({ username: r.username, claimedAt: r.claimed_at })),
    names: d1OrEmpty(QUERIES.names, gym).map((r) => ({ display: r.display, state: r.state, username: r.username })),
    codes: d1OrEmpty(QUERIES.codes, gym).map((r) => ({ code: r.code, username: r.username, retired: r.retired_at !== null && r.retired_at !== undefined })),
  };
}

/** The three checks, in the migration's order (usernames by claim time, then codes, then link names, then reserved). */
export function report(data, reserved = RESERVED) {
  const invalid = data.usernames
    .filter((u) => voiciNameProblem(u.username) !== null || u.username !== u.username.toLowerCase())
    .map((u) => ({ username: u.username, problem: voiciNameProblem(u.username) ?? "upper-case" }));
  const rows = [
    ...data.usernames.map((u) => ({ kind: "username", name: u.username, owner: u.username })),
    ...data.codes.map((c) => ({ kind: "code", name: c.code, owner: c.username, retired: c.retired })),
    ...data.names.map((n) => ({ kind: "link", name: n.display, owner: n.username, retired: n.state !== "live" })),
  ];
  const holder = new Map();
  const duplicates = [];
  for (const r of rows) {
    const k = voiciNameKey(r.name);
    const first = holder.get(k);
    if (first) duplicates.push({ key: k, keeps: first, without: r });
    else holder.set(k, r);
  }
  const reservedHeld = [];
  for (const w of reserved) {
    const h = holder.get(voiciNameKey(w));
    if (h) reservedHeld.push({ word: w, heldBy: h });
  }
  return {
    counts: { usernames: data.usernames.length, codes: data.codes.length, linkNames: data.names.length, reserved: reserved.length },
    invalid,
    duplicates,
    reservedHeld,
  };
}

export function format(r) {
  const lines = [`Checked ${r.counts.usernames} usernames, ${r.counts.codes} codes and ${r.counts.linkNames} custom link names against ${r.counts.reserved} reserved words.`];
  const what = (x) => `${x.kind} ${x.name}${x.owner && x.owner !== x.name ? ` (account ${x.owner})` : ""}${x.retired ? ", retired" : ""}`;
  lines.push(r.invalid.length ? `1. ${r.invalid.length} username(s) fail the format (never renamed; decide each):` : "1. Every username meets the format.");
  for (const i of r.invalid) lines.push(`     ${i.username}: ${i.problem}`);
  lines.push(
    r.duplicates.length
      ? `2. ${r.duplicates.length} safety-key duplicate(s): the first keeps the registry row, the second keeps working without one:`
      : "2. No safety-key duplicates.",
  );
  for (const d of r.duplicates) lines.push(`     ${d.key}: ${what(d.keeps)} keeps it; ${what(d.without)} does not`);
  lines.push(
    r.reservedHeld.length
      ? `3. ${r.reservedHeld.length} reserved word(s) already held (the holder keeps it, the word is left out):`
      : "3. No reserved word is held by an existing name.",
  );
  for (const h of r.reservedHeld) lines.push(`     ${h.word}: ${what(h.heldBy)}`);
  return lines;
}

function main() {
  const argv = process.argv.slice(2);
  const fromIdx = argv.indexOf("--from");
  const data = fromIdx >= 0 ? JSON.parse(fs.readFileSync(argv[fromIdx + 1], "utf8")) : load(argv.includes("--gym"));
  const r = report(data);
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  else process.stdout.write(format(r).join("\n") + "\n");
  return r.invalid.length || r.duplicates.length || r.reservedHeld.length ? 3 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}
