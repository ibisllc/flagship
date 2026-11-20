// The site's own strings, in the 7 Flagship locales (i18n/locales.json). Source strings are English and written
// in the code as t("…") with a literal first argument (scripts read them: apps/voici-site/i18n.mjs extract); the
// translations live in i18n/voici-site/<code>.json and are compiled into strings.js by the build. The owner's
// content (name, bio, links, posts, replies) is never translated.

import { pickLanguage } from "./lang.js";
import { LOCALES, STRINGS } from "./strings.js";

let current = "en";

/** The visitor's language: the first of the browser's languages the site ships (pt → pt-BR, zh → zh-Hans by the
 *  shared rule in lang.js), else English. Never remembered, never the page owner's. */
export function initLocale(nav = globalThis.navigator) {
  const prefs = nav?.languages?.length ? nav.languages : [nav?.language].filter(Boolean);
  current = pickLanguage(prefs, LOCALES.map((l) => l.code));
  return current;
}

export const locale = () => current;

/** t("Hello {0}", name): the translation for the current locale, else the English source; {n} filled in as text. */
export function t(source, ...args) {
  const s = (current !== "en" && STRINGS[current]?.[source]) || source;
  return s.replace(/\{(\d+)\}/g, (m, n) => (args[Number(n)] !== undefined ? String(args[Number(n)]) : m));
}

export function formatDate(ms) {
  try {
    return new Intl.DateTimeFormat(current, { dateStyle: "medium" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function formatTime(ms) {
  try {
    const d = new Date(ms);
    const sameDay = new Date().toDateString() === d.toDateString();
    return new Intl.DateTimeFormat(current, sameDay ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

export { LOCALES };
