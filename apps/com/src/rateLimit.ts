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
  | "username-suggest"
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
  // Watch delegate keys (Phase 2c) — same shape as device grants:
  //   list is a public read (per-IP); mint + revoke are IRK-signed but the
  //   wire shape doesn't expose the IRK pub at edge speed, so per-IP only.
  | "watch-delegates-list"
  | "watch-delegates-revoke"
  | "watch-delegates-mint"
  // Per-user-cert ACME account-key grants + mint-reservation lease. Same
  // shape as watch delegates: list is a public read (per-IP); the mutating
  // paths are signed but the wire shape doesn't expose the signer pub at
  // edge speed, so per-IP only. The reservation acquire/release are hotter
  // (a minter may poll across a renewal cycle), so they get a slightly more
  // generous per-IP budget than the one-shot grant mint/revoke.
  | "acme-account-keys-list"
  | "acme-account-keys-revoke"
  | "acme-account-keys-mint"
  // #28 Option B — seal-to-box ACME account-key DELIVERY (deposit / release /
  // revoke). Distinct from the per-admin-device grant mint above: a box has no
  // session at boot, so the deposit is IRK-signed (per-IRK + per-IP, like a
  // grant mint) but the RELEASE is a PUBLIC box poll (per-IP only, generous —
  // a box may poll a few times across a boot). The delivery-revoke is IRK-signed.
  | "acme-key-deposit"
  // Desktop-burner base-ISO manifest poll. Public (the burner has no
  // session) + unsigned, so per-IP only. The burner calls this once per
  // launch; 30/min is generous for a human relaunching while letting us
  // fence a tight-loop client.
  | "iso-manifest"
  // Canonical per-order provisioning-status POST (the box reports each phase
  // once to POST /api/order/<serial>/status). Public — keyed by the order
  // serial (a capability the phone + installer share), not a signature, so
  // per-IP only at the edge. A real install posts ~8 phases over a few
  // minutes; 30/min is generous while fencing a leaked-serial flood (the
  // handler also gates on the serial mapping to a real auth-code).
  | "provision-status"
  // #43 — IRK-signed list of the account's in-flight install orders (the
  // authority the phone reconciles its local pending-server cache against).
  // The body identifies the account by `request.username`, not the IRK pub,
  // so we throttle per-IP only at the edge; the handler does the full IRK
  // signature check under the registered key. The phone calls this on
  // account setup + each Home appearance, so the budget is generous.
  | "outstanding-orders"
  | "acme-key-release"
  | "acme-key-delivery-revoke"
  | "mint-reservation-acquire"
  | "mint-reservation-release"
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
  | "device-admit"
  // SEC-2 — STK-signed push relay. The body carries `request.targetUsername`,
  // not an IRK/STK pub at the edge, so we throttle per-IP only; the handler
  // does the full STK signature check against the target's registered boxes.
  // A real box relays an unlock-request a handful of times during a boot, so a
  // tight 10/min cap (with a 100/h ceiling) fences a spam loop while leaving
  // legitimate traffic headroom.
  | "push-relay"
  // SEC — IRK-signed push-token REVOKE (DELETE /api/push/<token-id>). The
  // envelope carries `request.tokenId`, not an IRK/STK pub at the edge, so
  // we throttle per-IP only; the handler does the full IRK signature check
  // against the token owner's registered key. A token-id-knower probing for
  // a valid signature, or replaying captured DELETEs, is fenced here.
  | "push-revoke"
  // SEC-3 — voi.ci short-code mint. Session-authenticated (IRK-signed body
  // keyed by `request.username`), so per-IP at the edge; conservative enough
  // that a valid session can't farm short codes into D1 in a loop.
  | "voici-shorten"
  // SEC-3 — LLM promo / BYOK-credit issuance. Tighter than voici (each issue
  // mints a scoped provider key + bumps the ledger), per-IP at the edge.
  | "llm-promo-issue"
  // C3 — NFC rendezvous deposit/consume. Unauthenticated at this layer
  // (the blob is AEAD-sealed under K_session), so the surface is
  // throttled per-IP + per-rendezvousId. Deposits are heavier (full
  // 8 KB blob) and ought to fire once; consume is light (the box may
  // poll a handful of times before the deposit lands).
  | "nfc-rendezvous-deposit"
  | "nfc-rendezvous-consume";

