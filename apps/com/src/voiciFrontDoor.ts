// voi.ci's front door (docs/voici-front-door.md): `GET voi.ci/` for someone who starts there. One static page per
// shipped language, rendered by `node apps/voici-site/build.mjs` into the generated build module, so serving it reads
// nothing: no D1, no R2, no KV, no fetch. It loads whenever the Worker runs, even while the rest of `.com` fails.
import { pickWebLocale } from "./localeRedirect.js";
import { VOICI_FRANCOPHONE_LANGUAGES, VOICI_FRANCOPHONE_REGIONS, VOICI_FRONT_DOOR } from "./voiciSiteBuild.generated.js";

const CODES = Object.keys(VOICI_FRONT_DOOR);
const LIVE = CODES.filter((c) => c !== "en").map((code) => ({ code, webPath: code.toLowerCase() }));

function tags(acceptLanguage: string | null): string[] {
  return (acceptLanguage ?? "")
    .split(",")
    .map((part) => part.trim().split(";"))
    .filter(([tag, ...params]) => tag && tag !== "*" && Number(/q=([\d.]+)/.exec(params.join(";"))?.[1] ?? 1) > 0)
    .map(([tag]) => tag!.trim().toLowerCase());
}

function isFrancophone(tag: string): boolean {
  const [lang, ...rest] = tag.split("-");
  return VOICI_FRANCOPHONE_LANGUAGES.has(lang!) || rest.some((p) => p.length === 2 && VOICI_FRANCOPHONE_REGIONS.has(p));
}

/**
 * The language of the front door: `?lang=` when it names a shipped one, else the shared rule
 * (test-vectors/language-negotiation.json), else French when the browser points at a French reader and never asked
 * for English (apps/voici-site/src/lang.js, the same tables), else English.
 */
export function pickVoiciFrontLanguage(acceptLanguage: string | null, langParam: string | null = null): string {
  if (langParam && CODES.includes(langParam)) return langParam;
  const shared = pickWebLocale(acceptLanguage, null, LIVE);
  if (shared) return shared.code;
  const list = tags(acceptLanguage);
  if (list.some((t) => t === "en" || t.startsWith("en-"))) return "en";
  return CODES.includes("fr") && list.some(isFrancophone) ? "fr" : "en";
}

/** The front door for this request, with its environment's origin and apex filled in. */
export function voiciFrontDoorResponse(
  request: Request,
  url: URL,
  env: { origin: string; apex: string },
  siteHeaders: [string, string][],
): Response {
  const lang = pickVoiciFrontLanguage(request.headers.get("accept-language"), url.searchParams.get("lang"));
  const html = VOICI_FRONT_DOOR[lang]!.replaceAll("%ORIGIN%", env.origin).replaceAll("%APEX%", env.apex);
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-language": lang,
    vary: "Accept-Language",
    "cache-control": "public, max-age=300",
  });
  for (const [k, v] of siteHeaders) headers.set(k, v);
  return new Response(request.method.toUpperCase() === "HEAD" ? null : html, { status: 200, headers });
}
