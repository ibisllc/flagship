/**
 * Pure routing logic for the flagshipserver.com Cloudflare Worker.
 *
 * Two responsibilities:
 *   1. /api/*  →  reverse-proxy to flagship.services preserving method,
 *                 path+query, headers, and body.
 *   2. anything else → defer to the asset binding (Cloudflare's static edge).
 *
 * Extracted from the Worker entrypoint so it's directly unit-testable in
 * Node — no need for miniflare or a real edge runtime to exercise it.
 */

export interface RouteEnv {
  SERVICES_BASE_URL: string;
  /** The Worker assets binding. Tests pass a stub. */
  ASSETS: { fetch(req: Request): Promise<Response> };
}

const PROXY_PREFIX = "/api/";
const STATUS_PROBE_PATH = "/api/_status/probe";

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

  // Worker-resident probe: never forwarded upstream as-is. The Worker does
  // the timed fetch itself so /status/ shows what flagshipserver.com sees,
  // not what the user's browser sees.
  if (url.pathname === STATUS_PROBE_PATH) {
    return statusProbe(env);
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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
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

export const _internal = {
  PROXY_PREFIX,
  STATUS_PROBE_PATH,
  STRIP_REQ_HEADERS,
  STRIP_RES_HEADERS,
};
