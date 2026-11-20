/**
 * `GET /api/voici/promo`: the optional promo line under the apps' one-time "Get your own voi.ci page" intro.
 *
 * The text is server config, not an app string, so it can change without a release: `VOICI_PROMO` in wrangler.toml
 * [vars] is a JSON map of locale to text (`{"en": "...", "fr": "..."}`); empty or absent means no promo, and
 * `VOICI_PROMO_UNTIL` (ISO time, optional) ends it. The language is `?lang=` first, then Accept-Language, then English.
 * Anonymous and the same for everyone: it names nobody and reads nothing.
 */

export interface VoiciPromoEnv {
  VOICI_PROMO?: string;
  VOICI_PROMO_UNTIL?: string;
}

export const VOICI_PROMO_PATH = "/api/voici/promo";

export interface VoiciPromo {
  text: string;
  until: string | null;
}

function promoTexts(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out.set(k.toLowerCase(), v.trim());
  }
  return out;
}

function rankedTags(langParam: string | null, acceptLanguage: string | null): string[] {
  const fromHeader = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(/q=([\d.]+)/.exec(params.join(";"))?.[1] ?? 1);
      return { tag: (tag ?? "").trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
  const param = (langParam ?? "").trim().toLowerCase();
  return param ? [param, ...fromHeader] : fromHeader;
}

/** The configured locale a tag reads: exact, else the same base language (Simplified Chinese only for zh, zh-cn, zh-sg, zh-hans). */
function match(texts: Map<string, string>, tag: string): string | null {
  if (texts.has(tag)) return tag;
  const [base, ...rest] = tag.split("-");
  if (base === "zh") {
    const simplified = rest.length === 0 || rest.includes("hans") || rest.includes("cn") || rest.includes("sg");
    if (!simplified) return null;
    for (const k of texts.keys()) if (k === "zh" || k === "zh-hans" || k === "zh-cn") return k;
    return null;
  }
  for (const k of texts.keys()) if (k === base || k.split("-")[0] === base) return k;
  return null;
}

/** The promo for a request, or null (no text configured, ended, or nothing in any language). */
export function voiciPromoFor(env: VoiciPromoEnv, langParam: string | null, acceptLanguage: string | null, now = Date.now()): VoiciPromo | null {
  const texts = promoTexts(env.VOICI_PROMO);
  if (texts.size === 0) return null;
  let until: string | null = null;
  if (env.VOICI_PROMO_UNTIL && env.VOICI_PROMO_UNTIL.trim()) {
    const end = Date.parse(env.VOICI_PROMO_UNTIL.trim());
    if (!Number.isFinite(end) || end <= now) return null;
    until = new Date(end).toISOString();
  }
  for (const tag of [...rankedTags(langParam, acceptLanguage), "en"]) {
    const key = match(texts, tag);
    if (key) return { text: texts.get(key)!, until };
  }
  return null;
}

export function handleVoiciPromo(request: Request, url: URL, env: VoiciPromoEnv): Response {
  const promo = voiciPromoFor(env, url.searchParams.get("lang"), request.headers.get("accept-language"));
  return new Response(JSON.stringify({ promo }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300", vary: "Accept-Language" },
  });
}
