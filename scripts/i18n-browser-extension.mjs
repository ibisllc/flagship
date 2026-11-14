#!/usr/bin/env node
// i18n-browser-extension — the text of the Firefox extension (apps/browser-extension-firefox).
//
//   node scripts/i18n-browser-extension.mjs build   write apps/browser-extension-firefox/_locales/<lang>/messages.json (ga languages)
//   node scripts/i18n-browser-extension.mjs check   fail on a key the code uses that en.json lacks (or the reverse), untranslated
//                                                   text in the HTML, placeholder/glossary problems, a ga language missing
//                                                   strings, or stale _locales files
//   node scripts/i18n-browser-extension.mjs dump | merge | midx | status | lint | accept     (shared, see scripts/lib/i18n-kv.mjs)
//
// Keys are resource names (`pairTitle`), as Firefox's browser.i18n wants, so i18n/browser-extension/translated-from.json
// records the English each translation was made from. English placeholders are {0}, {1}; the build writes Firefox's $1, $2.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, locales, readEn, readTr, lintSurface, runCommon } from "./lib/i18n-kv.mjs";

const SURFACE = "browser-extension";
const EXT = path.join(ROOT, "apps/browser-extension-firefox");
const OUT = path.join(EXT, "_locales");
const KEY_PREFIX = /^(?:ext|badge|blocked|knock|pair|popup)[A-Z]\w*$/;

/** Firefox's locale folder for a language: the gettext form (pt_BR, zh_CN) Firefox matches against the UI locale. */
export const folderOf = (l) => (l.code === locales.source ? l.code : l.gettextId ?? l.code.replace("-", "_"));

const ga = () => locales.locales.filter((l) => l.status === "ga");

/** One message in Firefox's form: a literal $ doubled, {n} as $n+1. */
export function toFirefoxMessage(text) {
  return text.replace(/\$/g, "$$$$").replace(/\{(\d+)\}/g, (_, n) => `$${Number(n) + 1}`);
}

export function messagesFor(code) {
  const en = readEn(SURFACE);
  const tr = code === locales.source ? null : readTr(SURFACE, code);
  const out = {};
  for (const [k, v] of Object.entries(en)) {
    const text = tr ? tr[k] : v.en;
    if (typeof text !== "string" || !text) continue;
    out[k] = { message: toFirefoxMessage(text), ...(code === locales.source && v.ctx ? { description: v.ctx } : {}) };
  }
  return JSON.stringify(out, null, 2) + "\n";
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "_locales" || d.name === "node_modules" || d.name === "tests" || d.name === "web-ext-artifacts" ? [] : walk(p);
    return /\.(?:js|html|json)$/.test(d.name) ? [p] : [];
  });
}

/** Keys the extension asks for, and HTML text that bypasses the catalog. */
export function harvest() {
  const used = new Map();
  const literals = [];
  const note = (k, f) => { if (!used.has(k)) used.set(k, path.relative(ROOT, f)); };
  for (const file of walk(EXT)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/__MSG_(\w+)__/g)) note(m[1], file);
    if (file.endsWith(".html")) {
      for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="(\w+)"/g)) note(m[1], file);
      const body = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, "").replace(/<!--[\s\S]*?-->/g, "");
      for (const m of body.matchAll(/>([^<>]*[A-Za-z][^<>]*)</g)) literals.push(`${path.relative(ROOT, file)}: untranslated text "${m[1].trim().slice(0, 60)}"`);
    }
    if (file.endsWith(".js")) {
      for (const m of text.matchAll(/["']([A-Za-z]\w*)["']/g)) if (KEY_PREFIX.test(m[1])) note(m[1], file);
    }
  }
  return { used, literals };
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const args = main ? process.argv.slice(2) : [];
const cmd = args[0];

if (!main) {
  // imported by tests
} else if (cmd === "build") {
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const l of ga()) {
    fs.mkdirSync(path.join(OUT, folderOf(l)), { recursive: true });
    fs.writeFileSync(path.join(OUT, folderOf(l), "messages.json"), messagesFor(l.code));
  }
  console.log(`browser-extension: ${ga().length} language(s) in _locales`);
} else if (cmd === "check") {
  const en = readEn(SURFACE);
  const { used, literals } = harvest();
  const problems = [...lintSurface(SURFACE), ...literals];
  for (const [k, where] of used) if (!en[k]) problems.push(`not in i18n/browser-extension/en.json: ${k} (${where})`);
  for (const k of Object.keys(en)) if (!used.has(k)) problems.push(`stale in i18n/browser-extension/en.json (no code uses it): ${k}`);
  for (const l of ga()) {
    if (l.code === locales.source) continue;
    const tr = readTr(SURFACE, l.code);
    const missing = Object.keys(en).filter((k) => en[k].translatable !== false && !tr[k]);
    if (missing.length) problems.push(`browser-extension/${l.code} is ga but lacks ${missing.length} strings (first: ${missing[0]})`);
  }
  const want = new Set(ga().map(folderOf));
  const have = fs.existsSync(OUT) ? fs.readdirSync(OUT) : [];
  for (const d of have) if (!want.has(d)) problems.push(`_locales/${d} is not a ga language: run node scripts/i18n-browser-extension.mjs build`);
  for (const l of ga()) {
    const f = path.join(OUT, folderOf(l), "messages.json");
    if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== messagesFor(l.code)) {
      problems.push(`apps/browser-extension-firefox/_locales/${folderOf(l)}/messages.json is stale: run node scripts/i18n-browser-extension.mjs build`);
    }
  }
  if (problems.length) { console.error(problems.join("\n") + `\n\n${problems.length} problem(s)`); process.exit(1); }
  console.log("i18n-browser-extension: ok");
} else if (!runCommon(SURFACE, args)) {
  console.error("usage: i18n-browser-extension.mjs build | check | dump | merge | midx | status | lint | accept");
  process.exit(2);
}