interface AxisLimit {
  axis: "ip" | "irk" | "usernameHash" | "rendezvousId";
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
  // Coarse abuse backstop for the suggestion endpoint. The honest-user
  // escalating cooldown is the per-device throttle in control-plane; this just
  // caps a single IP draining/polling the queue (device keys are free to mint).
  "username-suggest": [
    { axis: "ip", limit: 30, windowSec: 60 },
    { axis: "ip", limit: 200, windowSec: 3600 },
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
  "watch-delegates-list": [{ axis: "ip", limit: 60, windowSec: 60 }],
  "watch-delegates-revoke": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "irk", limit: 20, windowSec: 3600 },
  ],
  "watch-delegates-mint": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "irk", limit: 50, windowSec: 3600 },
  ],
  // Per-user-cert ACME account-key grants + mint-reservation lease.
  "acme-account-keys-list": [{ axis: "ip", limit: 60, windowSec: 60 }],
  "acme-account-keys-revoke": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "irk", limit: 20, windowSec: 3600 },
  ],
  "acme-account-keys-mint": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "irk", limit: 50, windowSec: 3600 },
  ],
  // #28 Option B — seal-to-box ACME account-key delivery. Deposit mirrors a
  // grant mint (IRK 50/h + IP 10/min). Release is a PUBLIC box poll — per-IP
  // only, generous (120/min) since a box may poll a few times across a boot.
  // Delivery-revoke is a one-shot kill switch (IRK 20/h + IP 10/min).
  "acme-key-deposit": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "irk", limit: 50, windowSec: 3600 },
  ],
  "acme-key-release": [{ axis: "ip", limit: 120, windowSec: 60 }],
  // Desktop-burner base-ISO manifest poll. Per-IP only (no session, no
  // signed body). 30/min is plenty for once-per-launch; the cap fences a
  // tight-loop client from hammering the route.
  "iso-manifest": [{ axis: "ip", limit: 30, windowSec: 60 }],
  // Canonical per-order provisioning-status POST. Per-IP only (no signed
  // body); 30/min covers a real install's ~8 phases with headroom while
  // fencing a tight-loop / leaked-serial flood.
  "provision-status": [{ axis: "ip", limit: 30, windowSec: 60 }],
  // #43 — outstanding-orders reconcile read. Per-IP only (the body carries
  // `request.username`, not the IRK pub). 60/min is generous for a phone
  // refreshing Home; the cap fences a tight-loop client.
  "outstanding-orders": [{ axis: "ip", limit: 60, windowSec: 60 }],
  "acme-key-delivery-revoke": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "irk", limit: 20, windowSec: 3600 },
  ],
  // The reservation lease is polled across a renewal cycle by a minter, so
  // the per-IP budget is more generous than a one-shot grant mint. Per-IP
  // only — the lease claim is holder-signed but the wire shape doesn't
  // expose a registered IRK pub at edge speed (the handler does the full
  // signature + requireMinter check).
  "mint-reservation-acquire": [{ axis: "ip", limit: 60, windowSec: 60 }],
  "mint-reservation-release": [{ axis: "ip", limit: 60, windowSec: 60 }],
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
  // SEC-2 — STK-signed push relay. Per-IP only (no signer pub at the edge).
  // 10/min covers a box re-asking for an unlock approval across a boot; the
  // 100/h ceiling fences a sustained spam loop.
  "push-relay": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "ip", limit: 100, windowSec: 3600 },
  ],
  // SEC — IRK-signed push-token revoke. Per-IP only (the IRK pub isn't on
  // the wire at edge speed; the body carries `request.tokenId`). A human
  // revokes a handful of devices; 10/min + 100/h fences a signature-probe
  // or replay loop while leaving legitimate cleanup headroom.
  "push-revoke": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "ip", limit: 100, windowSec: 3600 },
  ],
  // SEC-3 — voi.ci short-code mint. Per-IP (the IRK pub isn't on the wire at
  // edge speed; the body carries `request.username`). 10/min + 100/h matches
  // the conservative budget in the finding — enough for a human sharing a few
  // links, tight enough to stop D1-bloat farming.
  "voici-shorten": [
    { axis: "ip", limit: 10, windowSec: 60 },
    { axis: "ip", limit: 100, windowSec: 3600 },
  ],
  // SEC-3 — LLM promo / BYOK-credit issuance. Tighter: 5/h per-IP (token
  // farming is the concern, and a legitimate client issues rarely).
  "llm-promo-issue": [{ axis: "ip", limit: 5, windowSec: 3600 }],
  // C3 — NFC tap-to-pair cloud rendezvous. The per-IP cap stops a
  // tight-loop attacker from spraying slot deposits; the per-slot cap
  // bounds collateral when a single rendezvousId is fuzzed (a real
  // re-tap on the phone re-uses the same slot — 30 deposits/min is
  // generous for that legitimate workload). Consumes are looser since
  // the box may poll a handful of times before the deposit lands.
  "nfc-rendezvous-deposit": [
    { axis: "ip", limit: 30, windowSec: 60 },
    { axis: "rendezvousId", limit: 10, windowSec: 60 },
  ],
  "nfc-rendezvous-consume": [
    { axis: "ip", limit: 60, windowSec: 60 },
    { axis: "rendezvousId", limit: 30, windowSec: 60 },
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
  /** C3 — opaque rendezvous slot id from the NFC tap-to-pair URL. */
  rendezvousId?: string;
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
  if (axis === "rendezvousId") return input.rendezvousId ?? null;
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
  if (m === "POST" && pathname === "/api/username/suggest") return "username-suggest";
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
  // Watch delegate keys (Phase 2c). Same ordering: `/revoke` before the bare.
  if (
    m === "POST" &&
    /^\/api\/users\/[^/]+\/watch-delegates\/revoke$/.test(pathname)
  ) {
    return "watch-delegates-revoke";
  }
  if (m === "GET" && /^\/api\/users\/[^/]+\/watch-delegates$/.test(pathname)) {
    return "watch-delegates-list";
  }
  if (m === "POST" && /^\/api\/users\/[^/]+\/watch-delegates$/.test(pathname)) {
    return "watch-delegates-mint";
  }
  // Per-user-cert ACME account-key grants. Same ordering: `/revoke` before bare.
  if (
    m === "POST" &&
    /^\/api\/users\/[^/]+\/acme-account-keys\/revoke$/.test(pathname)
  ) {
    return "acme-account-keys-revoke";
  }
  if (m === "GET" && /^\/api\/users\/[^/]+\/acme-account-keys$/.test(pathname)) {
    return "acme-account-keys-list";
  }
  if (m === "POST" && /^\/api\/users\/[^/]+\/acme-account-keys$/.test(pathname)) {
    return "acme-account-keys-mint";
  }
  // #28 Option B — seal-to-box ACME account-key delivery. ONE path
  // (`/api/server/<domain>/acme-account-key`, singular — distinct from the
  // plural per-user grant routes above) discriminated by method.
  if (/^\/api\/server\/[^/]+\/acme-account-key$/.test(pathname)) {
    if (m === "POST") return "acme-key-deposit";
    if (m === "GET") return "acme-key-release";
    if (m === "DELETE") return "acme-key-delivery-revoke";
  }
  // Per-user-cert mint-reservation lease. `/release` before the bare acquire.
  if (
    m === "POST" &&
    /^\/api\/users\/[^/]+\/mint-reservation\/release$/.test(pathname)
  ) {
    return "mint-reservation-release";
  }
  if (
    m === "POST" &&
    /^\/api\/users\/[^/]+\/mint-reservation$/.test(pathname)
  ) {
    return "mint-reservation-acquire";
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
  // Desktop-burner base-ISO manifest poll.
  if (m === "POST" && pathname === "/api/iso-manifest") {
    return "iso-manifest";
  }
  // Canonical per-order provisioning-status POST. (The GET read isn't rate-
  // limited here — only the mutating POST the box hits.)
  if (m === "POST" && /^\/api\/order\/[^/]+\/status$/.test(pathname)) {
    return "provision-status";
  }
  // #43 — IRK-signed outstanding-orders reconcile read (POST-with-signed-body).
  if (
    m === "POST" &&
    /^\/api\/users\/[^/]+\/outstanding-orders$/.test(pathname)
  ) {
    return "outstanding-orders";
  }
  // SEC-2 — STK-signed push relay.
  if (m === "POST" && pathname === "/api/push/relay") {
    return "push-relay";
  }
  // SEC — IRK-signed push-token revoke. DELETE /api/push/<token-id>. The
  // `relay` and `register` sub-paths are matched above / are POSTs, so a
  // DELETE on /api/push/<id> is unambiguously the revoke.
  if (m === "DELETE" && /^\/api\/push\/[^/]+$/.test(pathname)) {
    return "push-revoke";
  }
  // SEC-3 — voi.ci short-code mint + LLM-promo issuance.
  if (m === "POST" && pathname === "/api/voici/shorten") {
    return "voici-shorten";
  }
  if (m === "POST" && pathname === "/api/llm-promo/issue") {
    return "llm-promo-issue";
  }
  // C3 — NFC tap-to-pair rendezvous (cloud drop-box).
  if (/^\/api\/nfc\/rendezvous\/[^/]+\/wifi$/.test(pathname)) {
    if (m === "POST") return "nfc-rendezvous-deposit";
    if (m === "GET") return "nfc-rendezvous-consume";
  }
  return null;
}

/** Pull the rendezvousId out of the NFC tap-to-pair rendezvous path. */
export function extractRendezvousId(pathname: string): string | undefined {
  const m = pathname.match(/^\/api\/nfc\/rendezvous\/([^/]+)\/wifi$/);
  return m ? decodeURIComponent(m[1]!) : undefined;
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
  } else if (
    endpoint === "watch-delegates-mint" ||
    endpoint === "watch-delegates-revoke"
  ) {
    // Watch delegates mirror device grants: the wire shape identifies the
    // user by `grant.username` / `request.username`, not by IRK pub. Per-IP
    // suffices at the edge; the handler does the full IRK signature check.
    candidate = undefined;
  } else if (
    endpoint === "acme-account-keys-mint" ||
    endpoint === "acme-account-keys-revoke" ||
    endpoint === "acme-key-deposit" ||
    endpoint === "acme-key-delivery-revoke"
  ) {
    // Per-user-cert ACME account-key grants + #28 seal-to-box delivery mirror
    // device grants / watch delegates: the wire shape carries `grant.username`
    // / `request.username`, not the IRK pub. Per-IP suffices at the edge; the
    // handler does the full IRK signature check. (acme-key-release is a public
    // box poll — never reaches here; it's per-IP only by its LIMITS entry.)
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

/**
 * Per-IP gate on /burner-pipe upgrades — same DO-spawn concern as the QR
 * relay (each accepted upgrade materialises a Durable Object). Reuses the
 * `RATE_LIMITER_QR_PIPE` binding with a DISTINCT key prefix so the two
 * budgets are independent without provisioning a second namespace. Fails
 * open when the binding is absent (dev / tests), matching the module's
 * posture for missing bindings.
 */
export async function checkBurnerPipeUpgrade(
  env: RateLimitEnv,
  ip: string | null,
): Promise<RateLimitedResult | AllowedResult> {
  if (!env.RATE_LIMITER_QR_PIPE) return { limited: false };
  if (!ip) return { limited: false };
  const key = `burner-pipe-upgrade|ip|${ip}`;
  const outcome = await env.RATE_LIMITER_QR_PIPE.limit({ key });
  if (!outcome.success) {
    return {
      limited: true,
      endpoint: "burner-pipe-upgrade",
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
