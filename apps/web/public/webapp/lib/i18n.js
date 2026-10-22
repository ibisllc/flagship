// Translations for the webapp (docs/i18n.md). The English text is the key:
//
//   tr("Saved.")                          -> "Saved." or its translation
//   tr("Invite for {0} created.", name)   -> {0}, {1}… are filled in after the lookup
//   trn(n, "{0} app", "{0} apps")         -> picks the plural form for the active language
//
// Which languages exist is decided by scripts/i18n-pwa.mjs build: it writes lib/i18nLocales.js (the "ga"
// list from i18n/locales.json) and one i18n/<lang>.json per ga language. While that list is empty nothing is
// fetched and every call returns its English argument.

import { GA_LOCALES, CATALOG_VERSIONS } from "./i18nLocales.js";

let catalog = null;
let active = "en";

const STORE_KEY = "fs-lang";

// Traditional-Chinese readers get English rather than Simplified, which reads as a different written language.
const TRADITIONAL_ZH = /^zh-(hant|tw|hk|mo)\b/;

/** The language to show: a saved choice if it is still shipped, else the first browser preference we ship, else English. */
export function pickLanguage(saved, wanted, ga = GA_LOCALES) {
  if (saved && ga.includes(saved)) return saved;
  for (const raw of wanted ?? []) {
    if (!raw) continue;
    const tag = String(raw).toLowerCase();
    if (tag === "en" || tag.startsWith("en-")) return "en";
    const exact = ga.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    if (TRADITIONAL_ZH.test(tag)) continue;
    const base = tag.split("-")[0];
    const hit = ga.find((l) => l.toLowerCase().split("-")[0] === base);
    if (hit) return hit;
  }
  return "en";
}

function chosenLanguage() {
  let saved = null;
  try { saved = localStorage.getItem(STORE_KEY); } catch { /* storage can be blocked */ }
  const wanted = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  return pickLanguage(saved, wanted);
}

/** The catalog's URL carries its content hash, so a new build is fetched once and an old one is never served from the HTTP cache. */
export function catalogUrl(lang, base = import.meta.url) {
  const v = CATALOG_VERSIONS?.[lang];
  return new URL(`../i18n/${lang}.json${v ? `?v=${v}` : ""}`, base);
}

/** Load the catalog for the active language. Runs once, at import time (top-level await below), so every module that imports t() evaluates after it. */
export async function initI18n() {
  if (!GA_LOCALES.length) return;
  const lang = chosenLanguage();
  if (lang === "en") return;
  try {
    const res = await fetch(catalogUrl(lang), { cache: "force-cache" });
    if (!res.ok) return;
    catalog = await res.json();
    active = lang;
    document.documentElement.lang = lang;
    if (document.body) translateStatic(document.body);
  } catch { /* offline with no cached catalog: English */ }
}

export function currentLanguage() { return active; }

/** The locale to hand to Intl / toLocale*String: the app's language, or the browser's own while the app is in English. */
export function dateLocale() { return active === "en" ? undefined : active; }

/** A number with the active language's digit grouping and decimal mark. */
export function fmtNum(n, opts) {
  try { return new Intl.NumberFormat(dateLocale(), opts).format(n); } catch { return String(n); }
}

let rules = null, rulesFor = "";
/** Whether `n` takes the singular form in the active language (French counts 0 as singular, Japanese and Chinese never do). */
function isOne(n) {
  if (active === "en") return n === 1;
  if (rulesFor !== active) { try { rules = new Intl.PluralRules(active); } catch { rules = null; } rulesFor = active; }
  return rules ? rules.select(n) === "one" : n === 1;
}

export function setLanguage(code) {
  try { localStorage.setItem(STORE_KEY, code); } catch { /* ignore */ }
}

function fill(text, args) {
  if (!args.length) return text;
  return text.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
}

export function tr(en, ...args) {
  const hit = catalog && Object.prototype.hasOwnProperty.call(catalog, en) ? catalog[en] : null;
  return fill(typeof hit === "string" && hit ? hit : en, args);
}

/** Plural by count. The two English forms are the keys; a catalog entry may be {one, other}. */
export function trn(n, one, other, ...args) {
  const key = isOne(n) ? one : other;
  const hit = catalog && Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : null;
  return fill(typeof hit === "string" && hit ? hit : key, [typeof n === "number" && n >= 1000 ? fmtNum(n) : n, ...args]);
}

/** Translate the static text of a server-rendered or index.html subtree (text nodes and a few attributes). */
export function translateStatic(root = document) {
  if (!catalog) return;
  // an element of only text and inline tags is translated as one sentence (the key is its innerHTML)
  const INLINE = new Set(["A", "B", "I", "EM", "STRONG", "CODE", "KBD", "SMALL", "U", "MARK", "SUP", "SUB", "BR", "ABBR", "S", "WBR"]);
  const inlineOnly = (el) => Array.from(el.childNodes).every((c) => c.nodeType === 3 || c.nodeType === 8 || (c.nodeType === 1 && INLINE.has(c.tagName) && inlineOnly(c)));
  for (const el of root.querySelectorAll?.("*") ?? []) {
    if (!el.children.length || !Array.from(el.children).every((c) => INLINE.has(c.tagName)) || !inlineOnly(el)) continue;
    const key = el.innerHTML.replace(/\s+/g, " ").trim();
    const hit = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : null;
    if (typeof hit === "string" && hit) el.innerHTML = hit;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue ?? "";
    const trimmed = raw.trim();
    if (!trimmed || !Object.prototype.hasOwnProperty.call(catalog, trimmed)) continue;
    const hit = catalog[trimmed];
    if (typeof hit === "string" && hit) n.nodeValue = raw.replace(trimmed, hit);
  }
  for (const el of root.querySelectorAll?.("[placeholder],[title],[aria-label],[alt]") ?? []) {
    for (const a of ["placeholder", "title", "aria-label", "alt"]) {
      const v = el.getAttribute(a);
      if (v && Object.prototype.hasOwnProperty.call(catalog, v) && typeof catalog[v] === "string") el.setAttribute(a, catalog[v]);
    }
  }
}

await initI18n();
