// Translations for the webapp (docs/i18n.md). The English text is the key:
//
//   tr("Saved.")                          -> "Saved." or its translation
//   tr("Invite for {0} created.", name)   -> {0}, {1}… are filled in after the lookup
//   trn(n, "{0} app", "{0} apps")         -> picks the plural form for the active language
//
// Which languages exist is decided by scripts/i18n-pwa.mjs build: it writes lib/i18nLocales.js (the "ga"
// list from i18n/locales.json) and one i18n/<lang>.json per ga language. While that list is empty nothing is
// fetched and every call returns its English argument.

import { GA_LOCALES } from "./i18nLocales.js";

let catalog = null;
let active = "en";

const STORE_KEY = "fs-lang";

function chosenLanguage() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && GA_LOCALES.includes(saved)) return saved;
  } catch { /* storage can be blocked */ }
  const wanted = (typeof navigator !== "undefined" && (navigator.languages?.length ? navigator.languages : [navigator.language])) || [];
  for (const raw of wanted) {
    if (!raw) continue;
    const tag = String(raw).toLowerCase();
    const exact = GA_LOCALES.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split("-")[0];
    const script = tag.startsWith("zh") ? "zh-Hans" : null;
    const hit = GA_LOCALES.find((l) => l.toLowerCase() === (script ?? base).toLowerCase() || l.toLowerCase().split("-")[0] === base);
    if (hit) return hit;
  }
  return "en";
}

/** Load the catalog for the active language. Runs once, at import time (top-level await below), so every module that imports t() evaluates after it. */
export async function initI18n() {
  if (!GA_LOCALES.length) return;
  const lang = chosenLanguage();
  if (lang === "en") return;
  try {
    const res = await fetch(new URL(`../i18n/${lang}.json`, import.meta.url), { cache: "force-cache" });
    if (!res.ok) return;
    catalog = await res.json();
    active = lang;
    document.documentElement.lang = lang;
    if (document.body) translateStatic(document.body);
  } catch { /* offline with no cached catalog: English */ }
}

export function currentLanguage() { return active; }

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
  const key = n === 1 ? one : other;
  const hit = catalog && Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : null;
  return fill(typeof hit === "string" && hit ? hit : key, [n, ...args]);
}

/** Translate the static text of a server-rendered or index.html subtree (text nodes and a few attributes). */
export function translateStatic(root = document) {
  if (!catalog) return;
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
