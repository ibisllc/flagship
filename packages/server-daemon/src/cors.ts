import type { HttpRequest, HttpResponse } from "./runtime.js";

/**
 * CORS for the daemon's OWN `/api/*` surface.
 *
 * The browser webapp lives on a DIFFERENT origin from the box: it is
 * served at `web.<control-apex>` (prod `web.flagshipserver.com`, the gym
 * `web.gym.flagshipserver.com`) and calls the box directly at the box's own
 * origin (`<server>.<user>.flagship.services`) for `/api/screens/*`,
 * `/api/journal`, `/api/front-page`, `/api/services`, `/api/power`, … Those
 * are cross-origin requests, so without `Access-Control-Allow-Origin` the
 * browser blocks the response.
 *
 * The data/services apex (`flagship.services`) has no structural relationship
 * to the control apex (`flagshipserver.com` — a different registrable
 * domain), so the webapp origin isn't derivable from the box's FQDN. We allow
 * the two known webapp origins explicitly (mirroring the control plane's
 * `isCorsAllowed` allow-list in `apps/com/src/route.ts`).
 *
 * This is scoped to the daemon's own `/api/*` surface only. The per-service
 * app-proxy path (`serviceProxy` / `<label>.<server>.<user>`) serves the
 * user's own apps and is deliberately NOT touched here — those origins must
 * keep their own (absent) CORS posture.
 *
 * No `Access-Control-Allow-Credentials`: Flagship auth is signed envelopes /
 * headers, never cookies.
 */
const WEBAPP_ORIGINS: ReadonlySet<string> = new Set([
  "https://web.flagshipserver.com",
  "https://web.gym.flagshipserver.com",
]);

/** Every custom request header the webapp sends to the box, lower-cased. */
const ALLOW_HEADERS = "content-type, x-flagship-session, x-flagship-owner-irk, authorization";
const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const MAX_AGE = "600";

/** Normalise an Origin header to `scheme://host`, or null when absent/invalid. */
function normaliseOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Is this Origin an allowed webapp origin? */
export function isWebappOrigin(origin: string): boolean {
  return WEBAPP_ORIGINS.has(origin);
}

/** The Origin header off a request, normalised; null if missing/invalid. */
export function requestOrigin(req: HttpRequest): string | null {
  return normaliseOrigin(req.headers["origin"]);
}

/** Only the daemon's own API surface is CORS-eligible. */
function isApiPath(path: string): boolean {
  const p = path.split("?")[0] ?? path;
  return p === "/api" || p.startsWith("/api/");
}

/**
 * Answer an OPTIONS preflight for an allowed webapp origin WITHOUT running
 * the real handler/auth. Returns null when this isn't a preflight we own
 * (wrong method, non-`/api/*` path, or a disallowed/absent origin) so the
 * caller falls through to normal handling.
 */
export function corsPreflight(req: HttpRequest): HttpResponse | null {
  if (req.method.toUpperCase() !== "OPTIONS") return null;
  if (!isApiPath(req.path)) return null;
  const origin = requestOrigin(req);
  if (!origin || !isWebappOrigin(origin)) return null;
  return {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      vary: "origin",
      "access-control-allow-methods": ALLOW_METHODS,
      "access-control-allow-headers": ALLOW_HEADERS,
      "access-control-max-age": MAX_AGE,
    },
    body: "",
  };
}

/**
 * Echo CORS headers onto a `/api/*` response when the request carries an
 * allowed webapp Origin. A no-op for same-origin requests (no Origin), for
 * non-`/api/*` paths, and for any other origin (no `Access-Control-Allow-Origin`
 * is emitted — the browser then blocks the read, as intended).
 */
export function withCors(req: HttpRequest, res: HttpResponse): HttpResponse {
  if (!isApiPath(req.path)) return res;
  const origin = requestOrigin(req);
  if (!origin || !isWebappOrigin(origin)) return res;
  return {
    ...res,
    headers: {
      ...(res.headers ?? {}),
      "access-control-allow-origin": origin,
      vary: "origin",
      "access-control-allow-methods": ALLOW_METHODS,
      "access-control-allow-headers": ALLOW_HEADERS,
      "access-control-max-age": MAX_AGE,
    },
  };
}

export const _corsInternal = {
  WEBAPP_ORIGINS,
  ALLOW_HEADERS,
  ALLOW_METHODS,
  MAX_AGE,
};
