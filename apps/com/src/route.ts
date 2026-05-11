/**
 * Pure routing logic for the flagshipserver.com Cloudflare Worker.
 *
 * Responsibilities:
 *   1. Host-aware: serves the apex (flagshipserver.com / www.) and the
 *      webapp origin (web.flagshipserver.com).
 *   2. .com control-plane routes (username, auth-code, build-tickets,
 *      server registration, CA pubkey-cert) — served by Worker + D1.
 *   3. /build/iso/:filename — streams from R2.
 *   4. /api/_status/probe — Worker-resident probe of .services.
 *   5. /api/build/iso-info — base-ISO metadata.
 *   6. Anything else under /api/* not handled above — proxied to .services.
 *   7. On the apex: /webapp/* and /me/* 308-redirect to web.flagshipserver.com.
 *   8. On web.flagshipserver.com: /X is rewritten to ASSETS /webapp/X so
 *      the on-disk webapp source serves at the new origin's root. Files
 *      stay under apps/web/public/webapp/ — no churn.
 *   9. Anything else — static assets.
 */

import { tryControlPlane } from "./controlPlaneRoutes.js";

const WEBAPP_HOST = "web.flagshipserver.com";
const WEBAPP_ORIGIN = `https://${WEBAPP_HOST}`;

/**
 * Origins allowed to call /api/* on the apex via cross-origin XHR.
 * The webapp lives on web.flagshipserver.com; the marketing/identity
 * site on flagshipserver.com is same-origin (no preflight); local dev
 * runs against http://localhost.
 *
 * All sensitive endpoints (lease deposit, recovery upload) are
 * signature-gated, so the CORS allowlist is a defense-in-depth layer
 * — relaxing it doesn't bypass auth, but a tight list reduces
 * accidental cross-tab attack surface.
 */
const CORS_ALLOWED_ORIGINS = new Set<string>([
  WEBAPP_ORIGIN,
  "https://flagshipserver.com",
  "https://www.flagshipserver.com",
  "http://localhost:8787",
  "http://localhost:5173",
]);

export interface RouteEnv {
  SERVICES_BASE_URL: string;
  /** The Worker assets binding. Tests pass a stub. */
  ASSETS: { fetch(req: Request): Promise<Response> };
  /** Optional base-ISO override for /api/build/iso-info. */
  BASE_ISO_URL?: string;
  BASE_ISO_VERSION?: string;
  BASE_ISO_SHA256?: string;
  /** R2 bucket holding the base ISO(s). Streams via /build/iso/:filename. */
  ISO_BUCKET?: R2BucketLike;
  /** D1 binding for the .com control-plane state. */
  DB?: import("@flagship/storage").D1Database;
  /** CA private key for /api/users/:username/pubkey-cert (Worker secret). */
  FLAGSHIP_CA_PRIV_HEX?: string;
  FLAGSHIP_CA_ISSUER?: string;
  /** WebSocket URL daemons dial for the tunnel hub (discovery endpoint). */
  TUNNEL_HUB_URL?: string;
  /** SNI passthrough anycast IPs (also used by serverRegister to publish DNS). */
  SERVICES_PASSTHROUGH_IPV4?: string;
  SERVICES_PASSTHROUGH_IPV6?: string;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
}

export interface R2ObjectLike {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  httpEtag?: string;
  checksums?: { sha256?: ArrayBuffer };
  writeHttpMetadata?(headers: Headers): void;
}

const PROXY_PREFIX = "/api/";
const STATUS_PROBE_PATH = "/api/_status/probe";
const BUILD_ISO_INFO_PATH = "/api/build/iso-info";
const HEALTH_PATH = "/api/health";
const SERVICES_ENDPOINTS_PATH = "/api/services/endpoints";
const BUILD_ISO_STREAM_PREFIX = "/build/iso/";

/**
 * Default tunnel hub URL when TUNNEL_HUB_URL env var isn't set. Matches
 * the hardcoded fallback in `packages/server-daemon/src/index.ts` so a
 * daemon that can't reach the discovery endpoint still works.
 */
const DEFAULT_TUNNEL_HUB_URL = "wss://flagship-services.fly.dev:8443/tunnel";

