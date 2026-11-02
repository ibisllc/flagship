// How voi.ci serves its own site (docs/voici-and-messages.md §4.2, chunk C): the shell for every page and for
// /_/about straight from the generated build module (no asset fetch, so no html_handling redirect can turn it into
// a 307), and the site's files under /_/<dir>/ only when <dir> is this build and the path is in its manifest.
// Anything else under /_/ is a 404, never the assets layer's single-page fallback.
import { VOICI_SITE_DIR, VOICI_SITE_FILES, VOICI_SITE_SHELL } from "./voiciSiteBuild.generated.js";

/** Where apps/voici-site/build.mjs writes the files inside the Worker's assets (apps/web/public/_voici). */
export const VOICI_SITE_ASSET_DIR = "/_voici";

const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
};

function withHeaders(body: BodyInit | null, status: number, siteHeaders: [string, string][], extra: Record<string, string>): Response {
  const headers = new Headers(extra);
  for (const [k, v] of siteHeaders) headers.set(k, v);
  return new Response(body, { status, headers });
}

const notFound = (siteHeaders: [string, string][]) =>
  withHeaders("not found", 404, siteHeaders, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });

/** The page shell (the same bytes for every page); 410 for a page taken down. */
export function voiciShellResponse(request: Request, siteHeaders: [string, string][], status = 200): Response {
  return withHeaders(request.method.toUpperCase() === "HEAD" ? null : VOICI_SITE_SHELL, status, siteHeaders, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": status === 200 ? "public, max-age=60" : "no-store",
  });
}

/** `voi.ci/_/<rest>`: the about page's shell, or one listed file of this build (immutable), else 404. */
export async function voiciSiteFile(
  request: Request,
  assets: { fetch(req: Request): Promise<Response> } | undefined,
  rest: string,
  siteHeaders: [string, string][],
): Promise<Response> {
  if (rest === "about" || rest === "about/") return voiciShellResponse(request, siteHeaders);
  const m = /^([0-9a-f]{16})\/([A-Za-z0-9._/-]+)$/.exec(rest);
  if (!m || m[1] !== VOICI_SITE_DIR || !VOICI_SITE_FILES.has(m[2]!) || m[2]!.split("/").some((s) => s === "" || s.startsWith(".")) || !assets) {
    return notFound(siteHeaders);
  }
  const res = await assets.fetch(new Request(new URL(`${VOICI_SITE_ASSET_DIR}/${m[1]}/${m[2]}`, request.url), { method: request.method.toUpperCase() === "HEAD" ? "HEAD" : "GET" }));
  if (res.status !== 200) return notFound(siteHeaders);
  const ext = m[2]!.slice(m[2]!.lastIndexOf(".") + 1);
  return withHeaders(res.body, 200, siteHeaders, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "cross-origin-resource-policy": "same-origin",
  });
}
