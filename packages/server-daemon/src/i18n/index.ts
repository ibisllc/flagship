// Language for the pages the box serves itself (invite, sign-in, backup download, landing/404).
//
// Text is English-as-key, like the webapp: `t(lang, "Sign in")`. A language with no catalog entry
// for a string shows the English. The catalogs hold only languages marked "ga" in i18n/locales.json
// (see scripts/i18n-box.mjs), so until one ships every page renders exactly as before.
// The language comes from the visitor's Accept-Language header; nothing is stored.

import { CATALOGS } from "./catalog.generated.js";

export { CATALOGS };

const fill = (s: string, args: ReadonlyArray<string | number>): string =>
  s.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));

/** `text` in `lang`, with {0}, {1}… replaced by `args`. Callers escape `args` for the place they land. */
export function t(lang: string, text: string, ...args: Array<string | number>): string {
  return fill(CATALOGS[lang]?.[text] ?? text, args);
}

/** `t` as a JSON string literal safe inside an inline <script> (for text the page's script shows). */
export function tj(lang: string, text: string, ...args: Array<string | number>): string {
  return JSON.stringify(t(lang, text, ...args)).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/** The best language we have a catalog for, from an Accept-Language header; "en" when none fits. */
export function languageFor(headers: Record<string, string | string[] | undefined> | undefined): string {
  const raw = headers?.["accept-language"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  if (!header) return "en";
  const have = Object.keys(CATALOGS);
  if (have.length === 0) return "en";
  const wanted = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: (tag ?? "").trim().toLowerCase(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((w) => w.tag && w.tag !== "*" && w.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of wanted) {
    if (tag === "en" || tag.startsWith("en-")) return "en";
    const exact = have.find((c) => c.toLowerCase() === tag);
    if (exact) return exact;
    const primary = tag.split("-")[0];
    // Traditional Chinese must not fall back to our Simplified catalog.
    if (primary === "zh" && /(^|-)(hant|tw|hk|mo)(-|$)/.test(tag)) continue;
    const near = have.find((c) => c.toLowerCase().split("-")[0] === primary);
    if (near) return near;
  }
  return "en";
}

/** Response headers every localised page carries so a shared cache keeps the languages apart. */
export const VARY_LANGUAGE = { vary: "Accept-Language" } as const;