/**
 * Schema version for /api/services/endpoints. Bump when we make a
 * non-additive change so daemons can refuse to act on a response they
 * don't understand.
 */
const SERVICES_ENDPOINTS_VERSION = 1;

/**
 * Default placeholder ISO. We don't yet host a real personalizable installer
 * — when we do, this URL points at the canonical R2 (or GH Releases) object
 * and `version`/`sha256` get pinned to that artifact.
 */
const DEFAULT_BASE_ISO_URL =
  "https://flagshipserver.com/build/placeholder-base.iso";
const DEFAULT_BASE_ISO_VERSION = "0.0.0-placeholder";
const DEFAULT_BASE_ISO_SHA256 = "";

/**
 * Headers the edge sets on every request that should NOT be forwarded
 * upstream as-is. Stripping `host` so Fly sees the right virtual host;
 * stripping `cf-*` because the Fly app doesn't speak Cloudflare-isms.
 */
const STRIP_REQ_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const STRIP_RES_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
]);

export async function route(request: Request, env: RouteEnv): Promise<Response> {
  const url = new URL(request.url);

  // ---- CORS preflight ----
  // Cross-origin POSTs from the webapp (on web.flagshipserver.com) to
  // /api/* on the apex trigger a preflight. Answer it directly so the
  // actual request can proceed.
  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
    return corsPreflight(request);
  }

  const res = await routeImpl(request, env, url);
  return applyCors(request, url, res);
}

/** Internal — the actual routing logic. `route` wraps this with CORS. */
async function routeImpl(request: Request, env: RouteEnv, url: URL): Promise<Response> {
  // ---- web.flagshipserver.com ----
  // Webapp lives at this dedicated origin. Files on disk are under
  // apps/web/public/webapp/, but on this host we serve them at root —
  // so /X is rewritten to ASSETS /webapp/X. Everything on this host is
  // either a webapp asset or the SPA fallback; the apex's /api/* and
  // /og + control-plane routes are NOT exposed here. The webapp itself
  // talks to the user's pod for /api/screens/* and to the apex for
  // anything .com-resident — never to web. directly.
  if (url.hostname === WEBAPP_HOST) {
    return serveWebapp(request, url, env);
  }

  // Worker-resident probe: never forwarded upstream as-is. The Worker does
  // the timed fetch itself so /status/ shows what flagshipserver.com sees,
  // not what the user's browser sees.
  if (url.pathname === STATUS_PROBE_PATH) {
    return statusProbe(env);
  }

  if (url.pathname === BUILD_ISO_INFO_PATH) {
    return buildIsoInfo(env);
  }

  if (url.pathname === HEALTH_PATH) {
    return jsonHealth();
  }

  if (url.pathname === SERVICES_ENDPOINTS_PATH) {
    return jsonServicesEndpoints(env);
  }

  if (url.pathname.startsWith(BUILD_ISO_STREAM_PREFIX)) {
    return streamIsoFromR2(url.pathname.slice(BUILD_ISO_STREAM_PREFIX.length), env);
  }

  // P3.6 — /og?title=...&subtitle=...
  // Returns an SVG poster with the title baked in. SVG is acceptable
  // for Twitter / Discord previews; some OG validators want PNG —
  // when that becomes a concern we'll rasterize via the existing
  // build pipeline rather than pulling a runtime renderer into the
  // Worker.
  if (url.pathname === "/og") {
    return ogImage(url);
  }

  // P3.7 — `/me` and `/me/*` redirect to the webapp on its dedicated
  // origin. 308 keeps method semantics for any future POSTs from
  // bookmarks. Query and hash are preserved by the browser.
  if (url.pathname === "/me" || url.pathname.startsWith("/me/")) {
    return new Response(null, {
      status: 308,
      headers: { location: `${WEBAPP_ORIGIN}/${url.search}` },
    });
  }

  // Legacy `/webapp/*` paths on the apex 308-redirect to the new origin.
  // Path tail and query string are preserved so deep links survive the
  // move (`/webapp/foo?x=1` → `https://web.flagshipserver.com/foo?x=1`).
  // PWA installs made on the apex are now broken — that's accepted,
  // since the migration ran before any meaningful install base existed.
  if (url.pathname === "/webapp" || url.pathname.startsWith("/webapp/")) {
    const tail = url.pathname.slice("/webapp".length); // "" or "/X"
    const target = `${WEBAPP_ORIGIN}${tail || "/"}${url.search}`;
    return new Response(null, {
      status: 308,
      headers: { location: target },
    });
  }

  // .com control-plane routes (D1-backed). When DB binding is present,
  // these are served locally; otherwise fall through to the upstream proxy
  // (e.g. for the dev wrangler-without-d1 case).
  if (url.pathname.startsWith(PROXY_PREFIX) && env.DB) {
    const cp = await tryControlPlane(request, env);
    if (cp) return cp;
  }

  if (url.pathname.startsWith(PROXY_PREFIX)) {
    return proxyToServices(request, env, url);
  }

  // Static asset path — let the assets binding handle it.
  return env.ASSETS.fetch(request);
}

