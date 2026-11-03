#!/usr/bin/env node
// i18n-literals — the gate against new hard-coded English (owner rule 2026-11-02: every user-visible string goes through
// the surface's i18n catalog). Part of `npm run i18n`.
//
//   node scripts/i18n-literals.mjs check     exit 1 when a surface holds user-facing text that is not wrapped
//   node scripts/i18n-literals.mjs list      print every unwrapped literal, allowed ones marked
//
// It asks each surface's own wrapper, in dry-run, what it WOULD wrap: the same heuristics that moved the existing text
// into the catalogs (scripts/i18n-pwa.mjs, i18n-ios.mjs [and --mac], i18n-android.mjs [app, wear], i18n-windows.mjs,
// i18n_linux.py; the voi.ci site checks its own literals in apps/voici-site/i18n.mjs). Anything those find is either
// wrapped (tr / String(localized:) / stringResource / Strings.T / tr()) and added to i18n/<surface>/, or listed in
// scripts/i18n-literals.allow.json with the reason it is not text a person reads in their language (a brand, a
// protocol token, a log line, a debug-only mock). Text the wrappers already skip (exceptions, logs, ids) never shows.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOW_FILE = path.join(ROOT, "scripts", "i18n-literals.allow.json");

export const SURFACES = [
  { name: "webapp", cmd: ["node", "scripts/i18n-pwa.mjs", "extract", "--dry", "--list"], prefix: "apps/web/public/" },
  { name: "ios", cmd: ["node", "scripts/i18n-ios.mjs", "wrap", "--dry", "--list"] },
  { name: "studio-mac", cmd: ["node", "scripts/i18n-ios.mjs", "wrap", "--dry", "--list", "--mac"] },
  { name: "android", cmd: ["node", "scripts/i18n-android.mjs", "extract", "--dry", "--list", "--module", "app"] },
  { name: "wear", cmd: ["node", "scripts/i18n-android.mjs", "extract", "--dry", "--list", "--module", "wear"] },
  { name: "studio-windows", cmd: ["node", "scripts/i18n-windows.mjs", "wrap", "--dry", "--list"] },
  { name: "studio-linux", cmd: ["python3", "scripts/i18n_linux.py", "wrap", "--dry", "--list"] },
];

/** UNWRAPPED<TAB>file<TAB>line<TAB>"text" lines -> [{ file, line, text }]. */
export function parseList(out, prefix = "") {
  return out
    .split("\n")
    .filter((l) => l.startsWith("UNWRAPPED\t"))
    .map((l) => {
      const [, file, line, text] = l.split("\t");
      return { file: prefix + file, line: Number(line), text: JSON.parse(text) };
    });
}

/**
 * The allow-list: { surface, file, text?, why }. `file` is a path relative to the repo root, or a regular expression
 * when written as /…/; `text` is the exact English (placeholders as the wrapper prints them: %@ on Apple, %s on
 * Android, {0} elsewhere) or a /…/ expression; without `text` the entry covers every literal of that file.
 */
export function readAllow(file = ALLOW_FILE) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j.allow.map((a) => ({ ...a, fileRe: toRe(a.file, true), textRe: a.text === undefined ? null : toRe(a.text, false) }));
}
function toRe(s, isPath) {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(s);
  if (m) return new RegExp(m[1], m[2]);
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(isPath ? `^${esc}$` : `^${esc}$`, "s");
}
export function allowedBy(allow, surface, hit) {
  return allow.find((a) => (!a.surface || a.surface === surface) && a.fileRe.test(hit.file) && (!a.textRe || a.textRe.test(hit.text))) ?? null;
}

function scan(s) {
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${s.cmd.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  return parseList(r.stdout, s.prefix);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2] ?? "check";
  const allow = readAllow();
  const used = new Set();
  const bad = [];
  for (const s of SURFACES) {
    for (const hit of scan(s)) {
      const a = allowedBy(allow, s.name, hit);
      if (a) used.add(a);
      if (cmd === "list") console.log(`${a ? "allowed" : "UNWRAPPED"}\t${s.name}\t${hit.file}:${hit.line}\t${JSON.stringify(hit.text)}${a ? `\t(${a.why})` : ""}`);
      else if (!a) bad.push(`${s.name}: ${hit.file}:${hit.line} ${JSON.stringify(hit.text).slice(0, 120)}`);
    }
  }
  if (cmd === "list") process.exit(0);
  const stale = allow.filter((a) => !used.has(a)).map((a) => `scripts/i18n-literals.allow.json: nothing matches ${a.surface ?? "*"} ${a.file}${a.text !== undefined ? ` ${JSON.stringify(a.text)}` : ""}: remove the entry`);
  if (bad.length || stale.length) {
    if (bad.length)
      console.error(
        `${bad.length} hard-coded user-facing string(s). Wrap each in the surface's lookup and add it (with translations) to i18n/<surface>/, ` +
          `or, if a person never reads it as text in their language (brand, protocol token, log, debug-only mock), list it in scripts/i18n-literals.allow.json with why:\n` +
          bad.map((b) => "  " + b).join("\n"),
      );
    if (stale.length) console.error(stale.join("\n"));
    process.exit(1);
  }
  console.log("i18n-literals: no hard-coded user-facing text");
}
