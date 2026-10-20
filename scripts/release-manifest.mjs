#!/usr/bin/env node
/**
 * release-manifest: the facts a release rests on, in one place, and which of the owner's hardware
 * and production receipts a later change has made stale (docs/runbooks/release-readiness.md).
 *
 *   npm run release-manifest                       status: every receipt ok / STALE / MISSING, and the checks
 *   npm run release-manifest -- receipt <id> [note...]   record that <id> was done at the current commit
 *   npm run release-manifest -- manifest [--out f] the facts as JSON (commit, versions, lease, schema, receipts)
 *   npm run release-manifest -- --json             status as JSON
 *
 * A receipt is {id, commit, at, note} in release/receipts.json. release/freeze-map.json lists, per
 * receipt, the files whose change invalidates it. Exit 1 when a required receipt is missing or stale,
 * or a check fails. Nothing here deploys, signs or spends.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LEASE_HORIZON_DAYS = 14;

/** A glob (** any depth, * within one name) as a RegExp over repo-relative paths. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matches = (paths, file) => paths.some((g) => globToRegExp(g).test(file));

/** Per receipt: ok, STALE (with the files that changed since), or MISSING. */
export function evaluate(map, receipts, changedSince) {
  const out = [];
  for (const [id, spec] of Object.entries(map.receipts)) {
    const mine = receipts.filter((r) => r.id === id).sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!mine) {
      out.push({ id, label: spec.label, optional: !!spec.optional, state: "MISSING", changed: [] });
      continue;
    }
    const changed = changedSince(mine.commit).filter((f) => matches(spec.paths, f));
    out.push({ id, label: spec.label, optional: !!spec.optional, state: changed.length ? "STALE" : "ok", commit: mine.commit, at: mine.at, note: mine.note ?? "", changed });
  }
  return out;
}

function git(args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
  } catch {
    return fallback;
  }
}

/** Checks that come from files in the tree (nothing is fetched). */
/**
 * The commit that stopped the USB/ISO installer from burning a public LUKS passphrase into an
 * install (docs/luks-burn-passphrase-removal.md). Anything published from before it still writes
 * installs that a string from the public repo opens.
 */
export const LUKS_FIX_COMMIT = "09efc52a5";

/**
 * Each published Studio and VM appliance against that fix. `built` is [{what, commit}] (a commit or
 * tag); `isAncestor(fix, commit)` says whether the build contains the fix; a build that cannot be
 * placed counts as not containing it.
 */
export function publishedBuildCheck(built, isAncestor) {
  const old = built.filter((b) => !b.commit || !isAncestor(LUKS_FIX_COMMIT, b.commit)).map((b) => b.what);
  return {
    id: "published-builds",
    ok: old.length === 0,
    detail: old.length ? `built before the LUKS passphrase fix (${LUKS_FIX_COMMIT}): ${old.join(", ")}; republish them` : `${built.length} published build(s) all contain the LUKS passphrase fix`,
  };
}

