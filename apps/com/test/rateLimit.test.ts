import { describe, expect, it, vi } from "vitest";
import {
  checkPipeUpgrade,
  checkRateLimit,
  clientIp,
  endpointFor,
  extractIrkPub,
  extractUsernameHash,
  rateLimitedResponse,
  LIMITS,
  type RateLimitEnv,
  type RateLimitNamespace,
} from "../src/rateLimit.js";
import { hitWindows } from "../src/rateLimitCounter.js";
import { route, type RouteEnv } from "../src/route.js";
import { memoryRateLimits } from "./rateLimitFakes.js";

/** Counters that answer by policy instead of counting (true = allow). */
function makeCounters(policy: (key: string, callsForKey: number) => boolean) {
  return memoryRateLimits({ policy });
}

function allowAll() {
  return makeCounters(() => true);
}

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (sec: number) => (t += sec * 1000) };
}

describe("rateLimit — endpoint detection", () => {
  it("matches the four protected endpoints", () => {
    expect(endpointFor("POST", "/api/username/claim")).toBe("username-claim");
    expect(endpointFor("POST", "/api/auth-code/issue")).toBe("auth-code-issue");
    expect(endpointFor("POST", "/api/server/register")).toBe("server-register");
    expect(endpointFor("GET", "/api/recovery/by-username/abc123")).toBe("recovery-by-username");
    expect(endpointFor("DELETE", "/api/recovery/by-username/abc123")).toBe("recovery-by-username");
  });

  it("maps the #28 seal-to-box ACME delivery endpoints by method", () => {
    const p = "/api/server/nas.dani.flagship.services/acme-account-key";
    expect(endpointFor("POST", p)).toBe("acme-key-deposit");
    expect(endpointFor("GET", p)).toBe("acme-key-release");
    expect(endpointFor("DELETE", p)).toBe("acme-key-delivery-revoke");
    // The release (public box poll) is per-IP only.
    expect(LIMITS["acme-key-release"]?.every((a) => a.axis === "ip")).toBe(true);
    // The singular delivery path must NOT collide with the plural per-user
    // grant routes.
    expect(endpointFor("POST", "/api/users/dani/acme-account-keys")).toBe(
      "acme-account-keys-mint",
    );
  });

  it("rate-limits the SEC-2 push relay + SEC-3 voici/llm-promo endpoints per-IP", () => {
    expect(endpointFor("POST", "/api/push/relay")).toBe("push-relay");
    expect(endpointFor("POST", "/api/voici/shorten")).toBe("voici-shorten");
    expect(endpointFor("POST", "/api/llm-promo/issue")).toBe("llm-promo-issue");
    // All three are per-IP only at the edge (no signer pub on the wire).
    expect(LIMITS["push-relay"]?.every((a) => a.axis === "ip")).toBe(true);
    expect(LIMITS["voici-shorten"]?.every((a) => a.axis === "ip")).toBe(true);
    expect(LIMITS["llm-promo-issue"]?.every((a) => a.axis === "ip")).toBe(true);
    // llm-promo is the tightest (token-farming concern).
    expect(LIMITS["llm-promo-issue"]?.[0]?.limit).toBe(5);
  });

  it("limits free AI token mints and status reads per-IP, but not the shim's allowance check", () => {
    expect(endpointFor("POST", "/api/free-ai/token")).toBe("free-ai");
    expect(endpointFor("POST", "/api/free-ai/status")).toBe("free-ai");
    expect(endpointFor("POST", "/api/free-ai/allowance")).toBeNull();
    expect(LIMITS["free-ai"]?.every((a) => a.axis === "ip")).toBe(true);
  });

  it("rate-limits the IRK-signed push-token revoke per-IP", () => {
    expect(endpointFor("DELETE", "/api/push/0123456789abcdef")).toBe("push-revoke");
    expect(LIMITS["push-revoke"]?.every((a) => a.axis === "ip")).toBe(true);
    // The relay + register sub-paths are POSTs, so a DELETE there is still
    // the revoke; and a DELETE on /api/push/relay shouldn't slip through as
    // a "token id" of `relay` for any other endpoint.
    expect(endpointFor("POST", "/api/push/register")).not.toBe("push-revoke");
    expect(endpointFor("POST", "/api/push/relay")).not.toBe("push-revoke");
  });

  it("returns null for unrelated routes (no false-positive rate limits)", () => {
    expect(endpointFor("GET", "/api/health")).toBeNull();
    expect(endpointFor("GET", "/api/username/harry")).toBeNull();
    expect(endpointFor("GET", "/api/recovery")).toBeNull();
  });

  it("methods are case-insensitive", () => {
    expect(endpointFor("post", "/api/username/claim")).toBe("username-claim");
  });
});

