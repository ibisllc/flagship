// Shared plumbing for the key/value localisation surfaces (android, wear, ios, watch, the three
// Studios, server messages). The website has its own pipeline (scripts/i18n-web.mjs) because its
// source of truth is HTML.
//
//   i18n/<surface>/en.json    { "<key>": { "en": "...", "ctx": "where it appears", "plural": {...}? } }
//   i18n/<surface>/<lang>.json { "<key>": "translation" | { "one": "...", "other": "..." } }
//
// A surface script owns extraction (reading the code) and emission (writing native files); this
// module owns dump / merge / status / lint, which are identical for every surface.

import crypto from "node:crypto";
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
// Markup a translation must carry over unchanged (it may move): tags with their attributes and numbered <1>…</1>.
const MARKUP = /<\/?[A-Za-z][^<>]*>|<\/?\d+\/?>/g;
export const markupOf = (s) => [...s.matchAll(MARKUP)].map((m) => m[0]).sort();
const ENTITY = /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;

const hasTerm = (str, term) =>
  new RegExp(`(?<![A-Za-z0-9\\u00C0-\\u024F])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s)?(?![A-Za-z0-9\\u00C0-\\u024F])`, "u")
    .test(str.replace(/-/g, " "));

// Placeholders with the argument each one reads: {2} -> 2, %3$s -> 2, a bare %s/%d -> its position.
function argsAt(s) {
  let n = 0;
  return [...s.matchAll(/\{(\d+)\}|%(?:(\d+)\$)?(?:l{1,2}|h{1,2})?[sdfgiuxXeEc@]/g)].map((m) => ({ at: m.index, end: m.index + m[0].length, arg: m[1] !== undefined ? Number(m[1]) : m[2] !== undefined ? Number(m[2]) - 1 : n++ }));
}
/** The argument the singular/plural change is attached to: the placeholder inside the changed words, or the one right beside them ("{0} days"). */
function countArg(one, other) {
  if (one === other) return null;
  const s = other.length >= one.length ? other : one, t = s === other ? one : other;
  let a = 0;
  while (a < t.length && s[a] === t[a]) a++;
  let q = 0;
  while (q < t.length - a && s[s.length - 1 - q] === t[t.length - 1 - q]) q++;
  let b = Math.max(a, s.length - q);
  const letter = /[\p{L}\p{M}\p{N}'’-]/u;
  while (a > 0 && letter.test(s[a - 1])) a--;
  while (b < s.length && letter.test(s[b])) b++;
  const args = argsAt(s);
  const inside = [...new Set(args.filter((x) => x.at < b && x.end > a).map((x) => x.arg))];
  if (inside.length) return inside.length === 1 ? inside[0] : null;
  const beside = [...new Set(args.filter((x) => (x.end <= a && /^[\s(（«“"]*$/.test(s.slice(x.end, a))) || (x.at >= b && /^[\s)）»”":：,]*$/.test(s.slice(b, x.at)))).map((x) => x.arg))];
  return beside.length === 1 ? beside[0] : null;
}
/** A plural pair whose translation changes its wording next to a different argument than the English: the count was swapped with another value. */
export function pluralArgProblem(enOne, enOther, trOne, trOther) {
  const want = countArg(enOne, enOther), got = countArg(trOne, trOther);
  return want !== null && got !== null && want !== got ? `the count is {${want}} in English but the translation changes its wording next to {${got}}` : null;
}

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
    const ma = markupOf(e).join(" "), mb = markupOf(t).join(" ");
    if (ma !== mb) out.push(`${code}: ${key}: markup differs (en "${ma}" / "${mb}"): ${t}`);
    // English with no entity is shown as plain text, where "&amp;" would appear literally
    if (!ENTITY.test(e) && ENTITY.test(t)) out.push(`${code}: ${key}: HTML entity in plain text: ${t}`);
    for (const k of glossary.keep) if (hasTerm(e, k) && !hasTerm(t, k)) out.push(`${code}: ${key}: drops "${k}": ${t}`);
    if (/^\s|\s$/.test(e) !== /^\s|\s$/.test(t) && e.trim() === e) out.push(`${code}: ${key}: stray edge whitespace`);
    if (e.length >= 3 && e.length <= 24 && t.length > e.length * 3 + 6) out.push(`${code}: ${key}: much longer than English (${e.length} -> ${t.length}): ${t}`);
  }
  if (typeof forms.one === "string" && typeof forms.other === "string" && typeof enForms.one === "string" && typeof enForms.other === "string") {
    const p = pluralArgProblem(enForms.one, enForms.other, forms.one, forms.other);
    if (p) out.push(`${code}: ${key}: ${p}`);
  }
  return out;
}