function publishedBuilds() {
  const out = [];
  const dmg = (() => {
    try {
      return git(["log", "-1", "--format=%H", "--", "apps/web/public/downloads/FlagshipStudio.dmg"]) || null;
    } catch {
      return null;
    }
  })();
  out.push({ what: "Mac Studio (the DMG on the site)", commit: dmg });
  const route = existsSync(join(ROOT, "apps/com/src/route.ts")) ? readFileSync(join(ROOT, "apps/com/src/route.ts"), "utf8") : "";
  for (const tag of new Set([...route.matchAll(/releases\/download\/(studio-v[0-9.]+)\//g)].map((m) => m[1]))) out.push({ what: `Windows/Linux Studio ${tag}`, commit: tag });
  for (const arch of ["amd64", "arm64"]) {
    const m = readJson(`apps/web/public/downloads/FlagshipVMAppliance-${arch}.json`, null);
    if (m) out.push({ what: `${arch} VM appliance`, commit: m.commit ?? null });
  }
  return out;
}

export function checks(now = new Date()) {
  const out = [];
  const lease = readJson(".maintainers/ca-endorsements/bundle.json", []);
  const newest = Array.isArray(lease) ? lease.map((l) => l.notAfter).sort().at(-1) : undefined;
  if (!newest) out.push({ id: "ca-lease", ok: false, detail: "no CA lease found in .maintainers/ca-endorsements/bundle.json" });
  else {
    const days = Math.floor((new Date(newest).getTime() - now.getTime()) / 86_400_000);
    out.push({ id: "ca-lease", ok: days >= LEASE_HORIZON_DAYS, detail: `newest lease ends ${newest.slice(0, 10)} (${days} days; needs ${LEASE_HORIZON_DAYS}+)` });
  }
  const migs = existsSync(join(ROOT, "packages/storage/migrations")) ? execFileSync("ls", [join(ROOT, "packages/storage/migrations")], { encoding: "utf8" }).split("\n").filter((f) => /^\d{4}_.*\.sql$/.test(f)) : [];
  const head = migs.sort().at(-1)?.slice(0, 4);
  const known = readFileSync(join(ROOT, "packages/control-plane/src/schemaStatus.ts"), "utf8");
  out.push({ id: "schema-ledger", ok: !!head && known.includes(`"${head}"`), detail: `newest migration ${head}; the control plane's ledger ${known.includes(`"${head}"`) ? "knows it" : "does not know it"}` });
  const v = readJson("release/version.json", null);
  out.push({ id: "versions", ok: !!v, detail: v ? `product ${v.product} ${v.label}, iOS ${v.iosVersion} (${v.iosBuild}), Android code ${v.androidVersionCode}, Studio ${v.studio}` : "release/version.json missing" });
  const isAncestor = (a, b) => {
    try {
      execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  out.push(publishedBuildCheck(publishedBuilds(), isAncestor));
  return out;
}

export function facts(receipts) {
  let endorsed = null;
  try {
    endorsed = execFileSync("node", [join(ROOT, "scripts/latest-endorsed-release.mjs")], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    // needs `npx tsc -b`; the manifest says null rather than guess
  }
  return {
    generatedAt: new Date().toISOString(),
    commit: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain"]).split("\n").filter((l) => l && !l.startsWith("??")).length > 0,
    endorsedBoxCommit: endorsed,
    version: readJson("release/version.json", null),
    checks: checks(),
    receipts,
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const map = readJson("release/freeze-map.json", { receipts: {} });
  const receipts = readJson("release/receipts.json", []);
  if (args[0] === "receipt") {
    const [, id, ...note] = args;
    if (!id || !map.receipts[id]) {
      console.error(`unknown receipt ${JSON.stringify(id)}; known: ${Object.keys(map.receipts).join(", ")}`);
      process.exit(1);
    }
    receipts.push({ id, commit: git(["rev-parse", "HEAD"]), at: new Date().toISOString(), note: note.join(" ") });
    writeFileSync(join(ROOT, "release/receipts.json"), JSON.stringify(receipts, null, 2) + "\n");
    console.log(`recorded ${id} at ${receipts.at(-1).commit.slice(0, 9)}. Commit release/receipts.json.`);
    return;
  }
  if (args[0] === "manifest") {
    const f = JSON.stringify(facts(receipts), null, 2);
    const i = args.indexOf("--out");
    if (i >= 0) writeFileSync(args[i + 1], f + "\n");
    else console.log(f);
    return;
  }
  const changedSince = (commit) => {
    try {
      return git(["diff", "--name-only", `${commit}..HEAD`]).split("\n").filter(Boolean);
    } catch {
      return ["(receipt commit unknown to this checkout)"];
    }
  };
  const rows = evaluate(map, receipts, changedSince);
  const cs = checks();
  const bad = rows.filter((r) => !r.optional && r.state !== "ok").length + cs.filter((c) => !c.ok).length;
  if (json) console.log(JSON.stringify({ rows, checks: cs, ok: bad === 0 }, null, 2));
  else {
    console.log("Receipts");
    for (const r of rows) {
      console.log(`  ${r.state.padEnd(7)} ${r.id.padEnd(30)} ${r.label}${r.optional ? " (only if switched on)" : ""}`);
      if (r.state === "STALE") console.log(`           changed since ${r.commit.slice(0, 9)}: ${r.changed.slice(0, 4).join(", ")}${r.changed.length > 4 ? ` and ${r.changed.length - 4} more` : ""}`);
    }
    console.log("\nChecks");
    for (const c of cs) console.log(`  ${c.ok ? "ok     " : "FAILED "} ${c.id.padEnd(14)} ${c.detail}`);
    console.log(bad === 0 ? "\nReady." : `\n${bad} thing(s) block the release.`);
  }
  process.exitCode = bad === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
