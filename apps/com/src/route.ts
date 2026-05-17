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
import {
  recordRateLimited,
  recordUpgrade,
  readRecent as readRelayMetrics,
} from "./qrPipeMetrics.js";
import {
  checkQrPipeUpgrade,
  checkRateLimit,
  clientIp,
  endpointFor,
  extractIrkPub,
  extractUsernameHash,
  rateLimitedResponse,
  type RateLimitBinding,
} from "./rateLimit.js";

const WEBAPP_HOST = "web.flagshipserver.com";
const WEBAPP_ORIGIN = `https://${WEBAPP_HOST}`;

/**
 * voi.ci — Flagship's URL shortener (V1).
 *
 * Cloudflare routes voi.ci/* to this same Worker. A request to
 * https://voi.ci/<code> hits the redirect handler below, which
 * looks up the code in D1 and 302s to the target URL.
 *
 * The shortener API (POST /api/voici/shorten + cascades from the
 * app-rename handler) lives on the apex (flagshipserver.com /api/*)
 * — voi.ci itself ONLY serves redirects so a casual visitor can't
 * enumerate codes or hit unrelated control-plane routes.
 *
 * Setup note: this requires the `voi.ci` zone to be onboarded to
 * Cloudflare with a Worker route `voi.ci/*` bound to flagship-com.
 * Without that the dispatch below never fires; existing traffic to
 * flagshipserver.com is unaffected.
 */
const VOICI_HOST = "voi.ci";
const VOICI_WWW_HOST = "www.voi.ci";

/**
 * Dedicated origin for the WebAuthn-PRF recovery flow (Tasks #73 + #74).
 *
 * The passkey credential lives at rpId = "recovery.flagshipserver.com",
 * which is a different origin from both the marketing apex and the
 * webapp. WebAuthn's same-origin policy enforces that a passkey created
 * here can only be exercised by a page served from this same origin —
 * so an XSS on flagshipserver.com or web.flagshipserver.com cannot
 * silently call `navigator.credentials.get()` and exfiltrate the UMK.
 *
 * Disk layout: apps/web/public/recovery/* serves at the root of this
 * origin (same trick we use for `web.` and the /webapp tree). Only the
 * single-purpose recovery page lives here — no shared JS, no shared
 * fonts (except via 'self'), no analytics.
 */
const RECOVERY_HOST = "recovery.flagshipserver.com";
const RECOVERY_ORIGIN = `https://${RECOVERY_HOST}`;

/**
 * CSP applied to every response served from `recovery.flagshipserver.com`.
 *
 * - `default-src 'self'`: no third-party anything.
 * - `script-src 'self'`: no inline scripts, no eval. Argon2 ships as a
 *   self-hosted module.
 * - `style-src 'self'`: no inline styles either; the CSS is self-hosted.
 * - `connect-src` is locked to flagshipserver.com (where the
 *   `/api/recovery/*` endpoints live) plus self.
 * - `frame-ancestors 'none'`: this origin cannot be iframed, full stop.
 * - `form-action 'self'`: no submit-to-attacker tricks.
 * - `base-uri 'none'`: prevents <base> injection from re-pointing
 *   relative URLs.
 */
const RECOVERY_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "connect-src 'self' https://flagshipserver.com; " +
  "frame-ancestors 'none'; " +
  "form-action 'self'; " +
  "base-uri 'none'; " +
  "object-src 'none'";

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
  RECOVERY_ORIGIN,
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
  /** Cloudflare rate-limit binding shared by all four mutating control-plane endpoints. */
  RATE_LIMITER?: RateLimitBinding;
  /**
   * Dedicated rate-limit binding for /qr-pipe upgrades (P2). Keeps
   * DO-spawn-per-IP bounded so the free-tier duration budget can't
   * be drained by a single source.
   */
  RATE_LIMITER_QR_PIPE?: RateLimitBinding;
  /**
   * Build-relay Durable Object namespace (task #59). Tests pass a
   * lightweight stub; production wiring is in wrangler.toml.
   */
  BUILD_RELAY?: BuildRelayNamespaceLike;
}

