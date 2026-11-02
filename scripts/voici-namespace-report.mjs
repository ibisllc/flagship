#!/usr/bin/env node
// voici-namespace-report — read-only, before the 0.3 deploy (docs/voici-and-messages.md §4.1, decision D2).
// From this release `voi.ci/<username>` shares one namespace with custom link names and codes: a name's key is
// lowercase with hyphens removed (voiciNamespaceKey). This lists every existing collision so the owner can decide
// each one before the routing change ships. Expected: none (custom names are new in 0.3, codes are random).
//
//   node scripts/voici-namespace-report.mjs                    reads prod D1 (flagship-state) with wrangler, read-only
//   node scripts/voici-namespace-report.mjs --gym              the gym D1 (flagship-state-gym, wrangler.gym.toml)
//   node scripts/voici-namespace-report.mjs --from <file.json> {usernames:[…], names:[{key,state,username}],
//                                                              codes:[{code,retired}]} (offline, tests)
//   --json                                                     the collisions as JSON
//
// It only runs SELECTs. Exit 0 with no collisions, 3 with some, 1 on error.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { voiciNamespaceKey } from "@flagship/protocol";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const QUERIES = {
  usernames: "SELECT username FROM usernames",
  names: "SELECT key, state, username FROM voici_names",
  codes: "SELECT code, retired_at FROM voici_links",
};

function d1(sql, gym) {
  const args = ["wrangler", "d1", "execute", gym ? "flagship-state-gym" : "flagship-state", ...(gym ? ["--config", "wrangler.gym.toml"] : []), "--remote", "--json", "--command", sql];
  const r = spawnSync("npx", args, { cwd: path.join(REPO, "apps", "com"), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`wrangler d1 execute failed (wrangler login?): ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  const out = JSON.parse(r.stdout);
  return (Array.isArray(out) ? out[0] : out).results ?? [];
}

export function load(gym) {
  return {
    usernames: d1(QUERIES.usernames, gym).map((r) => r.username),
    names: d1(QUERIES.names, gym).map((r) => ({ key: r.key, state: r.state, username: r.username })),
    codes: d1(QUERIES.codes, gym).map((r) => ({ code: r.code, retired: r.retired_at !== null && r.retired_at !== undefined })),
  };
}

/** Every username whose key equals a custom name's key or a code's key. */
export function collisions(data) {
  const byKey = new Map();
  for (const u of data.usernames) byKey.set(voiciNamespaceKey(u), u);
  const found = [];
  for (const n of data.names) {
    const u = byKey.get(voiciNamespaceKey(n.key));
    if (u) found.push({ username: u, with: "custom name", name: n.key, state: n.state, nameOwner: n.username, sameAccount: n.username === u });
  }
  for (const c of data.codes) {
    const u = byKey.get(voiciNamespaceKey(c.code));
    if (u) found.push({ username: u, with: "code", name: c.code, state: c.retired ? "retired" : "live" });
  }
  return found.sort((a, b) => a.username.localeCompare(b.username));
}

export function format(found, counts) {
  const lines = [`Checked ${counts.usernames} usernames against ${counts.names} custom names and ${counts.codes} codes.`];
  if (found.length === 0) return [...lines, "No collisions: voi.ci/<username> can ship as is."];
  lines.push(`${found.length} collision(s). Decide each (D2) before the deploy:`);
  for (const f of found) {
    lines.push(
      `  voi.ci/${f.username}  vs ${f.with} "${f.name}" (${f.state}${f.with === "custom name" ? `, set by ${f.sameAccount ? "the same account" : `account ${f.nameOwner}`}` : ""})`,
    );
  }
  lines.push("A live name or code keeps answering first (§4.1 step 1): that account's page would be hidden behind it.");
  return lines;
}

function main() {
  const argv = process.argv.slice(2);
  const fromIdx = argv.indexOf("--from");
  const data = fromIdx >= 0 ? JSON.parse(fs.readFileSync(argv[fromIdx + 1], "utf8")) : load(argv.includes("--gym"));
  const found = collisions(data);
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(found, null, 2) + "\n");
  else process.stdout.write(format(found, { usernames: data.usernames.length, names: data.names.length, codes: data.codes.length }).join("\n") + "\n");
  return found.length ? 3 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}
