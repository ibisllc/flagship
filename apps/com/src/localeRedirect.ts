import { GA_WEB_LOCALES } from "./localeTable.generated.js";

/**
 * First-visit language choice for the marketing site. English lives at the root and every other
 * language under /<webPath>/ (apps/web/public, built by scripts/i18n-web.mjs). A visitor who has
 * never picked a language and whose browser prefers a live one is sent there once; picking a
 * language in the footer sets the `fs-lang` cookie, which always wins, including "en".
 *
 * Only languages marked "ga" in i18n/locales.json are ever offered, so while every language is a
 * draft this answers null for everyone and the root behaves exactly as before.
 */

export interface WebLocale {
  code: string;
  webPath: string;
}

/** Which live language, if any, a request should land on. null means serve English. */
export function pickWebLocale(
  acceptLanguage: string | null,
  cookieHeader: string | null,
  live: readonly WebLocale[] = GA_WEB_LOCALES,
): WebLocale | null {
  if (live.length === 0) return null;
  const chosen = /(?:^|;\s*)fs-lang=([^;]+)/.exec(cookieHeader ?? "")?.[1];
  if (chosen) return live.find((l) => l.code === chosen) ?? null;

  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(/q=([\d.]+)/.exec(params.join(";"))?.[1] ?? 1);
      return { tag: (tag ?? "").toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    if (tag === "en" || tag.startsWith("en-")) return null; // English was asked for first
    const hit = live.find((l) => matches(l.code, tag));
    if (hit) return hit;
  }
  return null;
}

function matches(code: string, tag: string): boolean {
  const c = code.toLowerCase();
  if (tag === c) return true;
  const [base] = c.split("-");
  const [tagBase, ...rest] = tag.split("-");
  if (tagBase !== base) return false;
  if (base === "zh") {
    // Simplified for zh, zh-cn, zh-sg, zh-hans*; Traditional (zh-tw, zh-hk, zh-hant) is a different page.
    return rest.length === 0 || rest.includes("hans") || rest.includes("cn") || rest.includes("sg");
  }
  return true; // pt-PT is read fine by a pt-BR page, fr-CA by fr, es-MX by es
}