export interface BuildRelayNamespaceLike {
  newUniqueId(): { toString(): string };
  idFromName(name: string): { toString(): string };
  idFromString(id: string): { toString(): string };
  get(id: { toString(): string }): { fetch(req: Request): Promise<Response> };
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
const STATUS_RELAY_PATH = "/api/_status/relay";
const BUILD_ISO_INFO_PATH = "/api/build/iso-info";
const HEALTH_PATH = "/api/health";
const SERVICES_ENDPOINTS_PATH = "/api/services/endpoints";
const BUILD_ISO_STREAM_PREFIX = "/build/iso/";
/**
 * Legacy POST endpoint for v1 of the build-relay protocol. v2 is
 * WebSocket-only and uses client-derived session IDs; this endpoint
 * exists only as a graceful 410 for old clients that still POST here.
 */
const BUILD_RELAY_SESSIONS_PATH = "/api/build-relay/sessions";
/** v2: WebSocket pipe for the QR relay. /qr-pipe/<sid>?role=browser|phone */
const QR_PIPE_WS_PREFIX = "/qr-pipe/";

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

/**
 * Asset names that exist exclusively under apps/web/public/webapp/ on
 * disk. Any apex request for one of these paths in local dev is
 * almost certainly the webapp's SW or PWA-shell asset — fetched
 * before the host override hooks have a chance to fire (SW
 * registration in particular bypasses page.route).
 *
 * Production never sees these on the apex (the webapp lives on its
 * own origin) so the helper is a no-op there.
 */
const WEBAPP_SHELL_PATHS = new Set([
  "/service-worker.js",
  "/manifest.json",
  "/icon.svg",
  "/icon-maskable.svg",
  "/app.js",
  "/keystore.js",
  "/providers.js",
  "/qrScanner.js",
]);
const WEBAPP_SHELL_PREFIXES = ["/lib/", "/views/"];

function isWebappShellPath(pathname: string): boolean {
  if (WEBAPP_SHELL_PATHS.has(pathname)) return true;
  for (const p of WEBAPP_SHELL_PREFIXES) {
    if (pathname.startsWith(p)) return true;
  }
  return false;
}

export async function route(request: Request, env: RouteEnv): Promise<Response> {
  const requestUrl = new URL(request.url);

  // Workerd (wrangler dev) replaces the Host header with the route's
  // configured zone, so `request.url` always reports the apex hostname
  // and the webapp host-rewrite below never fires. For the e2e harness
  // we accept an `x-flagship-effective-host` header (set by the
  // pod-sim fixture's per-page route) and reroute against it. The
  // header is never emitted by real browsers, and the production
  // Worker happily ignores it since the canonical Host already
  // matches the URL it would resolve to. So this is a no-op on prod.
  //
  // ServiceWorker registration fetches and cross-origin font requests
  // bypass the per-page route, so we add a second escape hatch: when
  // the request lands on a localhost dev origin AND the path is
  // unambiguously a webapp-shell asset (paths that exist only under
  // /webapp/ on disk), treat it as webapp. Production never serves
  // these paths from the apex — they're only fetched by the webapp
  // origin — so this is also a no-op there.
  let url = requestUrl;
  const override = request.headers.get("x-flagship-effective-host");
  if (override) {
    const lowered = override.split(":")[0]?.toLowerCase() ?? "";
    if (lowered === WEBAPP_HOST ||
        lowered === RECOVERY_HOST ||
        lowered === "www.flagshipserver.com" ||
        lowered === "flagshipserver.com") {
      url = new URL(
        `https://${lowered}${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`,
      );
    }
  } else if (isWebappShellPath(requestUrl.pathname)) {
    // Path is unambiguously a webapp asset (these files exist only
    // under apps/web/public/webapp/ on disk). The marketing apex
    // never requests them in production, so rewriting unconditionally
    // is safe — and it's the only way to serve them correctly under
    // wrangler dev, where workerd reports the apex hostname even
    // when the request really came from the SW registration on the
    // webapp origin.
    url = new URL(
      `https://${WEBAPP_HOST}${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`,
    );
  }

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

  // ---- recovery.flagshipserver.com ----
  // Single-purpose sub-origin for the WebAuthn-PRF recovery flow. Every
  // response carries the strict CSP defined in RECOVERY_CSP plus a
  // X-Frame-Options: DENY belt-and-braces against legacy browsers that
  // ignore frame-ancestors. Disk path: apps/web/public/recovery/*.
  if (url.hostname === RECOVERY_HOST) {
    return serveRecovery(request, url, env);
  }

  // ---- voi.ci ----
  // URL shortener. The only thing this hostname does is look up a
  // 6-char base36 code in D1 and 302 to the stored target. Anything
  // else (POST, longer paths, root, etc.) returns 404 to keep the
  // surface tiny + un-enumerable. The actual mint API lives on the
  // apex (POST /api/voici/shorten + cascades from rename).
  if (url.hostname === VOICI_HOST || url.hostname === VOICI_WWW_HOST) {
    return serveVoiciRedirect(request, url, env);
  }

  // Worker-resident probe: never forwarded upstream as-is. The Worker does
  // the timed fetch itself so /status/ shows what flagshipserver.com sees,
  // not what the user's browser sees.
  if (url.pathname === STATUS_PROBE_PATH) {
    return statusProbe(env);
  }

  if (url.pathname === STATUS_RELAY_PATH) {
    return statusRelay(url, env);
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

  // Universal Links — Apple insists on Content-Type: application/json for
  // /.well-known/apple-app-site-association even though the file has no
  // extension. Cloudflare's assets binding serves it as
  // application/octet-stream by default; we fetch it ourselves and rewrite
  // the response headers so iOS accepts the bind on first install.
  if (url.pathname === "/.well-known/apple-app-site-association") {
    return serveAasa(env);
  }

  if (url.pathname.startsWith(BUILD_ISO_STREAM_PREFIX)) {
    return streamIsoFromR2(url.pathname.slice(BUILD_ISO_STREAM_PREFIX.length), env);
  }

  // v1 mint endpoint — kept as a 410 for graceful failure of any old
  // client that still tries to POST here. v2 is WebSocket-only.
  if (url.pathname === BUILD_RELAY_SESSIONS_PATH) {
    return jsonResponse(
      { error: "v1 relay retired; use ws://<host>/qr-pipe/<sid> directly" },
      410,
    );
  }

  // v2 QR-relay WS upgrade. /qr-pipe/<sid>?role=browser|phone forwards
  // the upgrade to the DO addressed by the CLIENT-DERIVED sid. The DO
  // is looked up by name (idFromName), so any string the client picks
  // (a base64url random ~22 chars) resolves to a stable DO.
  if (url.pathname.startsWith(QR_PIPE_WS_PREFIX)) {
    return forwardQrPipeUpgrade(request, env, url);
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

  // `/recovery/*` paths on the apex 308-redirect to the dedicated
  // sub-origin. The recovery page must only ever be served from
  // `recovery.flagshipserver.com` — that's the whole point of putting
  // the WebAuthn passkey behind a different rpId. Without this redirect
  // the asset binding would happily serve the same HTML at
  // flagshipserver.com/recovery/, and a user who landed there could
  // create a passkey scoped to the apex rpId — defeating the isolation.
  if (url.pathname === "/recovery" || url.pathname.startsWith("/recovery/")) {
    const tail = url.pathname.slice("/recovery".length); // "" or "/X"
    const target = `${RECOVERY_ORIGIN}${tail || "/"}${url.search}`;
    return new Response(null, {
      status: 308,
      headers: { location: target },
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

  // Pre-launch stealth gate: the public marketing surface is replaced by
  // a "coming soon" page so operational detail (build flow, dev tools,
  // status, docs, etc.) isn't exposed before the mobile apps ship.
  //
  // `/wip_` (and the friendlier alias `/alpha`) plus their `/*` subpaths
  // strip the prefix, serve the real asset, and drop a `flagship_preview`
  // cookie so internal links (which point at un-prefixed paths like
  // /faq.html) continue to resolve to the real pages on subsequent
  // navigations. /api/*, /og, /me/*, /webapp/*, /recovery/*,
  // /build/iso/*, and /.well-known/* are handled above and never hit
  // this gate — the apps keep working unchanged.
  const previewPrefix = matchedPreviewPrefix(url.pathname);
  if (previewPrefix) {
    return serveWipPreview(request, url, env, previewPrefix);
  }

  // Rate-limit the four mutating control-plane endpoints. Runs BEFORE
  // dispatch but AFTER body buffering so we can pull the IRK pubkey
  // out of signed requests for the per-IRK axis. When the limit trips
  // we 429 immediately — never reach the D1 handler or the upstream.
  //
  // The body is buffered once here and re-attached to a fresh Request
  // so downstream readers (tryControlPlane, proxyToServices) see the
  // same payload. This duplicates the body parse but each endpoint's
  // payload is small JSON, so the cost is negligible compared to
  // protecting D1 from a tight-loop attacker.
  const rlEndpoint = endpointFor(request.method, url.pathname);
  let buffered = request;
  if (rlEndpoint) {
    let bodyText: string | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      bodyText = await request.text();
      buffered = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText && bodyText.length > 0 ? bodyText : undefined,
      });
    }
    let parsed: unknown;
    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = undefined;
      }
    }
    const irkPub = extractIrkPub(rlEndpoint, parsed);
    const usernameHash = extractUsernameHash(url.pathname);
    const rl = await checkRateLimit(env, {
      endpoint: rlEndpoint,
      ip: clientIp(request),
      ...(irkPub ? { irkPub } : {}),
      ...(usernameHash ? { usernameHash } : {}),
    });
    if (rl.limited) return rateLimitedResponse(rl);
  }

  // .com control-plane routes (D1-backed). When DB binding is present,
  // these are served locally; otherwise fall through to the upstream proxy
  // (e.g. for the dev wrangler-without-d1 case).
  if (url.pathname.startsWith(PROXY_PREFIX) && env.DB) {
    const cp = await tryControlPlane(buffered, env);
    if (cp) return cp;
  }

  if (url.pathname.startsWith(PROXY_PREFIX)) {
    return proxyToServices(buffered, env, url);
  }

  // Pre-launch stealth gate. By this point every explicit Worker handler
  // (api, build/iso, og, me/webapp/recovery redirects, .well-known/aasa)
  // has already returned — so the only requests reaching here are
  // static-asset fallbacks (marketing HTML, /docs, /blog, /status, /qr,
  // /deck, CSS/JS/fonts). Show coming-soon to those unless the request
  // carries the preview cookie set by /wip_.
  if (!hasPreviewCookie(request) && !isComingSoonExempt(url.pathname)) {
    return serveComingSoon(env);
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

/**
 * Serve the apple-app-site-association file for Universal Link binding.
 *
 * The file lives on disk at apps/web/public/.well-known/apple-app-site-association
 * with no extension (Apple is finicky about that). Cloudflare's assets
 * binding serves it but defaults to application/octet-stream because
 * there's no extension to dispatch on. iOS rejects anything that isn't
 * application/json on first install — so we fetch from the binding and
 * rewrite the response headers ourselves.
 */
async function serveAasa(env: RouteEnv): Promise<Response> {
  const upstream = await env.ASSETS.fetch(
    new Request("https://flagshipserver.com/.well-known/apple-app-site-association"),
  );
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }
  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      // AASA is allowed to be cached aggressively by clients;
      // Apple's CDN poll uses a 24h interval. 5 minutes is a sensible
      // operator-side cap so we can re-roll quickly during setup.
      "cache-control": "public, max-age=300",
    },
  });
}