describe("rateLimit — checkRateLimit", () => {
  it("is a no-op when the RATE_LIMITS namespace isn't bound", async () => {
    const env: RateLimitEnv = {};
    const r = await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" });
    expect(r.limited).toBe(false);
  });

  it("applies the table's own limit and window: 5 per hour per IP for username-claim", async () => {
    const c = clock();
    const { ns } = memoryRateLimits({ now: c.now });
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" })).limited).toBe(false);
      c.advance(60);
    }
    const sixth = await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" });
    expect(sixth.limited).toBe(true);
    if (sixth.limited) {
      expect(sixth.axis).toBe("ip");
      expect(sixth.endpoint).toBe("username-claim");
      // The first request leaves the hour 3300 s after this one.
      expect(sixth.retryAfterSec).toBe(3600 - 5 * 60);
    }
    c.advance(3600 - 5 * 60);
    expect((await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" })).limited).toBe(false);
  });

  it("counts a 15-minute budget across the whole window, not per minute", async () => {
    const c = clock();
    const { ns } = memoryRateLimits({ now: c.now });
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    const hit = (ip: string) =>
      checkRateLimit(env, { endpoint: "recovery-by-username", ip, usernameHash: "h" });
    for (let i = 0; i < 3; i++) {
      expect((await hit(`10.0.0.${i}`)).limited).toBe(false);
      c.advance(120);
    }
    const fourth = await hit("10.0.0.9");
    expect(fourth.limited).toBe(true);
    if (fourth.limited) expect(fourth.axis).toBe("usernameHash");
    c.advance(900 - 3 * 120);
    expect((await hit("10.0.0.10")).limited).toBe(false);
  });

  it("keeps refused requests out of the count", async () => {
    const c = clock();
    const { ns } = memoryRateLimits({ now: c.now });
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(env, { endpoint: "recovery-by-username", ip: `10.0.1.${i}`, usernameHash: "x" });
    }
    for (let i = 0; i < 20; i++) {
      c.advance(10);
      await checkRateLimit(env, { endpoint: "recovery-by-username", ip: `10.0.2.${i}`, usernameHash: "x" });
    }
    c.advance(900 - 200);
    expect(
      (await checkRateLimit(env, { endpoint: "recovery-by-username", ip: "10.0.3.1", usernameHash: "x" })).limited,
    ).toBe(false);
  });

  it("keys one counter per endpoint, axis and identifier", async () => {
    const { ns, calls } = allowAll();
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" });
    await checkRateLimit(env, { endpoint: "auth-code-issue", ip: "1.2.3.4" });
    expect(calls).toContain("username-claim|ip|1.2.3.4");
    expect(calls).toContain("auth-code-issue|ip|1.2.3.4");
  });

  it("checks both windows of one axis in a single counter", async () => {
    const c = clock();
    const { ns, calls } = memoryRateLimits({ now: c.now });
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    for (let i = 0; i < 30; i++) {
      expect((await checkRateLimit(env, { endpoint: "username-suggest", ip: "1.2.3.4" })).limited).toBe(false);
    }
    expect(new Set(calls)).toEqual(new Set(["username-suggest|ip|1.2.3.4"]));
    // 30 a minute trips first ...
    expect((await checkRateLimit(env, { endpoint: "username-suggest", ip: "1.2.3.4" })).limited).toBe(true);
    // ... and 200 an hour holds across minutes.
    for (let m = 0; m < 6; m++) {
      c.advance(61);
      for (let i = 0; i < 30; i++) await checkRateLimit(env, { endpoint: "username-suggest", ip: "1.2.3.4" });
    }
    c.advance(61);
    const r = await checkRateLimit(env, { endpoint: "username-suggest", ip: "1.2.3.4" });
    expect(r.limited).toBe(true);
    if (r.limited) expect(r.retryAfterSec).toBeGreaterThan(60);
  });

  it("counts different IPs independently", async () => {
    const { ns } = memoryRateLimits();
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    for (let i = 0; i < 5; i++) await checkRateLimit(env, { endpoint: "username-claim", ip: "1.1.1.1" });
    expect((await checkRateLimit(env, { endpoint: "username-claim", ip: "1.1.1.1" })).limited).toBe(true);
    expect((await checkRateLimit(env, { endpoint: "username-claim", ip: "2.2.2.2" })).limited).toBe(false);
  });

  it("counts different IRKs independently", async () => {
    const { ns } = memoryRateLimits();
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    const claim = (ip: string, irkPub: string) => checkRateLimit(env, { endpoint: "username-claim", ip, irkPub });
    expect((await claim("1.1.1.1", "aa".repeat(32))).limited).toBe(false);
    const again = await claim("2.2.2.2", "aa".repeat(32));
    expect(again.limited).toBe(true);
    if (again.limited) expect(again.axis).toBe("irk");
    expect((await claim("3.3.3.3", "bb".repeat(32))).limited).toBe(false);
  });

  it("skips the IRK axis when irkPub is not supplied (unsigned recovery endpoint case)", async () => {
    const { ns, calls } = allowAll();
    await checkRateLimit({ RATE_LIMITS: ns }, {
      endpoint: "recovery-by-username",
      ip: "1.2.3.4",
      usernameHash: "deadbeef",
    });
    expect(calls.some((k) => k.includes("|ip|"))).toBe(true);
    expect(calls.some((k) => k.includes("|usernameHash|"))).toBe(true);
    expect(calls.some((k) => k.includes("|irk|"))).toBe(false);
  });

  it("skips the ip axis when ip is null (defensive — never crashes)", async () => {
    const { ns, calls } = allowAll();
    await checkRateLimit({ RATE_LIMITS: ns }, { endpoint: "username-claim", ip: null });
    expect(calls.some((k) => k.startsWith("username-claim|ip|"))).toBe(false);
  });

  it("scales every limit by RATE_LIMIT_SCALE", async () => {
    const { ns } = memoryRateLimits();
    const env: RateLimitEnv = { RATE_LIMITS: ns, RATE_LIMIT_SCALE: "3" };
    for (let i = 0; i < 15; i++) {
      expect((await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" })).limited).toBe(false);
    }
    expect((await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" })).limited).toBe(true);
  });

  it("ignores a scale below 1 or not a number", async () => {
    for (const scale of ["0.1", "abc", ""]) {
      const { ns } = memoryRateLimits();
      const env: RateLimitEnv = { RATE_LIMITS: ns, RATE_LIMIT_SCALE: scale };
      for (let i = 0; i < 5; i++) await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" });
      expect((await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" })).limited).toBe(true);
    }
  });

  it("refuses secret-guessing endpoints when the counter is unreachable, passes the rest", async () => {
    const { ns } = memoryRateLimits({ fail: true });
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const endpoint of ["recovery-by-username", "re-pair-initiate", "totp-verify"] as const) {
        const r = await checkRateLimit(env, { endpoint, ip: "1.2.3.4", usernameHash: "u" });
        expect(r.limited, endpoint).toBe(true);
      }
      expect((await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" })).limited).toBe(false);
    } finally {
      err.mockRestore();
    }
  });
});

describe("rateLimit — the counter's sliding log", () => {
  it("frees one slot as each request leaves the window", () => {
    const rules = [{ limit: 2, windowSec: 10 }];
    let logs = {};
    for (const t of [0, 3000]) logs = hitWindows(logs, rules, t).logs;
    const refused = hitWindows(logs, rules, 5000);
    expect(refused.result).toEqual({ ok: false, retryAfterSec: 5 });
    expect(hitWindows(logs, rules, 10_001).result.ok).toBe(true);
  });

  it("records nothing in any window when one window is full", () => {
    const rules = [
      { limit: 10, windowSec: 60 },
      { limit: 1, windowSec: 3600 },
    ];
    const first = hitWindows({}, rules, 0);
    const second = hitWindows(first.logs, rules, 1000);
    expect(second.result.ok).toBe(false);
    expect(second.logs["10/60"]).toEqual([0]);
  });
});

describe("rateLimit — IRK + usernameHash + IP extraction", () => {
  it("pulls IRK from /api/username/claim body shape", () => {
    const body = { request: { irkPub: "aa".repeat(32), username: "harry", issuedAt: 1 } };
    expect(extractIrkPub("username-claim", body)).toBe("aa".repeat(32));
  });

  it("pulls IRK from /api/auth-code/issue body shape (.code.userPubKey)", () => {
    const body = { code: { userPubKey: "bb".repeat(32), serial: "s" } };
    expect(extractIrkPub("auth-code-issue", body)).toBe("bb".repeat(32));
  });

  it("pulls IRK from /api/server/register body shape (.request.authCode.userPubKey)", () => {
    const body = { request: { authCode: { userPubKey: "cc".repeat(32) } } };
    expect(extractIrkPub("server-register", body)).toBe("cc".repeat(32));
  });

  it("returns undefined for non-hex64 candidates (malformed body just falls back to per-IP)", () => {
    expect(extractIrkPub("username-claim", { request: { irkPub: "not-hex" } })).toBeUndefined();
    expect(extractIrkPub("username-claim", { request: {} })).toBeUndefined();
    expect(extractIrkPub("username-claim", null)).toBeUndefined();
    expect(extractIrkPub("username-claim", "garbage")).toBeUndefined();
  });

  it("normalises hex case (so 'AA…' and 'aa…' map to the same bucket)", () => {
    const upper = extractIrkPub("username-claim", { request: { irkPub: "AA".repeat(32) } });
    const lower = extractIrkPub("username-claim", { request: { irkPub: "aa".repeat(32) } });
    expect(upper).toBe(lower);
  });

  it("pulls usernameHash from /api/recovery/by-username/<hash>", () => {
    expect(extractUsernameHash("/api/recovery/by-username/deadbeef")).toBe("deadbeef");
    expect(extractUsernameHash("/api/recovery/by-username/hash%2Dx")).toBe("hash-x");
    expect(extractUsernameHash("/api/recovery")).toBeUndefined();
    expect(extractUsernameHash("/api/recovery/by-username/")).toBeUndefined();
  });

  it("reads CF-Connecting-IP preferentially over X-Forwarded-For", () => {
    const req = new Request("https://x.example", {
      headers: { "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
    });
    expect(clientIp(req)).toBe("9.9.9.9");
  });

  it("falls back to first X-Forwarded-For hop when CF-Connecting-IP missing", () => {
    const req = new Request("https://x.example", {
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
    });
    expect(clientIp(req)).toBe("1.1.1.1");
  });

  it("returns null when no IP header is present (no synthetic placeholder)", () => {
    const req = new Request("https://x.example");
    expect(clientIp(req)).toBeNull();
  });
});

describe("rateLimit — 429 response shape", () => {
  it("emits 429 with the documented body and headers", () => {
    const resp = rateLimitedResponse({
      limited: true,
      endpoint: "username-claim",
      axis: "ip",
      retryAfterSec: 3600,
    });
    expect(resp.status).toBe(429);
    expect(resp.headers.get("retry-after")).toBe("3600");
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(resp.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("body identifies endpoint + axis so phones can show the right error", async () => {
    const resp = rateLimitedResponse({
      limited: true,
      endpoint: "recovery-by-username",
      axis: "usernameHash",
      retryAfterSec: 900,
    });
    const body = JSON.parse(await resp.text());
    expect(body).toEqual({
      error: "rate-limited",
      endpoint: "recovery-by-username",
      limit: "usernameHash",
      retryAfterSec: 900,
      message: "Too many tries for this account name. Try again in about 15 minutes.",
    });
  });
});

describe("rateLimit — wired into route()", () => {
  function makeEnv(rl: RateLimitNamespace | undefined, overrides: Partial<RouteEnv> = {}): RouteEnv {
    return {
      SERVICES_BASE_URL: "https://flagship.services",
      ASSETS: {
        async fetch(req) {
          return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 });
        },
      },
      ...(rl ? { RATE_LIMITS: rl } : {}),
      ...overrides,
    };
  }

  it("lets unprotected /api/* routes through even when every counter refuses", async () => {
    const { ns } = makeCounters(() => false);
    const env = makeEnv(ns);
    // No upstream fetch needed because /api/health is served by the Worker.
    const r = await route(new Request("https://flagshipserver.com/api/health"), env);
    expect(r.status).toBe(200);
  });

  it("returns 429 when the counter refuses /api/username/claim", async () => {
    const { ns } = makeCounters(() => false);
    const env = makeEnv(ns);
    const r = await route(
      new Request("https://flagshipserver.com/api/username/claim", {
        method: "POST",
        body: JSON.stringify({ request: { irkPub: "aa".repeat(32), username: "h", issuedAt: 1 }, signature: "00" }),
        headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
      }),
      env,
    );
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    const body = JSON.parse(await r.text());
    expect(body.error).toBe("rate-limited");
    expect(body.endpoint).toBe("username-claim");
  });

  it("passes the request through to the upstream proxy when the counter allows", async () => {
    const { ns } = allowAll();
    const env = makeEnv(ns);
    // Mock the upstream fetch so route() can proceed to proxy fallback
    // (DB binding is absent → control-plane local handler is skipped).
    const realFetch = globalThis.fetch;
    let proxied = false;
    globalThis.fetch = vi.fn(async () => {
      proxied = true;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    try {
      const r = await route(
        new Request("https://flagshipserver.com/api/username/claim", {
          method: "POST",
          body: JSON.stringify({ request: { irkPub: "aa".repeat(32), username: "h", issuedAt: 1 }, signature: "00" }),
          headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
        }),
        env,
      );
      expect(r.status).toBe(200);
      expect(proxied).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("re-attaches the body to the request the upstream sees (no body loss after pre-parse)", async () => {
    const { ns } = allowAll();
    const env = makeEnv(ns);
    let receivedBody = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init);
      receivedBody = await req.text();
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      await route(
        new Request("https://flagshipserver.com/api/username/claim", {
          method: "POST",
          body: JSON.stringify({ request: { irkPub: "aa".repeat(32), username: "h", issuedAt: 1 } }),
          headers: { "content-type": "application/json" },
        }),
        env,
      );
      expect(JSON.parse(receivedBody)).toEqual({
        request: { irkPub: "aa".repeat(32), username: "h", issuedAt: 1 },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rate-limits the recovery endpoint (GET, pre-auth path with usernameHash axis)", async () => {
    const { ns, calls } = makeCounters((key) => !key.startsWith("recovery-by-username|usernameHash|"));
    const env = makeEnv(ns);
    const r = await route(
      new Request("https://flagshipserver.com/api/recovery/by-username/abc", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
      env,
    );
    expect(r.status).toBe(429);
    const body = JSON.parse(await r.text());
    expect(body.endpoint).toBe("recovery-by-username");
    expect(body.limit).toBe("usernameHash");
    expect(calls.some((k) => k === "recovery-by-username|ip|1.2.3.4")).toBe(true);
    expect(calls.some((k) => k === "recovery-by-username|usernameHash|abc")).toBe(true);
  });

  describe("checkPipeUpgrade (P2)", () => {
    it("no-ops when client IP is null (CF didn't tell us)", async () => {
      const { ns, calls } = allowAll();
      const r = await checkPipeUpgrade({ RATE_LIMITS: ns }, "qr-pipe-upgrade", null);
      expect(r.limited).toBe(false);
      expect(calls).toEqual([]);
    });

    it("keys each pipe apart from the other and from control-plane keys", async () => {
      const { ns, calls } = allowAll();
      await checkPipeUpgrade({ RATE_LIMITS: ns }, "qr-pipe-upgrade", "1.2.3.4");
      await checkPipeUpgrade({ RATE_LIMITS: ns }, "builder-pipe-upgrade", "1.2.3.4");
      expect(calls).toEqual(["qr-pipe-upgrade|ip|1.2.3.4", "builder-pipe-upgrade|ip|1.2.3.4"]);
    });

    it("allows 30 upgrades a minute per IP, then a 429-shaped result", async () => {
      const { ns } = memoryRateLimits();
      const env: RateLimitEnv = { RATE_LIMITS: ns };
      for (let i = 0; i < 30; i++) {
        expect((await checkPipeUpgrade(env, "qr-pipe-upgrade", "1.2.3.4")).limited).toBe(false);
      }
      const r = await checkPipeUpgrade(env, "qr-pipe-upgrade", "1.2.3.4");
      expect(r.limited).toBe(true);
      if (!r.limited) throw new Error("expected limited result");
      expect(r.endpoint).toBe("qr-pipe-upgrade");
      expect(r.axis).toBe("ip");
      const res = rateLimitedResponse(r);
      expect(res.status).toBe(429);
      expect(JSON.parse(await res.text())).toMatchObject({ error: "rate-limited", endpoint: "qr-pipe-upgrade", limit: "ip" });
      expect(res.headers.get("retry-after")).toBeTruthy();
      expect((await checkPipeUpgrade(env, "qr-pipe-upgrade", "2.2.2.2")).limited).toBe(false);
    });
  });

  it("LIMITS table matches the design-decisions thresholds (regression guard)", () => {
    expect(LIMITS["username-claim"]).toEqual([
      { axis: "ip", limit: 5, windowSec: 3600 },
      { axis: "irk", limit: 1, windowSec: 60 },
    ]);
    expect(LIMITS["auth-code-issue"]).toEqual([
      { axis: "ip", limit: 20, windowSec: 3600 },
      { axis: "irk", limit: 10, windowSec: 3600 },
    ]);
    expect(LIMITS["server-register"]).toEqual([
      { axis: "ip", limit: 10, windowSec: 3600 },
      { axis: "irk", limit: 5, windowSec: 3600 },
    ]);
    expect(LIMITS["recovery-by-username"]).toEqual([
      { axis: "ip", limit: 10, windowSec: 3600 },
      { axis: "usernameHash", limit: 3, windowSec: 900 },
    ]);
    // #28 Option B seal-to-box delivery buckets.
    expect(LIMITS["acme-key-deposit"]).toEqual([
      { axis: "ip", limit: 10, windowSec: 60 },
      { axis: "irk", limit: 50, windowSec: 3600 },
    ]);
    expect(LIMITS["acme-key-release"]).toEqual([
      { axis: "ip", limit: 120, windowSec: 60 },
    ]);
    expect(LIMITS["acme-key-delivery-revoke"]).toEqual([
      { axis: "ip", limit: 10, windowSec: 60 },
      { axis: "irk", limit: 20, windowSec: 3600 },
    ]);
  });
});

describe("TOTP verify budget", () => {
  it("routes POST /api/users/:u/totp/verify to its own endpoint, keyed by target", () => {
    expect(endpointFor("POST", "/api/users/alice/totp/verify")).toBe("totp-verify");
    expect(extractUsernameHash("/api/users/alice/totp/verify")).toBe("alice");
  });

  it("allows 5 attempts per account in 15 minutes from any number of addresses", async () => {
    const { ns } = memoryRateLimits();
    const env: RateLimitEnv = { RATE_LIMITS: ns };
    const verify = (ip: string) => checkRateLimit(env, { endpoint: "totp-verify", ip, usernameHash: "alice" });
    for (let i = 0; i < 5; i++) expect((await verify(`10.9.0.${i}`)).limited).toBe(false);
    expect((await verify("10.9.0.99")).limited).toBe(true);
  });
});

describe("username keys", () => {
  it("count one account however the path spells it", () => {
    expect(extractUsernameHash("/api/users/Alice/re-pair")).toBe("alice");
    expect(extractUsernameHash("/api/users/%41lice/totp/verify")).toBe("alice");
    expect(extractUsernameHash("/api/users/%E0%A4%A/re-pair")).toBe("%e0%a4%a");
  });
});

describe("re-pair initiate budget", () => {
  it("routes POST /api/users/:u/re-pair to its own endpoint, keyed by target", () => {
    expect(endpointFor("POST", "/api/users/alice/re-pair")).toBe("re-pair-initiate");
    expect(extractUsernameHash("/api/users/alice/re-pair")).toBe("alice");
  });

  it("does NOT limit /object or /complete — both are bounded by the pending row", () => {
    expect(endpointFor("POST", "/api/users/alice/re-pair/object")).toBeNull();
    expect(endpointFor("POST", "/api/users/alice/re-pair/complete")).toBeNull();
  });

  it("budgets the target account tighter than the source IP", () => {
    const axes = LIMITS["re-pair-initiate"];
    const perUser = axes.find((a) => a.axis === "usernameHash");
    expect(perUser).toBeDefined();
    expect(perUser!.limit).toBeLessThanOrEqual(3);
  });
});