interface ProbeResult {
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number;
  upstream: string;
  checkedAt: string;
  error?: string;
  health?: unknown;
}

async function statusProbe(env: RouteEnv): Promise<Response> {
  let base: URL;
  try {
    base = new URL(env.SERVICES_BASE_URL);
  } catch {
    return jsonResponse(
      { error: "SERVICES_BASE_URL is not configured" },
      500,
    );
  }

  const target = new URL("/api/health", base).toString();
  const startedAt = Date.now();
  let result: ProbeResult;
  try {
    // 5s ceiling — anything slower than that is functionally down for a
    // status page.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const resp = await fetch(target, { signal: ctrl.signal, redirect: "manual" });
    clearTimeout(timer);
    const latencyMs = Date.now() - startedAt;
    let body: unknown = undefined;
    try {
      body = await resp.json();
    } catch {
      // ignore parse errors — non-JSON response still counts as reachable
    }
    result = {
      reachable: resp.ok,
      statusCode: resp.status,
      latencyMs,
      upstream: target,
      checkedAt: new Date().toISOString(),
      health: body,
    };
  } catch (e) {
    result = {
      reachable: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      upstream: target,
      checkedAt: new Date().toISOString(),
      error: String((e as Error).message ?? e),
    };
  }
  return jsonResponse(result, 200);
}

async function streamIsoFromR2(filename: string, env: RouteEnv): Promise<Response> {
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return jsonResponse({ error: "invalid iso filename" }, 400);
  }
  if (!env.ISO_BUCKET) {
    return jsonResponse({ error: "ISO_BUCKET not bound" }, 500);
  }
  const obj = await env.ISO_BUCKET.get(filename);
  if (!obj || !obj.body) {
    return jsonResponse({ error: "iso not found" }, 404);
  }
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-length": String(obj.size),
    "cache-control": "public, max-age=86400, immutable",
    "content-disposition": `attachment; filename="${filename}"`,
  });
  if (obj.httpEtag) headers.set("etag", obj.httpEtag);
  if (obj.writeHttpMetadata) obj.writeHttpMetadata(headers);
  return new Response(obj.body, { status: 200, headers });
}

async function buildIsoInfo(env: RouteEnv): Promise<Response> {
  const url = env.BASE_ISO_URL ?? DEFAULT_BASE_ISO_URL;
  const version = env.BASE_ISO_VERSION ?? DEFAULT_BASE_ISO_VERSION;
  const sha256 = env.BASE_ISO_SHA256 ?? DEFAULT_BASE_ISO_SHA256;
  return jsonResponse(
    {
      url,
      version,
      sha256,
      placeholder: version === DEFAULT_BASE_ISO_VERSION,
    },
    200,
  );
}

/**
 * P3.6 — generate an OG-poster SVG with the provided title (and
 * optional subtitle). Worker-rendered so we don't need to pre-build
 * one image per page. Cached at the edge for 1h since the title-set
 * is small + slow-changing.
 *
 * Inputs:
 *   ?title=<text>     required, ≤120 chars
 *   ?subtitle=<text>  optional, ≤200 chars
 *
 * Returns image/svg+xml.
 */
