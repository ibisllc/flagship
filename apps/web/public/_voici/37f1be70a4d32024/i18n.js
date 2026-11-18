// The site's own strings, in the 7 Flagship locales (i18n/locales.json). Source strings are English and written
// in the code as t("…") with a literal first argument (scripts read them: apps/voici-site/i18n.mjs extract); the
// translations live in i18n/voici-site/<code>.json and are compiled into strings.js by the build. The owner's
// content (name, bio, links, posts, replies) is never translated.

import { pickLanguage } from "./lang.js";
import { LOCALES, STRINGS } from "./strings.js";

const KEY = "voici-lang";
let current = "en";

function pick(languages) {
  return pickLanguage(languages ?? [], LOCALES.map((l) => l.code));
}

export function initLocale(nav = globalThis.navigator, storage = globalThis.localStorage) {
  let saved = null;
  try {
    saved = storage?.getItem(KEY) ?? null;
  } catch {
    saved = null;
  }
  current = saved && LOCALES.some((l) => l.code === saved) ? saved : pick(nav?.languages ?? [nav?.language]);
  return current;
}

export function setLocale(code, storage = globalThis.localStorage) {
  if (!LOCALES.some((l) => l.code === code)) return current;
  current = code;
  try {
    storage?.setItem(KEY, code);
  } catch {
    /* not remembered */
  }
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
