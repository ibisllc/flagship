/**
 * Rate-limit layer for the four mutating control-plane endpoints.
 *
 *   POST   /api/username/claim                 5/h per-IP, 1/min per-IRK
 *   POST   /api/auth-code/issue                20/h per-IP, 10/h per-IRK
 *   POST   /api/server/register                10/h per-IP, 5/h per-IRK
 *   GET    /api/recovery/by-username/<hash>    10/h per-IP, 3 per 15min per usernameHash
 *   DELETE /api/recovery/by-username/<hash>    same as GET (pre-auth)
 *
 * Each endpoint is checked along two independent axes (IP + IRK, or IP
 * + usernameHash for recovery). If *either* axis trips its threshold,
 * we return 429 with `Retry-After`. The two axes are independently
 * counted: a flood from one IP exhausts that IP's budget but doesn't
 * affect a different IP, and the same is true per-IRK.
 *
 * Why one binding, multiple keys: Cloudflare's RATE_LIMITER namespace
 * carries a single (period, limit) configured at the binding level.
 * Encoding (endpoint, axis, identifier) into the `key` lets us share
 * one namespace across axes. The deployed binding is configured to
 * the *tightest* limit (recovery's 3-per-15min); for endpoints with
 * more generous budgets, we issue *fewer* `.limit()` calls — one per
 * window where the budget remains. Either approach lets a single
 * namespace fence multiple thresholds.
 *
 * The function returns a Response when limited and `null` when the
 * request is allowed through; callers wire this into `route()` *after*
 * body parsing so the IRK can be extracted from the signed request
 * payload before applying the per-IRK axis.
 */

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitEnv {
  /** Cloudflare RATE_LIMITER namespace binding (configured in wrangler.toml). */
  RATE_LIMITER?: RateLimitBinding;
  /**
   * Dedicated namespace for the /qr-pipe WebSocket upgrade endpoint
   * (Task P2 — bound DO spawn rate per IP). Configured with a much
   * higher threshold than the mutating control-plane namespace
   * because each legitimate landing-page visit may trigger one
   * spawn — and `pre-expire` renewals add ~1 per 4 minutes per
   * engaged tab.
   */
  RATE_LIMITER_QR_PIPE?: RateLimitBinding;
}

/** Endpoint identifier — drives the per-endpoint thresholds + 429 body. */
export type RateLimitEndpoint =
  | "username-claim"
  | "auth-code-issue"
  | "server-register"
  | "recovery-by-username"
  | "qr-pipe-upgrade"
  // v2 device-addressing (S3.3). The five buckets:
  //   admin-* are admin-bearer gated, so per-IP only — there's no
  //   per-IRK identifier on the admin side.
  //   device-grants-list is a public read; cheap + per-IP.
  //   device-grants-revoke is IRK-signed; per-IRK + per-IP.
  //   device-grants-mint is IRK-signed; per-IRK + per-IP.
  | "admin-claim-and-issue"
  | "admin-mint-device-grant"
  | "device-grants-list"
  | "device-grants-revoke"
  | "device-grants-mint"
  | "account-resolve"
  // "Cancel this device" on the install-progress page. Public (a demo
  // account is a no-auth capability), so per-IP only at the edge. Tight
  // so a captured demo name can't be used to flap a VPS in a loop; the
  // handler is idempotent + scoped to demo_users.
  | "demo-cancel"
  // Phase 3b — vouched cross-device admit. The body carries the admit
  // (admit.username + newDevicePubHex), not the account IRK pub, so we
  // throttle per-IP only; the handler does the full DeviceAdmit
  // signature check under the registered IRK. Mirrors auth-code-issue's
  // posture (a credential-bearing mutating POST).
  | "device-admit";

interface AxisLimit {
  axis: "ip" | "irk" | "usernameHash";
  /** Per-axis request budget. */
  limit: number;
  /** Window in seconds. */
  windowSec: number;
}

/**
 * Per-endpoint thresholds per the design-decisions table.
 *
 * The deployed binding's (period, limit) is configured separately in
 * wrangler.toml. These constants are the contract this module enforces
 * across both the binding-backed path and the in-Worker fallback used
 * by tests + small deployments that don't want a separate namespace.
 */