function ogImage(url: URL): Response {
  const title = (url.searchParams.get("title") ?? "Flagship").slice(0, 120);
  const subtitle = (url.searchParams.get("subtitle") ?? "Your stuff, on your hardware.").slice(0, 200);
  // Wrap the title to ~22 chars/line so the poster doesn't overflow.
  const titleLines = wordWrap(title, 22).slice(0, 3);
  const titleSvg = titleLines.map((line, i) => {
    const dy = i === 0 ? 0 : 88;
    return `<text x="80" y="${260 + i * 88}" fill="#fafafa" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, sans-serif" font-weight="700" font-size="80" letter-spacing="-2">${escapeXml(line)}</text>${dy === 0 ? "" : ""}`;
  }).join("");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#1a1a2e"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <g>
    <circle cx="80" cy="100" r="22" fill="#3b5bff"/>
    <text x="120" y="110" fill="#fafafa" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="600" font-size="32" letter-spacing="-0.5">Flagship</text>
  </g>
  ${titleSvg}
  <text x="80" y="${260 + titleLines.length * 88 + 28}" fill="#a0a0b0" font-family="ui-sans-serif, system-ui, sans-serif" font-size="32" letter-spacing="-0.5">${escapeXml(subtitle)}</text>
  <text x="80" y="580" fill="#666680" font-family="ui-sans-serif, system-ui, sans-serif" font-size="22">flagshipserver.com</text>
</svg>`;
  return new Response(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

function wordWrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [text];
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * Worker-served health endpoint. Returns directly without proxying to
 * .services so the answer doesn't depend on the Fly app being up — the
 * Worker is the canonical "is the control plane alive?" answer.
 */
function jsonHealth(): Response {
  return jsonResponse(
    {
      ok: true,
      service: "flagshipserver.com",
      surface: "com",
      now: new Date().toISOString(),
    },
    200,
  );
}

/**
 * Service-discovery payload daemons fetch on startup so they can dial
 * the tunnel hub without any hardcoded host. Also surfaces the SNI
 * passthrough IPs (informational; daemons don't dial these directly,
 * but tooling and the status page benefit).
 *
 * `siblings` is reserved for future inter-`.services` peer routing
 * (see future_inter_services_peering.md). Today we always emit `[]`;
 * daemons must ignore unknown fields, and a future Worker deploy can
 * populate the array without any daemon-side change.
 */
function jsonServicesEndpoints(env: RouteEnv): Response {
  const body = {
    version: SERVICES_ENDPOINTS_VERSION,
    tunnelHub: env.TUNNEL_HUB_URL ?? DEFAULT_TUNNEL_HUB_URL,
    passthroughIPv4: env.SERVICES_PASSTHROUGH_IPV4 ?? null,
    passthroughIPv6: env.SERVICES_PASSTHROUGH_IPV6 ?? null,
    siblings: [] as Array<{ wsUrl: string; pubKeyHex: string }>,
    issuedAt: new Date().toISOString(),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // 60s cache: daemons fetch on startup + reconnect; this keeps
      // edge load low while making infra moves visible within ~1 min.
      "cache-control": "public, max-age=60",
    },
  });
}

async function proxyToServices(
  request: Request,
  env: RouteEnv,
  url: URL,
): Promise<Response> {
  // Refuse if the configured target is not an absolute URL — guards against
  // a misconfigured deploy turning the Worker into an open redirect.
  let base: URL;
  try {
    base = new URL(env.SERVICES_BASE_URL);
  } catch {
    return new Response(
      JSON.stringify({ error: "SERVICES_BASE_URL is not configured" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const target = new URL(url.pathname + url.search, base);

  const reqHeaders = new Headers();
  for (const [k, v] of request.headers) {
    if (!STRIP_REQ_HEADERS.has(k.toLowerCase())) reqHeaders.set(k, v);
  }
  // Telemetry-friendly: surface the original host so .services can log
  // / disambiguate per surface.
  reqHeaders.set("x-forwarded-host", url.host);
  reqHeaders.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));

  // Body is read once and re-attached. Cloudflare's runtime forwards
  // streams natively; Node's undici needs `duplex: "half"` when streaming
  // a body and complains otherwise — using arrayBuffer() sidesteps that
  // and is fine for the small JSON payloads our API uses.
  const hasBody = requestHasBody(request.method);
  const bodyBytes = hasBody ? await request.arrayBuffer() : undefined;
  const upstream = new Request(target.toString(), {
    method: request.method,
    headers: reqHeaders,
    body: hasBody && bodyBytes && bodyBytes.byteLength > 0 ? bodyBytes : undefined,
    redirect: "manual",
  });

  let resp: Response;
  try {
    resp = await fetch(upstream);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "upstream unreachable", message: String((e as Error).message ?? e) }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const resHeaders = new Headers();
  for (const [k, v] of resp.headers) {
    if (!STRIP_RES_HEADERS.has(k.toLowerCase())) resHeaders.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resHeaders,
  });
}

function requestHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/** Origin sniffing — null when missing or not an http(s) URL. */
function originHeader(request: Request): string | null {
  const o = request.headers.get("origin");
  if (!o) return null;
  try {
    const u = new URL(o);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Add CORS headers to /api/* responses when the request origin is
 * allow-listed. Same-origin requests have no `Origin` header; we no-op
 * for those (and for non-/api paths). Sensitive endpoints are signed,
 * so this CORS layer is defense-in-depth, not the primary auth gate.
 */
function applyCors(request: Request, url: URL, res: Response): Response {
  if (!url.pathname.startsWith("/api/")) return res;
  const origin = originHeader(request);
  if (!origin || !CORS_ALLOWED_ORIGINS.has(origin)) return res;
  // Headers on a Response are immutable when sourced from fetch(); clone
  // into a fresh Response with the merged header set.
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "origin");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** Preflight handler — answers OPTIONS for /api/* without touching downstream. */
function corsPreflight(request: Request): Response {
  const origin = originHeader(request);
  const headers = new Headers({
    "access-control-allow-methods": "GET, HEAD, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-flagship-session, authorization",
    "access-control-max-age": "600",
    vary: "origin",
  });
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Serve a request to web.flagshipserver.com by rewriting `/X` to
 * `/webapp/X` and handing off to the assets binding. The on-disk file
 * tree is unchanged (apps/web/public/webapp/...); the user-visible
 * origin sees those files at root paths so the manifest's start_url
 * and the service-worker scope can both be `/`.
 *
 * Anything not a GET/HEAD on this host falls through to a 405 — the
 * webapp's data-plane writes (orders, paired-session adds) go to the
 * user's pod (`<server>.<user>.flagship.services`), never to .com.
 */
async function serveWebapp(
  request: Request,
  url: URL,
  env: RouteEnv,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(
      JSON.stringify({ error: "method not allowed", host: WEBAPP_HOST }),
      { status: 405, headers: { "content-type": "application/json", allow: "GET, HEAD" } },
    );
  }

  // Disk layout:  apps/web/public/webapp/<file>
  // Public path:  /<file>     → rewrite to /webapp/<file> for ASSETS
  // Public root:  /           → ASSETS /webapp/  (binding serves index.html)
  const rewrittenPath = url.pathname === "/" ? "/webapp/" : `/webapp${url.pathname}`;
  const rewritten = new URL(rewrittenPath + url.search, "https://flagshipserver.com");
  // Preserve method + headers; body is empty for GET/HEAD.
  const assetReq = new Request(rewritten.toString(), {
    method,
    headers: request.headers,
  });
  return env.ASSETS.fetch(assetReq);
}

export const _internal = {
  PROXY_PREFIX,
  STATUS_PROBE_PATH,
  BUILD_ISO_INFO_PATH,
  HEALTH_PATH,
  SERVICES_ENDPOINTS_PATH,
  BUILD_ISO_STREAM_PREFIX,
  DEFAULT_BASE_ISO_URL,
  DEFAULT_BASE_ISO_VERSION,
  DEFAULT_TUNNEL_HUB_URL,
  SERVICES_ENDPOINTS_VERSION,
  STRIP_REQ_HEADERS,
  STRIP_RES_HEADERS,
  WEBAPP_HOST,
  WEBAPP_ORIGIN,
};
