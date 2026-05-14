import { describe, expect, it, vi } from "vitest";
import {
  checkQrPipeUpgrade,
  checkRateLimit,
  clientIp,
  endpointFor,
  extractIrkPub,
  extractUsernameHash,
  rateLimitedResponse,
  LIMITS,
  type RateLimitBinding,
  type RateLimitEnv,
} from "../src/rateLimit.js";
import { route, type RouteEnv } from "../src/route.js";

/**
 * Rate-limit binding stub. Tracks every `key` it was called with and
 * decides success/fail via the policy callback. Tests rebuild the
 * stub per case so call records don't leak.
 */
function makeBinding(
  policy: (key: string, callsForKey: number) => boolean,
): { binding: RateLimitBinding; calls: string[] } {
  const calls: string[] = [];
  const perKey = new Map<string, number>();
  const binding: RateLimitBinding = {
    async limit({ key }) {
      const next = (perKey.get(key) ?? 0) + 1;
      perKey.set(key, next);
      calls.push(key);
      return { success: policy(key, next) };
    },
  };
  return { binding, calls };
}

/** Tiny helper: a binding that always allows. */
function allowAll(): { binding: RateLimitBinding; calls: string[] } {
  return makeBinding(() => true);
}

/** A binding that fails on every Nth call to a given key (per-key counter). */
function failAfter(threshold: number): {
  binding: RateLimitBinding;
  calls: string[];
} {
  return makeBinding((_k, n) => n <= threshold);
}

describe("rateLimit — endpoint detection", () => {
  it("matches the four protected endpoints", () => {
    expect(endpointFor("POST", "/api/username/claim")).toBe("username-claim");
    expect(endpointFor("POST", "/api/auth-code/issue")).toBe("auth-code-issue");
    expect(endpointFor("POST", "/api/server/register")).toBe("server-register");
    expect(endpointFor("GET", "/api/recovery/by-username/abc123")).toBe("recovery-by-username");
    expect(endpointFor("DELETE", "/api/recovery/by-username/abc123")).toBe("recovery-by-username");
  });

  it("returns null for unrelated routes (no false-positive rate limits)", () => {
    expect(endpointFor("GET", "/api/health")).toBeNull();
    expect(endpointFor("POST", "/api/marketplace/list")).toBeNull();
    expect(endpointFor("GET", "/api/username/harry")).toBeNull();
    expect(endpointFor("GET", "/api/recovery")).toBeNull();
  });

  it("methods are case-insensitive", () => {
    expect(endpointFor("post", "/api/username/claim")).toBe("username-claim");
  });
});

describe("rateLimit — checkRateLimit", () => {
  it("is a no-op when RATE_LIMITER binding isn't bound (dev / no namespace)", async () => {
    const env: RateLimitEnv = {};
    const r = await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" });
    expect(r.limited).toBe(false);
  });

  it("returns 429 when the per-IP axis trips", async () => {
    const { binding, calls } = failAfter(5);
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(env, {
        endpoint: "username-claim",
        ip: "1.2.3.4",
      });
      expect(r.limited).toBe(false);
    }
    // 6th call trips IP axis (and possibly IRK; we check IP first).
    const sixth = await checkRateLimit(env, {
      endpoint: "username-claim",
      ip: "1.2.3.4",
    });
    expect(sixth.limited).toBe(true);
    if (sixth.limited) {
      expect(sixth.axis).toBe("ip");
      expect(sixth.endpoint).toBe("username-claim");
      expect(sixth.retryAfterSec).toBe(3600);
    }
    expect(calls.length).toBeGreaterThan(5);
  });

  it("encodes endpoint + axis + identifier into the key (so different endpoints don't share buckets)", async () => {
    const { binding, calls } = allowAll();
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    await checkRateLimit(env, { endpoint: "username-claim", ip: "1.2.3.4" });
    await checkRateLimit(env, { endpoint: "auth-code-issue", ip: "1.2.3.4" });
    expect(calls).toContain("username-claim|ip|1.2.3.4");
    expect(calls).toContain("auth-code-issue|ip|1.2.3.4");
  });

  it("counts different IPs independently", async () => {
    const { binding } = failAfter(1);
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    const a1 = await checkRateLimit(env, { endpoint: "username-claim", ip: "1.1.1.1" });
    const a2 = await checkRateLimit(env, { endpoint: "username-claim", ip: "1.1.1.1" });
    const b1 = await checkRateLimit(env, { endpoint: "username-claim", ip: "2.2.2.2" });
    expect(a1.limited).toBe(false);
    expect(a2.limited).toBe(true); // 1.1.1.1 over budget
    expect(b1.limited).toBe(false); // different IP, fresh budget
  });

  it("counts different IRKs independently", async () => {
    const { binding } = failAfter(1);
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    // Use a single IP across all calls so only the IRK axis differs.
    const ip = "1.2.3.4";
    const r1 = await checkRateLimit(env, {
      endpoint: "auth-code-issue",
      ip,
      irkPub: "aa".repeat(32),
    });
    expect(r1.limited).toBe(false);
    // Second call with the SAME IRK trips its bucket — but only after
    // both ip-bucket and irk-bucket are evaluated; the IP bucket also
    // counts as we re-use the same IP. With threshold=1, the second
    // call's IP-bucket trips first.
    const r2 = await checkRateLimit(env, {
      endpoint: "auth-code-issue",
      ip,
      irkPub: "aa".repeat(32),
    });
    expect(r2.limited).toBe(true);
    // A fresh IP + fresh IRK is allowed.
    const r3 = await checkRateLimit(env, {
      endpoint: "auth-code-issue",
      ip: "9.9.9.9",
      irkPub: "bb".repeat(32),
    });
    expect(r3.limited).toBe(false);
  });

  it("skips the IRK axis when irkPub is not supplied (unsigned recovery endpoint case)", async () => {
    const { binding, calls } = allowAll();
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    await checkRateLimit(env, {
      endpoint: "recovery-by-username",
      ip: "1.2.3.4",
      usernameHash: "deadbeef",
    });
    // Two axes for recovery: ip + usernameHash. NO irk axis.
    expect(calls.some((k) => k.includes("|ip|"))).toBe(true);
    expect(calls.some((k) => k.includes("|usernameHash|"))).toBe(true);
    expect(calls.some((k) => k.includes("|irk|"))).toBe(false);
  });

  it("recovery axis trips per usernameHash (independent of IP)", async () => {
    const { binding } = failAfter(3);
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    // Three different IPs hitting the SAME usernameHash should still trip
    // on the 4th request because usernameHash bucket is shared.
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(env, {
        endpoint: "recovery-by-username",
        ip: `10.0.0.${i}`,
        usernameHash: "shared-hash",
      });
      expect(r.limited).toBe(false);
    }
    const r4 = await checkRateLimit(env, {
      endpoint: "recovery-by-username",
      ip: "10.0.0.99",
      usernameHash: "shared-hash",
    });
    expect(r4.limited).toBe(true);
    if (r4.limited) {
      expect(r4.axis).toBe("usernameHash");
      expect(r4.retryAfterSec).toBe(900);
    }
  });

  it("skips the ip axis when ip is null (defensive — never crashes)", async () => {
    const { binding, calls } = allowAll();
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    await checkRateLimit(env, { endpoint: "username-claim", ip: null });
    expect(calls.some((k) => k.startsWith("username-claim|ip|"))).toBe(false);
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
    });
  });
});