export const LIMITS: Record<RateLimitEndpoint, AxisLimit[]> = {
  "username-claim": [
    { axis: "ip", limit: 5, windowSec: 3600 },
    { axis: "irk", limit: 1, windowSec: 60 },
  ],
  "auth-code-issue": [
    { axis: "ip", limit: 20, windowSec: 3600 },
    { axis: "irk", limit: 10, windowSec: 3600 },
  ],
  "server-register": [
    { axis: "ip", limit: 10, windowSec: 3600 },
    { axis: "irk", limit: 5, windowSec: 3600 },
  ],
  "recovery-by-username": [
    { axis: "ip", limit: 10, windowSec: 3600 },
    { axis: "usernameHash", limit: 3, windowSec: 900 },
  ],
  // qr-pipe-upgrade is enforced through a dedicated namespace
  // binding (`RATE_LIMITER_QR_PIPE`) — no entry needed in the
  // general LIMITS table, but the discriminated-union completeness
  // forces a key here.
  "qr-pipe-upgrade": [{ axis: "ip", limit: 30, windowSec: 60 }],
  // v2 device-addressing (S3.3). Per-IP only for the admin tier
  // (admin-bearer already gates; the per-IP cap stops a credential-
  // theft from being used to mint a huge backlog of grants in tight
  // succession). The public read path is generous (60/min). Mutating
  // public paths get the same per-IP+per-IRK shape as auth-code-issue.
  "admin-claim-and-issue": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "ip", limit: 100, windowSec: 3600 },
  ],
  "admin-mint-device-grant": [
    { axis: "ip", limit: 30, windowSec: 60 },
    { axis: "ip", limit: 200, windowSec: 3600 },
  ],
  "device-grants-list": [{ axis: "ip", limit: 60, windowSec: 60 }],
  "device-grants-revoke": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "irk", limit: 20, windowSec: 3600 },
  ],
  "device-grants-mint": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "irk", limit: 50, windowSec: 3600 },
  ],
  // Login/join preflight. The per-IP axis caps username enumeration
  // (the main concern for a 200-always existence oracle); the per-
  // usernameHash axis blunts hammering a single name. Generous enough
  // for a real user retrying their own login.
  "account-resolve": [
    { axis: "ip", limit: 30, windowSec: 60 },
    { axis: "usernameHash", limit: 10, windowSec: 900 },
  ],
  // Cancel-this-device. Per-IP only (no IRK at the edge; demo is
  // capability-by-name). 6/min is plenty for a real tap-to-cancel; the
  // 30/h ceiling stops a flap loop.
  "demo-cancel": [
    { axis: "ip", limit: 6, windowSec: 60 },
    { axis: "ip", limit: 30, windowSec: 3600 },
  ],
  // Phase 3b — vouched cross-device admit. Per-IP only (the body has no
  // IRK pub at the edge). A real admin admits a handful of devices; the
  // tight 10/min cap stops a captured admit from being replay-flooded
  // before its 5-min freshness window closes, with a 100/h ceiling.
  "device-admit": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "ip", limit: 100, windowSec: 3600 },
  ],
};

export interface RateLimitInput {
  endpoint: RateLimitEndpoint;
  /** `CF-Connecting-IP` if present, else null. Mandatory for the ip axis. */
  ip: string | null;
  /** Hex IRK pubkey (extracted from the request body). */
  irkPub?: string;
  /** Username hash (last path segment) for the recovery endpoint. */
  usernameHash?: string;
}

export interface RateLimitedResult {
  limited: true;
  endpoint: RateLimitEndpoint;
  axis: AxisLimit["axis"];
  retryAfterSec: number;
}

export interface AllowedResult {
  limited: false;
}

/**
 * Apply rate-limit checks for an endpoint. Returns a `RateLimitedResult`
 * when any axis trips — the caller turns that into a 429 — or
 * `AllowedResult` when the request should proceed.
 *
 * If RATE_LIMITER isn't bound (e.g. local dev without the namespace),
 * this is a no-op: the design treats the binding as authoritative and
 * never short-circuits the request on a missing binding. Tests assert
 * both branches explicitly.
 */
