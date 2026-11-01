/**
 * GET /api/runtime/manifest: the signed runtime manifest (release plan G2), the machine-readable half of
 * flagshipserver.com/runtime. `/runtime` itself sends readers to the page that renders it
 * (apps/web/public/security/runtime.html).
 *
 * `.com` only CARRIES the manifest. It is signed offline by the release keys (tools/box-artifact/runtime-manifest.ts,
 * `publish` writes release/runtime-manifest.json), and every box, app and independent checker verifies it against the
 * release trust it already pins, never against a key this response could supply. A compromised `.com` can withhold it
 * or serve an older one; boxes refuse a lower sequence and an expired one, and keep the last one they accepted.
 *
 * One static document for everybody: nothing about the caller is read, set or logged. Nothing published: 204.
 */
import committed from "../../../release/runtime-manifest.json";

export const RUNTIME_MANIFEST_PATH = "/api/runtime/manifest";
export const RUNTIME_PAGE_PATH = "/security/runtime.html";

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

export function isRuntimeManifestPath(pathname: string): boolean {
  return pathname === RUNTIME_MANIFEST_PATH;
}

export function isRuntimePagePath(pathname: string): boolean {
  return pathname === "/runtime" || pathname === "/runtime/";
}

async function etagOf(body: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  let s = "";
  for (const b of d.subarray(0, 16)) s += b.toString(16).padStart(2, "0");
  return `"${s}"`;
}

export async function handleRuntimeManifest(request: Request, deps: { manifest?: unknown } = {}): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "GET, HEAD" },
    });
  }
  const doc = "manifest" in deps ? deps.manifest : (committed as unknown);
  const headers: Record<string, string> = { "cache-control": CACHE_CONTROL };
  if (doc === null || doc === undefined) {
    headers.etag = '"none"';
    if (request.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
    return new Response(null, { status: 204, headers });
  }
  const body = JSON.stringify(doc);
  headers.etag = await etagOf(body);
  if (request.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
  headers["content-type"] = "application/json; charset=utf-8";
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}

export function redirectToRuntimePage(url: URL): Response {
  return new Response(null, { status: 308, headers: { location: `${url.origin}${RUNTIME_PAGE_PATH}` } });
}