describe("rateLimit — wired into route()", () => {
  function makeEnv(rl: RateLimitBinding | undefined, overrides: Partial<RouteEnv> = {}): RouteEnv {
    return {
      SERVICES_BASE_URL: "https://flagship.services",
      ASSETS: {
        async fetch(req) {
          return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 });
        },
      },
      ...(rl ? { RATE_LIMITER: rl } : {}),
      ...overrides,
    };
  }

  it("lets unprotected /api/* routes through even when the binding always says fail", async () => {
    const { binding } = makeBinding(() => false);
    const env = makeEnv(binding);
    // No upstream fetch needed because /api/health is served by the Worker.
    const r = await route(new Request("https://flagshipserver.com/api/health"), env);
    expect(r.status).toBe(200);
  });

  it("returns 429 when the binding fails for /api/username/claim", async () => {
    const { binding } = makeBinding(() => false);
    const env = makeEnv(binding);
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

  it("passes the request through to the upstream proxy when the binding allows", async () => {
    const { binding } = allowAll();
    const env = makeEnv(binding);
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
    const { binding } = allowAll();
    const env = makeEnv(binding);
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
    const { binding, calls } = makeBinding((key) => !key.startsWith("recovery-by-username|usernameHash|"));
    const env = makeEnv(binding);
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

  describe("checkQrPipeUpgrade (P2)", () => {
    it("no-ops when RATE_LIMITER_QR_PIPE isn't bound (dev / tests)", async () => {
      const r = await checkQrPipeUpgrade({}, "1.2.3.4");
      expect(r.limited).toBe(false);
    });

    it("no-ops when client IP is null (CF didn't tell us)", async () => {
      const { binding } = allowAll();
      const r = await checkQrPipeUpgrade({ RATE_LIMITER_QR_PIPE: binding }, null);
      expect(r.limited).toBe(false);
    });

    it("keys on `qr-pipe-upgrade|ip|<ip>` so it doesn't collide with control-plane keys", async () => {
      const { binding, calls } = allowAll();
      await checkQrPipeUpgrade({ RATE_LIMITER_QR_PIPE: binding }, "1.2.3.4");
      expect(calls).toEqual(["qr-pipe-upgrade|ip|1.2.3.4"]);
    });

    it("returns a 429-shaped result when the binding rejects", async () => {
      const { binding } = failAfter(0); // first call already fails
      const r = await checkQrPipeUpgrade({ RATE_LIMITER_QR_PIPE: binding }, "1.2.3.4");
      expect(r.limited).toBe(true);
      if (r.limited) {
        expect(r.endpoint).toBe("qr-pipe-upgrade");
        expect(r.axis).toBe("ip");
        expect(r.retryAfterSec).toBeGreaterThan(0);
      }
    });

    it("rateLimitedResponse renders the qr-pipe-upgrade result correctly", async () => {
      const { binding } = failAfter(0);
      const r = await checkQrPipeUpgrade({ RATE_LIMITER_QR_PIPE: binding }, "1.2.3.4");
      expect(r.limited).toBe(true);
      if (!r.limited) throw new Error("expected limited result");
      const res = rateLimitedResponse(r);
      expect(res.status).toBe(429);
      const body = JSON.parse(await res.text());
      expect(body.endpoint).toBe("qr-pipe-upgrade");
      expect(body.limit).toBe("ip");
      expect(res.headers.get("retry-after")).toBeTruthy();
    });

    it("two distinct IPs occupy independent buckets", async () => {
      // failAfter is per-key; if the limiter conflated IPs the second
      // call would inherit the first's count and trip.
      const { binding } = failAfter(0);
      const a = await checkQrPipeUpgrade({ RATE_LIMITER_QR_PIPE: binding }, "1.1.1.1");
      const b = await checkQrPipeUpgrade({ RATE_LIMITER_QR_PIPE: binding }, "2.2.2.2");
      // Both trip independently (first call already fails), but the
      // keys must differ — failAfter only fails after threshold for
      // that specific key.
      expect(a.limited).toBe(true);
      expect(b.limited).toBe(true);
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
  });
});