/**
 * /api/_status/relay — daily /qr-pipe upgrade counts.
 *
 * Returns up to ?days=N (default 14, max 90) most-recent buckets from
 * the `qr_pipe_metrics` table. Each row carries `upgrades` (requests
 * that materialised a DO) and `rateLimited` (requests turned away at
 * the IP gate before reaching the DO). The /status/ page renders this
 * so a duration-runaway is visible before it trips the ceiling.
 *
 * Returns an empty array when DB isn't bound — the endpoint is
 * deliberately tolerant of dev/test environments.
 */
async function statusRelay(url: URL, env: RouteEnv): Promise<Response> {
  const requested = Number(url.searchParams.get("days") ?? "14");
  const days = Number.isFinite(requested) ? requested : 14;
  const records = await readRelayMetrics(env.DB, days);
  return jsonResponse(
    {
      buckets: records.map((r) => ({
        day: r.bucketDay,
        upgrades: r.upgradeCount,
        rateLimited: r.rateLimitedCount,
        updatedAt: r.updatedAt,
      })),
      now: new Date().toISOString(),
    },
    200,
  );
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

/**
 * v2 QR relay: forward a /qr-pipe/<sid>?role=… upgrade to the DO
 * addressed by `idFromName(sid)`. Any well-formed sid works; the
 * Cloudflare runtime hashes the name into a stable DO id, so the
 * same sid from two different clients always lands on the same DO.
 *
 * Validation is intentionally minimal: we enforce a length range and
 * a URL-safe alphabet, but we don't restrict the value beyond that —
 * the DO itself arbitrates "already taken" and "already consumed".
 */
async function forwardQrPipeUpgrade(
  request: Request,
  env: RouteEnv,
  url: URL,
): Promise<Response> {
  if (!env.BUILD_RELAY) {
    return jsonResponse({ error: "qr-pipe not configured" }, 503);
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse({ error: "websocket upgrade required" }, 426);
  }
  const sid = url.pathname.slice(QR_PIPE_WS_PREFIX.length).split("/")[0] ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(sid)) {
    return jsonResponse({ error: "sid must be 16-64 base64url chars" }, 400);
  }
  // P2 — bound DO spawns per client IP. Each accepted upgrade
  // materialises a Durable Object; without this gate any unauth'd
  // source can fan out enough DOs to refill the free-tier duration
  // bucket before throttling notices.
  const rl = await checkQrPipeUpgrade(env, clientIp(request));
  if (rl.limited) {
    // P3 — count it so /status/ can flag a runaway before the next
    // billing email. recordRateLimited is awaited so the row commits;
    // the D1 hit is ~ms and a 429 response is already an error path.
    await recordRateLimited(env.DB);
    return rateLimitedResponse(rl);
  }
  // P3 — count successful spawns. This is the canary for free-tier
  // duration runaway: /status/ surfaces the daily totals so we see a
  // climb before it trips the ceiling.
  await recordUpgrade(env.DB);
  const id = env.BUILD_RELAY.idFromName(sid);
  const stub = env.BUILD_RELAY.get(id);
  return stub.fetch(request);
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
  const subtitle = (url.searchParams.get("subtitle")
    ?? "Your stuff, on hardware you own.").slice(0, 200);
  const titleLines = wordWrap(title, 18).slice(0, 3);
  const titleSvg = titleLines.map((line, i) => {
    return `<text x="80" y="${300 + i * 96}" fill="#14130E" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-weight="400" font-size="104" letter-spacing="-3">${escapeXml(line)}</text>`;
  }).join("");
  const subtitleY = 300 + titleLines.length * 96 + 36;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img">
  <defs>
    <radialGradient id="bg" cx="0.85" cy="0.15" r="1.2">
      <stop offset="0%" stop-color="#EFE9D6"/>
      <stop offset="55%" stop-color="#F4F1E8"/>
      <stop offset="100%" stop-color="#EDE9DC"/>
    </radialGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#D38347"/>
      <stop offset="100%" stop-color="#B26016"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <!-- Hairline frame -->
  <rect x="32" y="32" width="1136" height="566" fill="none" stroke="#DAD5C5" stroke-width="1"/>
  <!-- Pennant mark, top-left -->
  <g transform="translate(80,80)">
    <line x1="0" y1="0" x2="0" y2="58" stroke="#14130E" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M0 4 L42 4 L33 19 L42 34 L0 34 Z" fill="url(#amber)"/>
    <circle cx="0" cy="0" r="4" fill="#14130E"/>
    <circle cx="0" cy="58" r="4" fill="#14130E"/>
    <text x="60" y="20" fill="#14130E" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="600" font-size="22" letter-spacing="-0.3">Flagship</text>
    <text x="60" y="44" fill="#6C685D" font-family="ui-monospace, monospace" font-size="13" letter-spacing="0.18em">A PERSONAL CLOUD</text>
  </g>
  ${titleSvg}
  <text x="80" y="${subtitleY}" fill="#5A5B5E" font-family="ui-sans-serif, -apple-system, system-ui, sans-serif" font-weight="500" font-size="28" letter-spacing="-0.3">${escapeXml(subtitle)}</text>
  <!-- Bottom rule -->
  <line x1="80" y1="540" x2="1120" y2="540" stroke="#DAD5C5" stroke-width="1"/>
  <text x="80" y="572" fill="#6C685D" font-family="ui-monospace, monospace" font-size="16" letter-spacing="0.12em">FLAGSHIPSERVER.COM</text>
  <text x="1120" y="572" fill="#6C685D" font-family="ui-monospace, monospace" font-size="16" letter-spacing="0.12em" text-anchor="end">YOU HOLD THE KEYS</text>
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
    "access-control-allow-headers": "content-type, x-flagship-session, authorization, x-flagship-effective-host",
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

/**
 * Serve `recovery.flagshipserver.com` from `apps/web/public/recovery/*`.
 *
 * Method is GET/HEAD only — every recovery write (POST upload, POST
 * fetch, DELETE) goes cross-origin to the apex `/api/recovery/*`
 * endpoints. The page itself is pure static HTML + a small JS module.
 *
 * Every response gets the strict CSP + framing protections. This is the
 * single line of defense against an attacker getting their page injected
 * into the recovery origin via, e.g., a future asset-binding bug.
 */
/**
 * voi.ci hostname dispatch. GET /<code> → 302 to the stored target,
 * or 404 / 410 on miss / expired. Everything else (root path, POST,
 * anything below /<code>) is 404 — the surface stays one-route only.
 */
async function serveVoiciRedirect(
  request: Request,
  url: URL,
  env: RouteEnv,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(
      JSON.stringify({ error: "method not allowed", host: VOICI_HOST }),
      { status: 405, headers: { "content-type": "application/json", allow: "GET, HEAD" } },
    );
  }
  if (!env.DB) {
    return new Response("storage not configured", { status: 503 });
  }
  // /<code> — strip the leading slash, reject anything with further
  // segments so /a/b doesn't somehow match a code lookup.
  const path = url.pathname.replace(/^\/+/, "");
  if (path === "" || path.includes("/")) {
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain", "cache-control": "private, no-store" },
    });
  }
  const { D1Storage } = await import("@flagship/storage");
  const { handleVoiciRedirect } = await import("@flagship/control-plane");
  const storage = new D1Storage(env.DB);
  const res = await handleVoiciRedirect(
    { usernames: storage.usernames, voiciLinks: storage.voiciLinks },
    path,
  );
  // The handler returns a 302 with a `location` header attached; copy
  // it through into a real Response.
  const headers = new Headers({ "cache-control": "private, no-store" });
  if (res.headers) {
    for (const [k, v] of Object.entries(res.headers)) headers.set(k, v);
  }
  if (res.status === 302) {
    return new Response(null, { status: 302, headers });
  }
  // 404 / 410 — surface a tiny plaintext body so curl users see a
  // helpful hint without enumerating account details.
  return new Response(
    res.status === 410 ? "this short link was rotated; ask the sender for a fresh one" : "not found",
    {
      status: res.status,
      headers: { "content-type": "text/plain", "cache-control": "private, no-store" },
    },
  );
}