// Surfaces keyed by the English sentence (webapp, iOS, box …) notice an English edit by themselves: the old key is gone.
// Surfaces keyed by a resource name (Android, Wear, Windows Studio, Info.plist) would keep the old translations of a
// changed sentence, so i18n/<surface>/translated-from.json records which English each key was translated from.
const SOURCES = "translated-from.json";
export const enHash = (v) => crypto.createHash("sha256").update(JSON.stringify(v.en)).digest("hex").slice(0, 12);
const keyedByName = (en) => Object.entries(en).some(([k, v]) => typeof v.en !== "string" || v.en !== k);
export function readSources(surface) {
  const f = path.join(surfaceDir(surface), SOURCES);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
export function writeSources(surface, sources) {
  const sorted = Object.fromEntries(Object.keys(readEn(surface)).filter((k) => sources[k]).map((k) => [k, sources[k]]));
  fs.writeFileSync(path.join(surfaceDir(surface), SOURCES), JSON.stringify(sorted, null, 2) + "\n");
}
/** Record that the current English of `keys` (all translated keys when omitted) is what the translations say. */
export function acceptEnglish(surface, keys) {
  const en = readEn(surface);
  const sources = readSources(surface) ?? {};
  const trs = targets.map((l) => readTr(surface, l.code));
  for (const k of keys ?? Object.keys(en)) if (en[k] && trs.some((t) => t[k] != null)) sources[k] = enHash(en[k]);
  writeSources(surface, sources);
}

/** Translations of an English sentence that changed after they were written (name-keyed surfaces only). */
export function staleSources(surface) {
  const en = readEn(surface);
  if (!keyedByName(en)) return [];
  const sources = readSources(surface);
  if (!sources) return [`i18n/${surface}/${SOURCES} is missing: run the surface's \`accept --all\` once`];
  const trs = targets.map((l) => readTr(surface, l.code));
  return Object.entries(en)
    .filter(([k, v]) => v.translatable !== false && trs.some((t) => t[k] != null) && sources[k] !== enHash(v))
    .map(([k]) => `${k}: the English changed after it was translated; translate it again in every language, then \`accept ${k}\``);
}

export function lintSurface(surface, { onlyKeys } = {}) {
  const en = readEn(surface);
  const problems = onlyKeys ? [] : staleSources(surface);
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
  const batch = {};
  todo.slice(from, from + n).forEach(([k, v], i) => {
    const text = typeof v.en === "string" ? v.en : JSON.stringify(v.en);
    batch[i + 1] = k;
    console.log(`${i + 1}\t${(v.ctx ?? "").replace(/^apps\//, "").replace(/ \(.*\)$/, "")}\t${text.replace(/\n/g, "\\n")}`);
  });
  fs.writeFileSync(`/tmp/i18n-batch-${surface}.json`, JSON.stringify(batch));
}

/** midx <surface> <file>: [[n, es, fr, de, pt-BR, ja, zh-Hans], ...] where n is the number dump printed. Plural entries: a language cell may be {one, other}. */
export function midx(surface, file) {
  const batch = JSON.parse(fs.readFileSync(`/tmp/i18n-batch-${surface}.json`, "utf8"));
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const order = targets.map((l) => l.code);
  const incoming = {};
  for (const row of rows) {
    const key = batch[row[0]];
    if (key === undefined) { console.error(`row ${row[0]} is not in the batch`); process.exitCode = 1; continue; }
    incoming[key] = Object.fromEntries(order.map((code, i) => [code, row[i + 1]]).filter(([, t]) => t != null && t !== ""));
  }
  const tmp = `/tmp/i18n-midx-${surface}.json`;
  fs.writeFileSync(tmp, JSON.stringify(incoming));
  merge(surface, tmp);
  const missing = Object.keys(batch).filter((n) => !rows.some((r) => String(r[0]) === n));
  if (missing.length) console.error(`not translated in this file: ${missing.join(", ")}`);
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
  if (keyedByName(en)) acceptEnglish(surface, [...touched]);
  console.log(`merged ${n} translations into ${surface}`);
  const problems = lintSurface(surface, { onlyKeys: touched });
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
}

export function runCommon(surface, argv) {
  const [cmd, a, b] = argv;
  if (cmd === "dump") { dump(surface, Number(a || 0), Number(b || 80)); return true; }
  if (cmd === "merge") { merge(surface, a); return true; }
  if (cmd === "midx") { midx(surface, a); return true; }
  if (cmd === "status") { console.log(statusLines(surface).join("\n")); return true; }
  if (cmd === "accept") {
    const keys = argv.slice(1).filter((k, i, all) => k === "--all" || (!k.startsWith("--") && !(all[i - 1]?.startsWith("--") && all[i - 1] !== "--all")));
    if (!keys.length) { console.error("accept <key…> | accept --all   (after translating the key's new English in every language)"); process.exit(2); }
    acceptEnglish(surface, keys[0] === "--all" ? undefined : keys);
    console.log(`${surface}: recorded the English of ${keys[0] === "--all" ? "every translated key" : keys.join(", ")}`);
    return true;
  }
  if (cmd === "lint") {
    const p = lintSurface(surface);
    if (p.length) { console.error(p.join("\n") + `\n\n${p.length} problem(s)`); process.exit(1); }
    console.log(`${surface}: lint ok`);
    return true;
  }
  return false;
}

// ---- reuse across surfaces ---------------------------------------------------------------------------

const REUSE_TOKEN = /%(?:(\d+)\$)?(?:l{1,2}|h{1,2})?[sdfgiuxXeEc@]|\{(\d+)\}/g;
const reuseTokens = (s) => [...s.matchAll(REUSE_TOKEN)].map((m) => ({ text: m[0], index: m[1] ? Number(m[1]) - 1 : m[2] !== undefined ? Number(m[2]) : null }));

/**
 * A donor surface's translation rewritten in the target surface's placeholder style (scripts/i18n-reuse.mjs).
 * Both English sentences are the same once placeholders are ignored, so the n-th placeholder of the donor English
 * and the n-th of the target English are the same value; each placeholder of the donor translation becomes the
 * target's placeholder for that value, with the target's own argument number. null when it cannot be mapped.
 */
export function convertPlaceholders(donorEn, donorTr, targetEn) {
  const dEn = reuseTokens(donorEn), tEn = reuseTokens(targetEn);
  if (dEn.length !== tEn.length || reuseTokens(donorTr).length !== dEn.length) return null;
  const order = dEn.map((t, i) => t.index ?? i); // the argument read by the donor English's n-th placeholder
  const used = [];
  let i = 0;
  const out = donorTr.replace(REUSE_TOKEN, (m, p1, p2) => {
    const idx = p1 ? Number(p1) - 1 : p2 !== undefined ? Number(p2) : i;
    i++;
    const pos = order.indexOf(idx);
    used.push(pos < 0 ? null : pos);
    return pos < 0 ? m : tEn[pos].text;
  });
  if (used.includes(null)) return null;
  // `%@`/`%lld` are order-bound: only reusable when the donor kept the argument order
  const bare = tEn.every((t) => !/%\d+\$|^\{/.test(t.text));
  if (bare && used.some((u, k) => u !== k)) return null;
  return out;
}