export async function checkRateLimit(
  env: RateLimitEnv,
  input: RateLimitInput,
): Promise<RateLimitedResult | AllowedResult> {
  if (!env.RATE_LIMITER) return { limited: false };
  const axes = LIMITS[input.endpoint];
  for (const axis of axes) {
    const id = identifierFor(input, axis.axis);
    if (id === null) continue; // axis not applicable (e.g., missing IRK for unsigned endpoint)
    const key = `${input.endpoint}|${axis.axis}|${id}`;
    const outcome = await env.RATE_LIMITER.limit({ key });
    if (!outcome.success) {
      return {
        limited: true,
        endpoint: input.endpoint,
        axis: axis.axis,
        retryAfterSec: axis.windowSec,
      };
    }
  }
  return { limited: false };
}

function identifierFor(input: RateLimitInput, axis: AxisLimit["axis"]): string | null {
  if (axis === "ip") return input.ip;
  if (axis === "irk") return input.irkPub ?? null;
  if (axis === "usernameHash") return input.usernameHash ?? null;
  return null;
}

/**
 * Build the 429 response. Body shape matches the spec:
 *   { error: "rate-limited", endpoint: "<id>", limit: "<axis>" }
 *
 * `Retry-After` is the axis's window in seconds — the most accurate
 * upper bound we can give without exposing the binding's internal
 * counter state.
 */