async function serveRecovery(
  request: Request,
  url: URL,
  env: RouteEnv,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return withRecoveryHeaders(
      new Response(
        JSON.stringify({ error: "method not allowed", host: RECOVERY_HOST }),
        { status: 405, headers: { "content-type": "application/json", allow: "GET, HEAD" } },
      ),
    );
  }
  // Disk layout:  apps/web/public/recovery/<file>
  // Public root:  /           → ASSETS /recovery/  (binding serves index.html)
  // Public path:  /<file>     → ASSETS /recovery/<file>
  const rewrittenPath = url.pathname === "/" ? "/recovery/" : `/recovery${url.pathname}`;
  const rewritten = new URL(rewrittenPath + url.search, "https://flagshipserver.com");
  const assetReq = new Request(rewritten.toString(), {
    method,
    headers: request.headers,
  });
  const asset = await env.ASSETS.fetch(assetReq);
  return withRecoveryHeaders(asset);
}

/**
 * Wrap a Response with the strict-CSP + framing-protection headers used
 * on the recovery sub-origin. Asset-binding responses come back with
 * immutable headers; we copy into a fresh Response to attach ours.
 */
function withRecoveryHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", RECOVERY_CSP);
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  // Recovery is a one-shot interactive flow; never let an intermediary
  // cache the HTML and serve a stale-credential version to a different
  // user. Static assets (favicon, fonts) can still cache via their own
  // headers — we only set this on the wrapped Response, which the asset
  // binding may override with its own asset-level cache directives.
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Pre-launch stealth gate.
 *
 * - WIP_PREVIEW_COOKIE: set by `/wip_` so that a tester who lands on the
 *   preview path can navigate the real marketing surface (links from
 *   the original landing point at un-prefixed paths like /faq.html).
 *   Path=/ so it covers every apex path; SameSite=Lax keeps it off
 *   third-party iframes; Max-Age caps the bypass at 7 days.
 * - COMING_SOON_EXEMPT_PATHS / COMING_SOON_EXEMPT_PREFIXES: paths that
 *   reach the static-asset fallback but must always serve their real
 *   content (favicon, AT icon, the coming-soon page itself, /404.html,
 *   `/.well-known/*` for security.txt and friends).
 */
