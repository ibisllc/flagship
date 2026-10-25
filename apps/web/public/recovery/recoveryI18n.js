// Translations for the recovery page (docs/i18n.md). This origin can load only its own files, so it carries
// its own copy of the webapp's runtime (webapp/lib/i18n.js); the English text is the key, shared with the
// webapp in i18n/webapp/<lang>.json:
//
//   tr("Working…")                         -> "Working…" or its translation
//   tr("Will enrol passkey for: {0}", u)   -> {0}, {1}… are filled in after the lookup
//   trn(n, "{0} minute", "{0} minutes")    -> picks the plural form for the active language
//
// scripts/i18n-pwa.mjs build writes recoveryI18nLocales.js and one i18n/<lang>.json per ga language, holding
// only the keys this page uses.
//
// Which language: the webapp that opens this window names the one it shows in the fragment
// (`#recover&lang=es`), because its saved choice lives on its own origin and this page must not guess
// differently. Opened directly (no `lang=`), the browser's languages decide, by the webapp's rule
// (test-vectors/language-negotiation.json).

import { GA_LOCALES, CATALOG_VERSIONS } from "./recoveryI18nLocales.js";

let catalog = null;
let active = "en";

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

/** The `lang=` the webapp put in the fragment (`#enroll&lang=de`), or null when it named none. */
export function handedLanguage(hash) {
  for (const part of String(hash ?? "").replace(/^#/, "").split("&").slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq) !== "lang") continue;
    try {
      return decodeURIComponent(part.slice(eq + 1));
    } catch {
      return "";
    }
  }
  return null;
}

/** Handed a language: that one if this page ships it, else English (never a guess of its own). Handed none: the browser's. */
export function languageFor(hash, wanted, ga = GA_LOCALES) {
  const handed = handedLanguage(hash);
  if (handed !== null) return handed !== "en" && ga.includes(handed) ? handed : "en";
  return pickLanguage(null, wanted, ga);
}

/** The catalog's URL carries its content hash, so a new build is fetched once and an old one is never served from the HTTP cache. */
export function catalogUrl(lang, base = import.meta.url) {
  const v = CATALOG_VERSIONS?.[lang];
  return new URL(`./i18n/${lang}.json${v ? `?v=${v}` : ""}`, base);
}

/** Load the catalog for the handed-over language. Runs once, at import time, so recovery.js evaluates after it. */
export async function initI18n() {
  if (!GA_LOCALES.length || typeof location === "undefined") return;
  const wanted = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  const lang = languageFor(location.hash, wanted);
  if (lang === "en") return;
  try {
    const res = await fetch(catalogUrl(lang), { cache: "force-cache" });
    if (!res.ok) return;
    catalog = await res.json();
    active = lang;
    document.documentElement.lang = lang;
    translateStatic(document);
  } catch {
    /* no catalog (offline, or the SPA fallback answered with HTML): English */
  }
}

export function currentLanguage() { return active; }

let rules = null, rulesFor = "";
/** Whether `n` takes the singular form in the active language (French counts 0 as singular, Japanese and Chinese never do). */
function isOne(n) {
  if (active === "en") return n === 1;
  if (rulesFor !== active) { try { rules = new Intl.PluralRules(active); } catch { rules = null; } rulesFor = active; }
  return rules ? rules.select(n) === "one" : n === 1;
}

function fill(text, args) {
  if (!args.length) return text;
  return text.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
}

function lookup(en) {
  const hit = catalog && Object.prototype.hasOwnProperty.call(catalog, en) ? catalog[en] : null;
  return typeof hit === "string" && hit ? hit : null;
}

export function tr(en, ...args) {
  return fill(lookup(en) ?? en, args);
}

/** Plural by count. The two English forms are the keys. */
export function trn(n, one, other, ...args) {
  const key = isOne(n) ? one : other;
  return fill(lookup(key) ?? key, [n, ...args]);
}

// Inline tags a sentence of index.html may hold. A translation is rebuilt node by node from these alone (no
// attributes), never assigned as HTML: this origin holds the recovery passkey.
const INLINE = new Set(["A", "B", "I", "EM", "STRONG", "CODE", "KBD", "SMALL", "U", "MARK", "SUP", "SUB", "BR", "ABBR", "S", "WBR"]);
const SAFE_TAGS = new Set(["B", "I", "EM", "STRONG", "CODE", "KBD", "SMALL", "BR"]);

function setSentence(el, translated) {
  const parsed = new DOMParser().parseFromString(`<body>${translated}</body>`, "text/html").body;
  const copy = (from, to) => {
    for (const n of Array.from(from.childNodes)) {
      if (n.nodeType === 3) to.append(n.nodeValue ?? "");
      else if (n.nodeType === 1 && SAFE_TAGS.has(n.tagName)) {
        const e = document.createElement(n.tagName.toLowerCase());
        copy(n, e);
        to.append(e);
      } else if (n.nodeType === 1) to.append(n.textContent ?? "");
    }
  };
  const frag = document.createDocumentFragment();
  copy(parsed, frag);
  el.replaceChildren(frag);
}

/** Translate the static text of index.html: whole sentences with inline tags, then plain text nodes, then the title. */
export function translateStatic(root = document) {
  if (!catalog) return;
  const inlineOnly = (el) => Array.from(el.childNodes).every((c) => c.nodeType === 3 || c.nodeType === 8 || (c.nodeType === 1 && INLINE.has(c.tagName) && inlineOnly(c)));
  for (const el of root.querySelectorAll?.("body *") ?? []) {
    if (!el.children.length || !Array.from(el.children).every((c) => INLINE.has(c.tagName)) || !inlineOnly(el)) continue;
    const hit = lookup(el.innerHTML.replace(/\s+/g, " ").trim());
    if (hit) setSentence(el, hit);
  }
  const body = root.body ?? root;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && ["SCRIPT", "STYLE"].includes(n.parentElement.tagName)) continue;
    const raw = n.nodeValue ?? "";
    const hit = lookup(raw.trim());
    if (hit) n.nodeValue = raw.replace(raw.trim(), hit);
  }
  if (root.title) root.title = tr(root.title);
}

await initI18n();
