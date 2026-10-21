// Shared plumbing for the key/value localisation surfaces (android, wear, ios, watch, the three
// Studios, server messages). The website has its own pipeline (scripts/i18n-web.mjs) because its
// source of truth is HTML.
//
//   i18n/<surface>/en.json    { "<key>": { "en": "...", "ctx": "where it appears", "plural": {...}? } }
//   i18n/<surface>/<lang>.json { "<key>": "translation" | { "one": "...", "other": "..." } }
//
// A surface script owns extraction (reading the code) and emission (writing native files); this
// module owns dump / merge / status / lint, which are identical for every surface.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const locales = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/locales.json"), "utf8"));
export const glossary = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n/glossary.json"), "utf8"));
export const targets = locales.locales.filter((l) => l.code !== locales.source);

export const surfaceDir = (surface) => path.join(ROOT, "i18n", surface);

export function readEn(surface) {
  const f = path.join(surfaceDir(surface), "en.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

export function writeEn(surface, entries) {
  fs.mkdirSync(surfaceDir(surface), { recursive: true });
  fs.writeFileSync(path.join(surfaceDir(surface), "en.json"), JSON.stringify(entries, null, 2) + "\n");
}

export function readTr(surface, code) {
  const f = path.join(surfaceDir(surface), `${code}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

export function writeTr(surface, code, tr, order) {
  const keys = order ?? Object.keys(tr);
  const sorted = Object.fromEntries(keys.filter((k) => tr[k] != null).map((k) => [k, tr[k]]));
  fs.writeFileSync(path.join(surfaceDir(surface), `${code}.json`), JSON.stringify(sorted, null, 2) + "\n");
}

// printf-style (%s %1$s %d %lld %@ %f), brace-style ({0}, {name}) and Kotlin-style ($name) tokens.
const TOKEN = /%(?:\d+\$)?(?:l{1,2}|h{1,2})?[sdfgiuxXeEc@]|\{\d+\}|\{[A-Za-z_]\w*\}/g;
export const tokensOf = (s) => [...s.matchAll(TOKEN)].map((m) => m[0].replace(/^%\d+\$/, "%")).sort();

const hasTerm = (str, term) =>
  new RegExp(`(?<![A-Za-z0-9\\u00C0-\\u024F])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s)?(?![A-Za-z0-9\\u00C0-\\u024F])`, "u")
    .test(str.replace(/-/g, " ")) || str.includes(term);

/** Problems with one translation of one entry (empty list when fine). */
export function lintEntry(key, en, text, code) {
  const out = [];
  const forms = typeof text === "string" ? { _: text } : text;
  const enForms = typeof en.en === "string" ? { _: en.en } : en.en;
  for (const [form, t] of Object.entries(forms)) {
    const e = enForms[form] ?? enForms.other ?? Object.values(enForms)[0];
    if (typeof t !== "string" || t.trim() === "") { out.push(`${code}: ${key}: empty ${form}`); continue; }
    const a = tokensOf(e).join(" "), b = tokensOf(t).join(" ");
    if (a !== b) out.push(`${code}: ${key}: placeholders differ (en "${a}" / "${b}"): ${t}`);
    for (const k of glossary.keep) if (hasTerm(e, k) && !hasTerm(t, k)) out.push(`${code}: ${key}: drops "${k}": ${t}`);
    if (/^\s|\s$/.test(e) !== /^\s|\s$/.test(t) && e.trim() === e) out.push(`${code}: ${key}: stray edge whitespace`);
    if (e.length >= 3 && e.length <= 24 && t.length > e.length * 3 + 6) out.push(`${code}: ${key}: much longer than English (${e.length} -> ${t.length}): ${t}`);
  }
  return out;
}

export function lintSurface(surface, { onlyKeys } = {}) {
  const en = readEn(surface);
  const problems = [];
  for (const loc of targets) {
    const tr = readTr(surface, loc.code);
    for (const [k, t] of Object.entries(tr)) {
      if (onlyKeys && !onlyKeys.has(k)) continue;
      if (!en[k]) { problems.push(`${loc.code}: ${k} is not in en.json (stale)`); continue; }
      problems.push(...lintEntry(k, en[k], t, loc.code));
    }
  }
  return problems;
}

const translatable = (v) => v.translatable !== false;

export function statusLines(surface) {
  const en = Object.fromEntries(Object.entries(readEn(surface)).filter(([, v]) => translatable(v)));
  const total = Object.keys(en).length;
  return targets.map((l) => {
    const tr = readTr(surface, l.code);
    const have = Object.keys(en).filter((k) => tr[k] != null).length;
    return `${surface.padEnd(14)} ${l.code.padEnd(8)} ${have}/${total} (${l.status})`;
  });
}

/** dump <surface> [from] [count]: entries some language still lacks, as key<TAB>ctx<TAB>english. */
export function dump(surface, from = 0, n = 80) {
  const en = readEn(surface);
  const trs = targets.map((l) => readTr(surface, l.code));
  const todo = Object.entries(en).filter(([k, v]) => translatable(v) && trs.some((t) => t[k] == null));
  console.error(`${todo.length} entries of ${surface} still need at least one language`);
  for (const [k, v] of todo.slice(from, from + n)) {
    const text = typeof v.en === "string" ? v.en : JSON.stringify(v.en);
    console.log(`${k}\t${v.ctx ?? ""}\t${text.replace(/\n/g, "\\n")}`);
  }
}

/** merge <surface> <file>: { "<key>": { "es": "...", "pt-BR": "..." } } into i18n/<surface>/<lang>.json. */
export function merge(surface, file) {
  const incoming = JSON.parse(fs.readFileSync(file, "utf8"));
  const en = readEn(surface);
  const order = Object.keys(en);
  const known = new Set(targets.map((l) => l.code));
  const by = {};
  let n = 0;
  const touched = new Set();
  for (const [k, per] of Object.entries(incoming)) {
    if (!en[k]) { console.error(`unknown key ${k}`); continue; }
    touched.add(k);
    for (const [code, text] of Object.entries(per)) {
      if (!known.has(code)) { console.error(`unknown language ${code}`); continue; }
      (by[code] ??= readTr(surface, code))[k] = text;
      n++;
    }
  }
  for (const [code, tr] of Object.entries(by)) writeTr(surface, code, tr, order);
  console.log(`merged ${n} translations into ${surface}`);
  const problems = lintSurface(surface, { onlyKeys: touched });
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
}

export function runCommon(surface, argv) {
  const [cmd, a, b] = argv;
  if (cmd === "dump") { dump(surface, Number(a || 0), Number(b || 80)); return true; }
  if (cmd === "merge") { merge(surface, a); return true; }
  if (cmd === "status") { console.log(statusLines(surface).join("\n")); return true; }
  if (cmd === "lint") {
    const p = lintSurface(surface);
    if (p.length) { console.error(p.join("\n") + `\n\n${p.length} problem(s)`); process.exit(1); }
    console.log(`${surface}: lint ok`);
    return true;
  }
  return false;
}