const WIP_PREVIEW_COOKIE_NAME = "flagship_preview";
const WIP_PREVIEW_COOKIE = `${WIP_PREVIEW_COOKIE_NAME}=1; Path=/; SameSite=Lax; Max-Age=604800`;
// Original stealth path. `/alpha` is a friendlier public-facing alias —
// `/wip_` looked unserious in shared links. Both behave identically and
// `/wip_` stays so links already in the wild don't break.
const WIP_PREFIX = "/wip_";
const WIP_PREFIXES = [WIP_PREFIX, "/alpha"] as const;
const COMING_SOON_PATH = "/coming-soon.html";

/**
 * Return the preview prefix the pathname is under, or null.
 *
 * A prefix matches only on an exact hit (`/alpha`) or a true segment
 * boundary (`/alpha/...`) — `/alphabet` and `/wipx` are NOT previews
 * and stay behind the coming-soon gate.
 */
function matchedPreviewPrefix(pathname: string): string | null {
  for (const p of WIP_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`)) return p;
  }
  return null;
}

const COMING_SOON_EXEMPT_PATHS = new Set<string>([
  COMING_SOON_PATH,
  "/favicon.svg",
  "/apple-touch-icon.svg",
  "/404.html",
  "/robots.txt",
]);
const COMING_SOON_EXEMPT_PREFIXES = ["/.well-known/"];

function hasPreviewCookie(request: Request): boolean {
  const header = request.headers.get("cookie");
  if (!header) return false;
  for (const part of header.split(/;\s*/)) {
    const [name, value] = part.split("=");
    if (name === WIP_PREVIEW_COOKIE_NAME && value === "1") return true;
  }
  return false;
}

function isComingSoonExempt(pathname: string): boolean {
  if (COMING_SOON_EXEMPT_PATHS.has(pathname)) return true;
  for (const p of COMING_SOON_EXEMPT_PREFIXES) {
    if (pathname.startsWith(p)) return true;
  }
  return false;
}

/**
 * Serve the coming-soon page. The asset binding holds the HTML at
 * /coming-soon.html; we fetch it through the binding so any future
 * branding tweak is a pure static-file change.
 *
 * `cache-control: no-store` so the moment the gate is lifted the
 * cached preview doesn't linger in clients.
 */
async function serveComingSoon(env: RouteEnv): Promise<Response> {
  const upstream = await env.ASSETS.fetch(
    new Request(`https://flagshipserver.com${COMING_SOON_PATH}`),
  );
  const headers = new Headers(upstream.headers);
  if (!headers.get("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, {
    status: 200,
    statusText: "OK",
    headers,
  });
}