export function rateLimitedResponse(result: RateLimitedResult): Response {
  return new Response(
    JSON.stringify({
      error: "rate-limited",
      endpoint: result.endpoint,
      limit: result.axis,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.retryAfterSec),
        // Don't let the edge serve a cached 429 to other clients —
        // each client must be reassessed against its own budget.
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * Map a (method, path) to the endpoint identifier we apply limits for.
 * Returns `null` for anything that isn't one of the four protected
 * routes — the caller passes those straight through.
 */
export function endpointFor(method: string, pathname: string): RateLimitEndpoint | null {
  const m = method.toUpperCase();
  if (m === "POST" && pathname === "/api/username/claim") return "username-claim";
  if (m === "POST" && pathname === "/api/auth-code/issue") return "auth-code-issue";
  if (m === "POST" && pathname === "/api/server/register") return "server-register";
  if (
    (m === "GET" || m === "DELETE") &&
    /^\/api\/recovery\/by-username\/[^/]+$/.test(pathname)
  ) {
    return "recovery-by-username";
  }
  // Task #74 — the Argon2id-gated wrappedUmk fetch sits under the same
  // budget as the metadata GET (3-per-15min per usernameHash). Combining
  // them keeps a passphrase-guesser from rotating between paths to
  // double their attempts.
  if (
    m === "POST" &&
    /^\/api\/recovery\/by-username\/[^/]+\/fetch$/.test(pathname)
  ) {
    return "recovery-by-username";
  }
  // v2 device-addressing (S3.3). Order matters: the longer `/revoke`
  // suffix must hit BEFORE the bare `/device-grants` literal.
  if (m === "POST" && pathname === "/api/dev/sample-user/admin-claim-and-issue") {
    return "admin-claim-and-issue";
  }
  if (
    m === "POST" &&
    /^\/api\/dev\/sample-user\/[^/]+\/admin-mint-device-grant$/.test(pathname)
  ) {
    return "admin-mint-device-grant";
  }
  if (
    m === "POST" &&
    /^\/api\/users\/[^/]+\/device-grants\/revoke$/.test(pathname)
  ) {
    return "device-grants-revoke";
  }
  if (m === "GET" && /^\/api\/users\/[^/]+\/device-grants$/.test(pathname)) {
    return "device-grants-list";
  }
  if (m === "POST" && /^\/api\/users\/[^/]+\/device-grants$/.test(pathname)) {
    return "device-grants-mint";
  }
  if (m === "GET" && /^\/api\/account\/resolve\/[^/]+$/.test(pathname)) {
    return "account-resolve";
  }
  if (
    m === "POST" &&
    /^\/api\/dev\/sample-user\/[^/]+\/cancel$/.test(pathname)
  ) {
    return "demo-cancel";
  }
  // Phase 3b — vouched cross-device admit.
  if (m === "POST" && /^\/api\/users\/[^/]+\/devices\/admit$/.test(pathname)) {
    return "device-admit";
  }
  return null;
}

/**
 * Pull the IRK pubkey hex out of a parsed request body. Each endpoint
 * keeps the IRK in a different slot — we accept the variation rather
 * than fighting it since the handlers themselves already know where
 * to look. Returns `undefined` if the body is missing/garbage; the
 * caller falls back to per-IP rate-limiting alone.
 *
 * The hex shape is sanity-checked but NOT fully Ed25519-validated —
 * a malformed value just produces a different rate-limit bucket. The
 * downstream handler does the proper signature verification.
 */
export function extractIrkPub(endpoint: RateLimitEndpoint, body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, any>;
  let candidate: unknown;
  if (endpoint === "username-claim") candidate = b.request?.irkPub;
  else if (endpoint === "auth-code-issue") candidate = b.code?.userPubKey;
  else if (endpoint === "server-register") candidate = b.request?.authCode?.userPubKey;
  else if (endpoint === "device-grants-mint") {
    // The grant body itself doesn't carry the user IRK pub directly —
    // the signer IS the user IRK, but the wire shape exposes the
    // grant's devicePubKey, not the IRK. Per-IRK throttling here
    // would need a username→IRK lookup we don't want at edge speed.
    // We fall back to per-IP (the bucket's first axis); the per-IRK
    // axis effectively no-ops when extractIrkPub returns undefined.
    candidate = undefined;
  } else if (endpoint === "device-grants-revoke") {
    // Same shape — the revoke envelope identifies the user by
    // `request.username`, not by IRK pub. Per-IP suffices at the
    // edge; the handler does the full IRK signature check.
    candidate = undefined;
  } else return undefined;
  return typeof candidate === "string" && /^[0-9a-fA-F]{64}$/.test(candidate)
    ? candidate.toLowerCase()
    : undefined;
}

/** Pull the username hash out of the recovery path (`/api/recovery/by-username/<hash>[/fetch]`). */
export function extractUsernameHash(pathname: string): string | undefined {
  const m =
    pathname.match(/^\/api\/recovery\/by-username\/([^/]+)$/) ??
    pathname.match(/^\/api\/recovery\/by-username\/([^/]+)\/fetch$/) ??
    pathname.match(/^\/api\/account\/resolve\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

/**
 * Bound `/qr-pipe` WebSocket upgrades per client IP. Each accepted
 * upgrade materialises a Durable Object that pays storage + alarm
 * overhead even with hibernation; unauthenticated /qr-pipe traffic
 * is what burned the DO free-tier duration before the hibernation
 * fix landed. Keep this generous enough for legitimate users (page
 * reloads, ~4-minute pre-expire renewals while engaged) and tight
 * enough that one source can't fan out thousands of DOs.
 *
 * Returns the same shape as `checkRateLimit` so callers can pipe
 * straight into `rateLimitedResponse`.
 *
 * The binding is keyed independently from the mutating-control-plane
 * RATE_LIMITER namespace so the two budgets don't fight; today this
 * is a separate `RATE_LIMITER_QR_PIPE` binding in wrangler.toml.
 *
 * When the binding isn't present (dev / tests that don't wire it),
 * this is a no-op — matching the rest of the rate-limit module's
 * "fail open" posture for missing bindings.
 */
export async function checkQrPipeUpgrade(
  env: RateLimitEnv,
  ip: string | null,
): Promise<RateLimitedResult | AllowedResult> {
  if (!env.RATE_LIMITER_QR_PIPE) return { limited: false };
  if (!ip) return { limited: false };
  const key = `qr-pipe-upgrade|ip|${ip}`;
  const outcome = await env.RATE_LIMITER_QR_PIPE.limit({ key });
  if (!outcome.success) {
    return {
      limited: true,
      endpoint: "qr-pipe-upgrade",
      axis: "ip",
      retryAfterSec: 60,
    };
  }
  return { limited: false };
}

/** Read the client IP from CF-Connecting-IP, falling back to X-Forwarded-For first hop. */
export function clientIp(request: Request): string | null {
  const cfip = request.headers.get("cf-connecting-ip");
  if (cfip) return cfip;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}
