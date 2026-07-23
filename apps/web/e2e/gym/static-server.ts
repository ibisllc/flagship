/**
 * A tiny self-contained static file server that mirrors the PRODUCTION
 * host-rewrite (webapp.flagshipserver.com/X → ASSETS /webapp/X, falling through to
 * the sibling public assets like /fonts/ and /tokens.css), so the gym's webapp
 * smoke needs NO backend — no wrangler dev, no pod-sim, no Worker. That is all
 * a cold-launch → bootstrap-renders smoke requires (§12-G3 / §4 Tier-1).
 * Behavioral flows that DO need the backend stay on the existing pod-sim rig
 * (s00..s16).
 *
 * Resolution order for a request path /X (matching apps/com/src/route.ts's
 * webapp.flagshipserver.com rewrite):
 *   1. apps/web/public/webapp/X   — the webapp tree at the origin root
 *   2. apps/web/public/X          — sibling public assets (fonts, tokens.css)
 *   3. apps/web/public/webapp/index.html — SPA fallback ONLY for extension-less
 *      navigations (so a missing .js/.woff2 surfaces as a real 404, never a
 *      silently-HTML-served module that would mask a regression).
 */

import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// apps/web/e2e/gym/ → apps/web/public/
const PUBLIC_ROOT = normalize(join(here, "..", "..", "public"));
const WEBAPP_ROOT = join(PUBLIC_ROOT, "webapp");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

function serveFile(res: import("node:http").ServerResponse, path: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", MIME[extname(path)] ?? "application/octet-stream");
  createReadStream(path).pipe(res);
}

/** Resolve a candidate within a root, rejecting traversal; null if outside/absent. */
function resolveWithin(root: string, rel: string): string | null {
  const resolved = normalize(join(root, rel));
  if (!resolved.startsWith(root)) return null;
  if (!existsSync(resolved) || statSync(resolved).isDirectory()) return null;
  return resolved;
}

export function startWebappStaticServer(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";

    // 1. The webapp tree at the origin root.
    const inWebapp = resolveWithin(WEBAPP_ROOT, rel);
    if (inWebapp) return serveFile(res, inWebapp);

    // 2. Sibling public assets (e.g. /fonts/*, /tokens.css).
    const inPublic = resolveWithin(PUBLIC_ROOT, rel);
    if (inPublic) return serveFile(res, inPublic);

    // 3. SPA fallback ONLY for extension-less navigations; a missing asset
    //    (with an extension) is an honest 404, not a masked HTML response.
    if (extname(rel) === "") return serveFile(res, join(WEBAPP_ROOT, "index.html"));
    res.statusCode = 404;
    res.end("not found");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Allow `tsx static-server.ts` as a Playwright `webServer.command`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.GYM_WEBAPP_PORT ?? "8799");
  startWebappStaticServer(port).then(() => {
    // eslint-disable-next-line no-console
    console.log(`gym webapp static server on http://127.0.0.1:${port} (root: ${PUBLIC_ROOT})`);
  });
}