/**
 * `/wip_` / `/alpha` and their `/<path>` subpaths serve the real
 * marketing assets. The matched `prefix` is stripped before handing
 * off to the asset binding so the underlying file tree is unchanged —
 * `/alpha/faq.html` reads from apps/web/public/faq.html.
 *
 * Sets the preview cookie on the response so the next navigation
 * (to un-prefixed paths the original index.html links at) bypasses
 * the coming-soon gate too. Without this the tester would land back
 * on coming-soon as soon as they clicked any link.
 */
async function serveWipPreview(
  request: Request,
  url: URL,
  env: RouteEnv,
  prefix: string,
): Promise<Response> {
  const tail = url.pathname.slice(prefix.length); // "" or "/X"
  const realPath = !tail || tail === "/" ? "/" : tail;
  const rewritten = new URL(realPath + url.search, "https://flagshipserver.com");
  const assetReq = new Request(rewritten.toString(), {
    method: request.method,
    headers: request.headers,
  });
  const upstream = await env.ASSETS.fetch(assetReq);
  const headers = new Headers(upstream.headers);
  headers.append("set-cookie", WIP_PREVIEW_COOKIE);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export const _internal = {
  PROXY_PREFIX,
  STATUS_PROBE_PATH,
  STATUS_RELAY_PATH,
  BUILD_ISO_INFO_PATH,
  HEALTH_PATH,
  SERVICES_ENDPOINTS_PATH,
  BUILD_ISO_STREAM_PREFIX,
  BUILD_RELAY_SESSIONS_PATH,
  QR_PIPE_WS_PREFIX,
  DEFAULT_BASE_ISO_URL,
  DEFAULT_BASE_ISO_VERSION,
  DEFAULT_TUNNEL_HUB_URL,
  SERVICES_ENDPOINTS_VERSION,
  STRIP_REQ_HEADERS,
  STRIP_RES_HEADERS,
  WEBAPP_HOST,
  WEBAPP_ORIGIN,
  RECOVERY_HOST,
  RECOVERY_ORIGIN,
  RECOVERY_CSP,
  WIP_PREFIX,
  WIP_PREFIXES,
  WIP_PREVIEW_COOKIE_NAME,
  COMING_SOON_PATH,
};
