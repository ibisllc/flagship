import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { route, _internal, type RouteEnv } from "../src/route.js";
import { handleCaLeaseStatus } from "@flagship/control-plane";

interface CapturedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: CapturedFetch[] = [];
let nextResp: Response = new Response("ok", { status: 200 });

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  nextResp = new Response("ok", {
    status: 200,
    headers: { "content-type": "application/json", "x-services-server": "fly" },
  });
  globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(input.toString(), init);
    calls.push({
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers as unknown as Iterable<[string, string]>),
      body: req.body ? await req.text() : undefined,
    });
    return nextResp.clone();
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeEnv(overrides: Partial<RouteEnv> = {}): RouteEnv {
  return {
    SERVICES_BASE_URL: "https://flagship.services",
    ASSETS: {
      async fetch(req) {
        return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 });
      },
    },
    ...overrides,
  };
}

describe("flagshipserver.com Worker — routing", () => {
  it("non-/api paths are served by the asset binding when the preview cookie is set", async () => {
    // /webapp/* used to fall through here too, but as of the
    // web.flagshipserver.com migration it 308-redirects to the new
    // origin — see the dedicated `/me + /webapp redirects` describe.
    // Pre-launch the apex marketing surface is gated behind a
    // coming-soon page (see the "Pre-launch stealth gate" describe);
    // setting the flagship_preview cookie bypasses the gate so the
    // existing asset-fallback behaviour is observable.
    const cookie = { cookie: "flagship_preview=1" };
    const r = await route(
      new Request("https://flagshipserver.com/", { headers: cookie }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/");
    const r2 = await route(
      new Request("https://flagshipserver.com/.well-known/security.txt"),
      makeEnv(),
    );
    expect(await r2.text()).toBe("asset:/.well-known/security.txt");
    const r3 = await route(
      new Request("https://flagshipserver.com/deck/", { headers: cookie }),
      makeEnv(),
    );
    expect(await r3.text()).toBe("asset:/deck/");
  });

  it("a missing .css/.js 404s instead of falling through to the SPA HTML", async () => {
    // The assets binding runs `not_found_handling = single-page-application`,
    // so a MISSING file resolves to index.html (200 + text/html). For a
    // stylesheet/script that must read as a real 404 — otherwise the browser
    // parses marketing HTML as CSS/JS and flashes the page unstyled mid-deploy.
    const cookie = { cookie: "flagship_preview=1" };
    const spaFallbackEnv = makeEnv({
      ASSETS: {
        async fetch(req) {
          const path = new URL(req.url).pathname;
          // A real asset the binding can resolve.
          if (path === "/site.css") {
            return new Response("body{color:red}", {
              status: 200,
              headers: { "content-type": "text/css" },
            });
          }
          // Everything else "misses" → the SPA fallback (index.html).
          return new Response("<!doctype html><title>Flagship</title>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    });
    // A missing stylesheet → real 404, NOT the 200-with-HTML fallback.
    const missing = await route(
      new Request("https://flagshipserver.com/theme-ui.css", { headers: cookie }),
      spaFallbackEnv,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/plain");
    expect(await missing.text()).not.toContain("<!doctype");
    const missingJs = await route(
      new Request("https://flagshipserver.com/theme.js", { headers: cookie }),
      spaFallbackEnv,
    );
    expect(missingJs.status).toBe(404);
    // A real asset is still served untouched.
    const realCss = await route(
      new Request("https://flagshipserver.com/site.css", { headers: cookie }),
      spaFallbackEnv,
    );
    expect(realCss.status).toBe(200);
    expect(realCss.headers.get("content-type")).toContain("text/css");
    // An SPA route (no file extension) still gets the HTML fallback.
    const spaRoute = await route(
      new Request("https://flagshipserver.com/not-a-file", { headers: cookie }),
      spaFallbackEnv,
    );
    expect(spaRoute.status).toBe(200);
    expect((spaRoute.headers.get("content-type") ?? "")).toContain("text/html");
  });

  it("/api/* is forwarded to SERVICES_BASE_URL preserving method + path + query", async () => {
    await route(
      new Request("https://flagshipserver.com/api/me/servers?sessionId=abc"),
      makeEnv(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://flagship.services/api/me/servers?sessionId=abc");
    expect(calls[0]!.method).toBe("GET");
  });

  it("forwards POST body and content-type to .services", async () => {
    await route(
      new Request("https://flagshipserver.com/api/username/claim", {
        method: "POST",
        body: JSON.stringify({ request: { username: "harry" } }),
        headers: { "content-type": "application/json" },
      }),
      makeEnv(),
    );
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.body).toBe('{"request":{"username":"harry"}}');
  });

  it("strips edge-only request headers (host, content-length, hop-by-hop)", async () => {
    await route(
      new Request("https://flagshipserver.com/api/something-else", {
        headers: { host: "flagshipserver.com", connection: "keep-alive" },
      }),
      makeEnv(),
    );
    const sentHeaders = calls[0]!.headers;
    for (const stripped of _internal.STRIP_REQ_HEADERS) {
      expect(sentHeaders[stripped]).toBeUndefined();
    }
  });

  it("adds x-forwarded-host + x-forwarded-proto so .services can log the original surface", async () => {
    await route(
      new Request("https://flagshipserver.com/api/something-else"),
      makeEnv(),
    );
    expect(calls[0]!.headers["x-forwarded-host"]).toBe("flagshipserver.com");
    expect(calls[0]!.headers["x-forwarded-proto"]).toBe("https");
  });

  it("returns 500 if SERVICES_BASE_URL is not absolute (misconfig guard)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/something-else"),
      makeEnv({ SERVICES_BASE_URL: "not-a-url" }),
    );
    expect(r.status).toBe(500);
    expect(await r.text()).toMatch(/SERVICES_BASE_URL/);
    expect(calls).toHaveLength(0);
  });

  it("returns 502 when upstream throws (not an asset 404 / not a 200)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    const r = await route(
      new Request("https://flagshipserver.com/api/something-else"),
      makeEnv(),
    );
    expect(r.status).toBe(502);
    const body = JSON.parse(await r.text());
    expect(body.error).toMatch(/upstream unreachable/);
  });

  it("propagates upstream status + body unchanged (404 stays 404, 200 stays 200)", async () => {
    nextResp = new Response('{"error":"not found"}', {
      status: 404,
      headers: { "content-type": "application/json" },
    });
    const r = await route(
      new Request("https://flagshipserver.com/api/username/ghost"),
      makeEnv(),
    );
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('{"error":"not found"}');
  });

  it("does NOT forward GET-style methods with a body (HEAD/OPTIONS too)", async () => {
    await route(
      new Request("https://flagshipserver.com/api/something-else", { method: "HEAD" }),
      makeEnv(),
    );
    expect(calls[0]!.body).toBeUndefined();
  });
});

describe("/api/_status/probe", () => {
  it("returns reachable=true with latency + parsed health body when upstream is OK", async () => {
    nextResp = new Response(
      JSON.stringify({ ok: true, surface: "services", processUptimeSec: 42 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const r = await route(
      new Request("https://flagshipserver.com/api/_status/probe"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.reachable).toBe(true);
    expect(body.statusCode).toBe(200);
    expect(typeof body.latencyMs).toBe("number");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.upstream).toBe("https://flagship.services/api/health");
    expect(body.health).toMatchObject({ ok: true, processUptimeSec: 42 });
    expect(body.checkedAt).toMatch(/^\d{4}-/);
  });

  it("hits the upstream itself — does NOT fall through to the asset binding or the proxy path", async () => {
    nextResp = new Response("{}", { status: 200 });
    const env = makeEnv();
    const assetSpy = vi.spyOn(env.ASSETS, "fetch");
    await route(new Request("https://flagshipserver.com/api/_status/probe"), env);
    expect(assetSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://flagship.services/api/health");
  });

  it("returns reachable=false with error when upstream throws (still 200 — the probe itself worked)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("boom");
    }) as typeof globalThis.fetch;
    const r = await route(
      new Request("https://flagshipserver.com/api/_status/probe"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.reachable).toBe(false);
    expect(body.statusCode).toBeNull();
    expect(body.error).toMatch(/boom/);
  });

  it("returns reachable=false with statusCode on a non-2xx upstream", async () => {
    nextResp = new Response("nope", { status: 503 });
    const r = await route(
      new Request("https://flagshipserver.com/api/_status/probe"),
      makeEnv(),
    );
    const body = JSON.parse(await r.text());
    expect(body.reachable).toBe(false);
    expect(body.statusCode).toBe(503);
  });

  it("sets cache-control: no-store so browsers don't pin a stale probe", async () => {
    nextResp = new Response("{}", { status: 200 });
    const r = await route(
      new Request("https://flagshipserver.com/api/_status/probe"),
      makeEnv(),
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns 500 when SERVICES_BASE_URL is misconfigured (same misconfig guard as the proxy)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/_status/probe"),
      makeEnv({ SERVICES_BASE_URL: "not-a-url" }),
    );
    expect(r.status).toBe(500);
    expect(calls).toHaveLength(0);
  });
});

describe("/build/iso/* — R2 streaming", () => {
  it("404s when the requested filename is not in the bucket", async () => {
    const env = makeEnv({
      ISO_BUCKET: { async get() { return null; } },
    });
    const r = await route(
      new Request("https://flagshipserver.com/build/iso/missing.iso"),
      env,
    );
    expect(r.status).toBe(404);
  });

  it("streams the R2 body with correct content-type and size headers", async () => {
    const isoBytes = new Uint8Array(1024).fill(0x42);
    const env = makeEnv({
      ISO_BUCKET: {
        async get() {
          return {
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(isoBytes);
                controller.close();
              },
            }),
            size: isoBytes.length,
            httpEtag: '"abc123"',
          };
        },
      },
    });
    const r = await route(
      new Request("https://flagshipserver.com/build/iso/flagship-base.iso"),
      env,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-length")).toBe("1024");
    expect(r.headers.get("etag")).toBe('"abc123"');
    expect(r.headers.get("content-disposition")).toContain("flagship-base");
    const body = new Uint8Array(await r.arrayBuffer());
    expect(body.length).toBe(1024);
    expect(body[0]).toBe(0x42);
  });

  it("400s on a filename that contains path traversal", async () => {
    const env = makeEnv({
      ISO_BUCKET: { async get() { return { body: null, size: 0 }; } },
    });
    const r = await route(
      new Request("https://flagshipserver.com/build/iso/..%2Fsecret.iso"),
      env,
    );
    expect(r.status).toBe(400);
  });

  it("500s when ISO_BUCKET is not bound (misconfig guard)", async () => {
    const env = makeEnv();
    delete (env as { ISO_BUCKET?: unknown }).ISO_BUCKET;
    const r = await route(
      new Request("https://flagshipserver.com/build/iso/x.iso"),
      env,
    );
    expect(r.status).toBe(500);
  });
});

describe("/api/services/endpoints (discovery)", () => {
  it("returns the configured tunnelHub + passthrough IPs, served directly (not proxied)", async () => {
    const env = makeEnv({
      TUNNEL_HUB_URL: "wss://my-hub.example/tunnel",
      SERVICES_PASSTHROUGH_IPV4: "1.2.3.4",
      SERVICES_PASSTHROUGH_IPV6: "::1",
    });
    const r = await route(
      new Request("https://flagshipserver.com/api/services/endpoints"),
      env,
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.version).toBe(_internal.SERVICES_ENDPOINTS_VERSION);
    expect(body.tunnelHub).toBe("wss://my-hub.example/tunnel");
    expect(body.passthroughIPv4).toBe("1.2.3.4");
    expect(body.passthroughIPv6).toBe("::1");
    expect(body.siblings).toEqual([]);
    expect(typeof body.issuedAt).toBe("string");
    expect(calls).toHaveLength(0);
  });

  it("falls back to the hardcoded default when TUNNEL_HUB_URL isn't set", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/services/endpoints"),
      makeEnv(),
    );
    const body = JSON.parse(await r.text());
    expect(body.tunnelHub).toBe(_internal.DEFAULT_TUNNEL_HUB_URL);
    expect(body.passthroughIPv4).toBeNull();
  });

  it("emits cache-control: max-age=60 so the edge can absorb load + infra moves are visible within ~1 min", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/services/endpoints"),
      makeEnv(),
    );
    expect(r.headers.get("cache-control")).toMatch(/max-age=60/);
  });
});

describe("/api/health", () => {
  it("is served directly by the Worker, never proxied", async () => {
    const env = makeEnv();
    const r = await route(new Request("https://flagshipserver.com/api/health"), env);
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.ok).toBe(true);
    expect(body.surface).toBe("com");
    expect(calls).toHaveLength(0);
  });

  it("succeeds even when SERVICES_BASE_URL is broken (proves it doesn't depend on .services)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/health"),
      makeEnv({ SERVICES_BASE_URL: "not-a-url" }),
    );
    expect(r.status).toBe(200);
  });
});

describe(".com control-plane routes (Worker + D1)", () => {
  it("falls through to upstream when DB binding is missing", async () => {
    nextResp = new Response(JSON.stringify({ ok: true, fromUpstream: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const r = await route(
      new Request("https://flagshipserver.com/api/username/claim", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(await r.text()).fromUpstream).toBe(true);
  });

  it("routes to the local control-plane handler when DB is bound (no upstream call)", async () => {
    const env = makeEnv({
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [], success: true, meta: {} }),
            run: async () => ({ success: true, meta: { changes: 0 } }),
          }),
        }),
        batch: async () => [],
      } as unknown as import("@flagship/storage").D1Database,
    });
    const r = await route(
      new Request("https://flagshipserver.com/api/username/claim", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    expect(r.status).toBe(400);
    expect(JSON.parse(await r.text()).error).toMatch(/malformed/);
    expect(calls).toHaveLength(0);
  });

  it("/api/push/vapid-public-key returns 503 when WEBPUSH_VAPID_PUBLIC_KEY_B64URL isn't set", async () => {
    const env = makeEnv({
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [], success: true, meta: {} }),
            run: async () => ({ success: true, meta: {} }),
          }),
        }),
        batch: async () => [],
      } as unknown as import("@flagship/storage").D1Database,
    });
    const r = await route(
      new Request("https://flagshipserver.com/api/push/vapid-public-key"),
      env,
    );
    expect(r.status).toBe(503);
  });

  it("/api/push/vapid-public-key returns the configured key when set", async () => {
    const env = makeEnv({
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [], success: true, meta: {} }),
            run: async () => ({ success: true, meta: {} }),
          }),
        }),
        batch: async () => [],
      } as unknown as import("@flagship/storage").D1Database,
      WEBPUSH_VAPID_PUBLIC_KEY_B64URL: "BFD2WVWGSb2i6UH1DCbDmrVVB_UpYxQSdg_qfybBtoslDy",
    });
    const r = await route(
      new Request("https://flagshipserver.com/api/push/vapid-public-key"),
      env,
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.key).toBe("BFD2WVWGSb2i6UH1DCbDmrVVB_UpYxQSdg_qfybBtoslDy");
  });

  it("/api/order/<serial>/status (canonical channel) reaches the handler + rejects an unknown phase (400)", async () => {
    const env = makeEnv({
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [], success: true, meta: {} }),
            run: async () => ({ success: true, meta: { changes: 0 } }),
          }),
        }),
        batch: async () => [],
      } as unknown as import("@flagship/storage").D1Database,
    });
    const r = await route(
      new Request("https://flagshipserver.com/api/order/01TESTABCDEF/status", {
        method: "POST",
        body: JSON.stringify({ phase: "halfway" }),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    // Handled locally (the canonical channel is the single provisioning sink);
    // an unknown phase is a 400 from the handler, not an upstream proxy.
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("/api/ca/cert returns the dev CA pubkey when bound to D1 + no FLAGSHIP_CA_PRIV_HEX", async () => {
    const env = makeEnv({
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [], success: true, meta: {} }),
            run: async () => ({ success: true, meta: {} }),
          }),
        }),
        batch: async () => [],
      } as unknown as import("@flagship/storage").D1Database,
    });
    const r = await route(
      new Request("https://flagshipserver.com/api/ca/cert"),
      env,
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.issuer).toBe("flagship-ca-dev");
    expect(body.pubKey).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── OPS-2 / OPS-3 admin visibility endpoints ──────────────────
  // A D1 stub whose prepared statements answer both the bound and
  // unbound call shapes (schemaVersion.list() uses prepare().all()
  // with no bind; record() binds then runs).
  function opsD1() {
    const stmt = {
      bind: () => stmt,
      first: async () => null,
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    return {
      prepare: () => stmt,
      batch: async () => [],
    } as unknown as import("@flagship/storage").D1Database;
  }

  it("/api/admin/schema-status is 503 when FLAGSHIP_ADMIN_SECRET is unset", async () => {
    const env = makeEnv({ DB: opsD1() });
    const r = await route(
      new Request("https://flagshipserver.com/api/admin/schema-status"),
      env,
    );
    expect(r.status).toBe(503);
  });

  it("/api/admin/schema-status is 403 with a wrong secret", async () => {
    const env = makeEnv({ DB: opsD1(), FLAGSHIP_ADMIN_SECRET: "right" });
    const r = await route(
      new Request("https://flagshipserver.com/api/admin/schema-status", {
        headers: { "x-admin-secret": "wrong" },
      }),
      env,
    );
    expect(r.status).toBe(403);
  });

  it("/api/admin/schema-status returns the known/missing diff when authed", async () => {
    const env = makeEnv({ DB: opsD1(), FLAGSHIP_ADMIN_SECRET: "s3cret" });
    const r = await route(
      new Request("https://flagshipserver.com/api/admin/schema-status", {
        headers: { "x-admin-secret": "s3cret" },
      }),
      env,
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    // Empty ledger ⇒ every known migration is "missing", nothing in sync.
    expect(body.known).toContain("0049");
    expect(body.missing).toContain("0049");
    expect(body.inSync).toBe(false);
  });

  it("/api/admin/schema-version/:v stamps a version when authed", async () => {
    const env = makeEnv({ DB: opsD1(), FLAGSHIP_ADMIN_SECRET: "s3cret" });
    const r = await route(
      new Request("https://flagshipserver.com/api/admin/schema-version/0049", {
        method: "POST",
        headers: { "x-admin-secret": "s3cret" },
      }),
      env,
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.version).toBe("0049");
    expect(body.recorded).toBe(true);
  });

  // The handler resolves "now" and the active leases via injected deps, so
  // these exercise it against CONTROLLED inputs — frozen now + a controlled
  // notAfter list — rather than the real committed bundle at the wall-clock
  // (whose only endorsement lapsed 2026-06-02, making any real-`now`/real-
  // bundle assertion go red by calendar). Behavior of the handler is
  // unchanged; we just feed it deterministic deps.
  describe("/api/admin/ca-lease-status (handler logic, date-independent)", () => {
    const NOW = Date.parse("2026-06-01T00:00:00.000Z");
    const DAY = 24 * 60 * 60 * 1000;

    async function status(activeNotAfterMs: number[]) {
      return handleCaLeaseStatus({
        activeLeaseNotAfterMs: () => activeNotAfterMs,
        now: () => NOW,
      });
    }

    it("reports 'none' when no endorsement lease is active", async () => {
      const r = await status([]);
      expect(r.status).toBe(200);
      expect(r.body.severity).toBe("none");
      expect(r.body.hasActiveLease).toBe(false);
      expect(r.body.soonestNotAfterMs).toBeNull();
      expect(r.body.soonestNotAfterIso).toBeNull();
    });

    it("reports 'ok' when the soonest lease is beyond the warn window", async () => {
      const notAfter = NOW + 30 * DAY; // > 7-day threshold
      const r = await status([notAfter, NOW + 60 * DAY]);
      expect(r.body.severity).toBe("ok");
      expect(r.body.hasActiveLease).toBe(true);
      expect(r.body.soonestNotAfterMs).toBe(notAfter);
      expect(r.body.soonestNotAfterIso).toBe(new Date(notAfter).toISOString());
    });

    it("reports 'warn' when the soonest lease lapses within the threshold", async () => {
      const notAfter = NOW + 3 * DAY; // inside the 7-day default threshold
      const r = await status([NOW + 60 * DAY, notAfter]);
      expect(r.body.severity).toBe("warn");
      expect(r.body.hasActiveLease).toBe(true);
      expect(r.body.soonestNotAfterMs).toBe(notAfter);
      expect(r.body.msUntilExpiry).toBe(3 * DAY);
    });

    it("reports 'expired' when the soonest lease's notAfter has passed", async () => {
      const notAfter = NOW - DAY; // already lapsed at the frozen now
      const r = await status([notAfter, NOW + 60 * DAY]);
      expect(r.body.severity).toBe("expired");
      expect(r.body.hasActiveLease).toBe(true);
      expect(r.body.soonestNotAfterMs).toBe(notAfter);
      expect(r.body.msUntilExpiry).toBeLessThanOrEqual(0);
    });
  });
});

describe("/og — OG-poster generator (P3.6)", () => {
  it("returns an SVG with the title baked in", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/og?title=Hello+world"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    const body = await r.text();
    expect(body).toContain("<svg");
    expect(body).toContain("Hello world");
    expect(body).toContain("Flagship");
  });

  it("escapes XML special characters in the title to prevent injection", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/og?title=%3Cscript%3Eevil%3C/script%3E"),
      makeEnv(),
    );
    const body = await r.text();
    // The literal `<script>` must NOT appear (it'd let an attacker
    // smuggle markup into the SVG body).
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("clamps absurdly long titles to 120 chars", async () => {
    const long = "a".repeat(500);
    const r = await route(
      new Request(`https://flagshipserver.com/og?title=${long}`),
      makeEnv(),
    );
    const body = await r.text();
    // Some chunking happens at word boundaries; assert we never emit
    // the full 500-char string.
    expect(body).not.toContain("a".repeat(200));
  });

  it("falls back to defaults when no params are passed", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/og"),
      makeEnv(),
    );
    const body = await r.text();
    expect(body).toContain("Flagship");
    expect(body).toContain("Your stuff, on hardware you own.");
  });

  it("is cacheable for 1 hour at the edge", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/og?title=x"),
      makeEnv(),
    );
    expect(r.headers.get("cache-control")).toContain("max-age=3600");
  });
});

describe("/me + /webapp redirects to web.flagshipserver.com", () => {
  it("/me returns a 308 to https://web.flagshipserver.com/", async () => {
    const r = await route(new Request("https://flagshipserver.com/me"), makeEnv());
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://web.flagshipserver.com/");
  });

  it("/me/anything also redirects to the webapp origin root", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/me/settings"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    // /me/* always lands on the webapp root — sub-paths under /me/ aren't
    // mapped 1:1 because the legacy /me area was speced as a single
    // landing surface.
    expect(r.headers.get("location")).toBe("https://web.flagshipserver.com/");
  });

  it("/webapp redirects to the new origin root", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/webapp"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://web.flagshipserver.com/");
  });

  it("/webapp/ (with trailing slash) also redirects to the new origin root", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/webapp/"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://web.flagshipserver.com/");
  });

  it("/webapp/foo/bar?x=1 preserves path tail and query", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/webapp/foo/bar?x=1"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(
      "https://web.flagshipserver.com/foo/bar?x=1",
    );
  });

  it("/messages (similar prefix to /me) is NOT redirected — falls through to assets", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/messages", {
        headers: { cookie: "flagship_preview=1" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/messages");
  });

  it("/webappish (similar prefix to /webapp) is NOT redirected — falls through to assets", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/webappish", {
        headers: { cookie: "flagship_preview=1" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webappish");
  });
});

describe("web.flagshipserver.com — webapp origin (host rewrite)", () => {
  it("/ on web. host fetches ASSETS /webapp/ (binding serves index.html)", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/");
  });

  it("/manifest.json on web. host fetches ASSETS /webapp/manifest.json", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/manifest.json"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/manifest.json");
  });

  it("/lib/api.js on web. host fetches ASSETS /webapp/lib/api.js (deep paths)", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/lib/api.js"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/lib/api.js");
  });

  it("/views/home.js?v=2 preserves query when rewriting", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/views/home.js?v=2"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/views/home.js");
  });

  it("/qrEncoder.js (shared root asset) is served from the SITE ROOT, not /webapp/", async () => {
    // qrEncoder.js lives at apps/web/public/qrEncoder.js (shared with the
    // marketing landing page) and is imported by the webapp's add-device +
    // companion-dock views via `import("/qrEncoder.js")`. There is NO copy
    // under webapp/, so a /webapp/ rewrite would hit the SPA index.html
    // fallback (content-type text/html) and the dynamic import would fail —
    // breaking the pairing QR. It must resolve from root.
    const r = await route(
      new Request("https://web.flagshipserver.com/qrEncoder.js"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/qrEncoder.js");
  });

  it("/api/* on web. host is NOT proxied — it's rewritten under /webapp/ (not exposed here)", async () => {
    // The webapp talks to the user's pod for /api/screens/*, never to
    // web.flagshipserver.com. Anything that lands on /api/* here is a
    // bug; we deliberately do NOT proxy to .services.
    const r = await route(
      new Request("https://web.flagshipserver.com/api/screens/server-detail"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/api/screens/server-detail");
    // Crucially: no upstream call.
    expect(calls).toHaveLength(0);
  });

  it("POST to web. host is rejected with 405 (writes go to the user's pod)", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/whatever", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
  });

  it("HEAD on web. host works (browsers preflight)", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/manifest.json", { method: "HEAD" }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
  });
});

describe("webapp host — client-route SPA fallback (the /join pairing bug)", () => {
  // The cross-device pairing QR encodes <controlApex>/join?sid=…&pk=…. On the
  // webapp host that path must boot the webapp's index.html so the in-app
  // router runs enterJoin({sid,pk}); a naive /join → /webapp/join rewrite
  // misses on disk and the assets binding's site-root SPA fallback serves the
  // MARKETING page instead. Every webapp client route (extensionless path)
  // serves the webapp's OWN index.html.

  it("/join on web. host serves the webapp index.html (PWA boots → enterJoin)", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/join"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/index.html");
  });

  it("/join?sid=x&pk=y on web. host serves the webapp index.html (query carried by browser)", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/join?sid=relay123&pk=abc"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    // The router reads sid/pk from window.location in the browser — the
    // server just needs to hand back the webapp shell, not the asset /join.
    expect(await r.text()).toBe("asset:/webapp/index.html");
  });

  it("a generic extensionless route (/home) also serves the webapp index.html", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/home"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/index.html");
  });

  it("/dock serves the webapp shell for the desktop pairing ceremony", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/dock"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/index.html");
  });

  it("real asset files (with an extension) still rewrite to /webapp/<file>, NOT index.html", async () => {
    // Regression guard: the SPA fallback must not swallow actual files.
    const css = await route(
      new Request("https://web.flagshipserver.com/style.css"),
      makeEnv(),
    );
    expect(await css.text()).toBe("asset:/webapp/style.css");
    const js = await route(
      new Request("https://web.flagshipserver.com/lib/api.js"),
      makeEnv(),
    );
    expect(await js.text()).toBe("asset:/webapp/lib/api.js");
  });

  it("/ on web. host still serves /webapp/ (binding serves index.html) — unchanged", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/"),
      makeEnv(),
    );
    expect(await r.text()).toBe("asset:/webapp/");
  });

  // Apex-aware: the gym webapp host is web.<CONTROL_APEX>.
  it("/join on the GYM webapp host (web.gym.flagshipserver.com) serves the webapp index.html", async () => {
    const env = makeEnv({ CONTROL_APEX: "gym.flagshipserver.com" });
    const r = await route(
      new Request("https://web.gym.flagshipserver.com/join?sid=x&pk=y"),
      env,
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/index.html");
  });

  it("a gym webapp asset file still rewrites to /webapp/<file>", async () => {
    const env = makeEnv({ CONTROL_APEX: "gym.flagshipserver.com" });
    const r = await route(
      new Request("https://web.gym.flagshipserver.com/manifest.json"),
      env,
    );
    expect(await r.text()).toBe("asset:/webapp/manifest.json");
  });

  // The CONTROL apex must be UNCHANGED: there /join is the native universal
  // link and the web fallback is the marketing surface — it must NEVER route
  // into serveWebapp / the webapp index.html.
  it("/join on the CONTROL apex (flagshipserver.com) is NOT the webapp — coming-soon without the preview cookie", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/join"),
      makeEnv(),
    );
    // Pre-launch gate: an un-cookied visitor sees the coming-soon page, not
    // the webapp shell.
    expect(await r.text()).toBe("asset:/coming-soon.html");
  });

  it("/join on the CONTROL apex with the preview cookie falls through to the marketing asset, NOT /webapp/index.html", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/join", {
        headers: { cookie: "flagship_preview=1" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    // The marketing SPA fallback (asset binding) — explicitly NOT the webapp.
    const body = await r.text();
    expect(body).toBe("asset:/join");
    expect(body).not.toBe("asset:/webapp/index.html");
  });

  it("/join on the GYM control apex (gym.flagshipserver.com) is also NOT the webapp", async () => {
    const env = makeEnv({ CONTROL_APEX: "gym.flagshipserver.com" });
    const r = await route(
      new Request("https://gym.flagshipserver.com/join", {
        headers: { cookie: "flagship_preview=1" },
      }),
      env,
    );
    const body = await r.text();
    expect(body).toBe("asset:/join");
    expect(body).not.toBe("asset:/webapp/index.html");
  });
});

describe("/transfer — take-over universal-link browser fallback", () => {
  // On the CONTROL apex the app (when installed) intercepts /transfer?o=… as a
  // universal link / App-Link and never hits the Worker. When it's NOT installed
  // the browser lands here; the Worker 308-redirects to the webapp's own origin,
  // preserving ?o= so the PWA boots into the claim view. Placed before the
  // coming-soon gate → works with no preview cookie (a real acquirer's case).

  it("308-redirects /transfer?o=… to the webapp origin, preserving the offer payload", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/transfer?o=eyJhIjoxfQ"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(
      "https://web.flagshipserver.com/transfer?o=eyJhIjoxfQ",
    );
  });

  it("redirects the trailing-slash variant too", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/transfer/?o=abc"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(
      "https://web.flagshipserver.com/transfer?o=abc",
    );
  });

  it("fires WITHOUT the preview cookie (ungated — before the coming-soon gate)", async () => {
    // A real acquirer opening the link has no preview cookie; the fallback
    // must still reach the webapp, not the coming-soon page.
    const r = await route(
      new Request("https://flagshipserver.com/transfer?o=xyz"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(
      "https://web.flagshipserver.com/transfer?o=xyz",
    );
  });

  it("does not hit the proxy fall-through (no upstream fetch)", async () => {
    await route(
      new Request("https://flagshipserver.com/transfer?o=xyz"),
      makeEnv(),
    );
    expect(calls).toEqual([]);
  });

  it("/transfer on the web. host serves the webapp index.html (client route → SPA boots)", async () => {
    // The redirect target: an extensionless client route on the webapp host
    // hands back the webapp shell so dispatchInitialView() can read ?o=.
    const r = await route(
      new Request("https://web.flagshipserver.com/transfer?o=xyz"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/webapp/index.html");
  });
});

describe("CORS — cross-origin webapp → apex /api/* calls", () => {
  it("answers OPTIONS preflight from web. with the right ACL headers", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/recovery", {
        method: "OPTIONS",
        headers: { origin: "https://web.flagshipserver.com" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(
      "https://web.flagshipserver.com",
    );
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
    expect(r.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect(r.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("attaches access-control-allow-origin to /api/* responses for allow-listed origin", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/health", {
        headers: { origin: "https://web.flagshipserver.com" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(
      "https://web.flagshipserver.com",
    );
    expect(r.headers.get("vary")).toMatch(/origin/i);
  });

  it("does NOT attach CORS headers for an unlisted origin (defense in depth)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/health", {
        headers: { origin: "https://evil.example.com" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does NOT touch non-/api responses (marketing site stays plain)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/", {
        headers: { origin: "https://web.flagshipserver.com" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("preflight refuses to echo an unlisted origin (returns 204 with no ACL-Origin)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/recovery", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("/api/build/iso-info", () => {
  it("returns the default placeholder when no env override is set", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/build/iso-info"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.url).toBe(_internal.DEFAULT_BASE_ISO_URL);
    expect(body.version).toBe(_internal.DEFAULT_BASE_ISO_VERSION);
    expect(body.placeholder).toBe(true);
  });

  it("uses BASE_ISO_URL/BASE_ISO_VERSION/BASE_ISO_SHA256 when provided", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/build/iso-info"),
      makeEnv({
        BASE_ISO_URL: "https://r2.example/flagship-1.2.3.iso",
        BASE_ISO_VERSION: "1.2.3",
        BASE_ISO_SHA256: "deadbeef",
      }),
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.url).toBe("https://r2.example/flagship-1.2.3.iso");
    expect(body.version).toBe("1.2.3");
    expect(body.sha256).toBe("deadbeef");
    expect(body.placeholder).toBe(false);
  });

  it("never falls through to the upstream proxy or asset binding", async () => {
    const env = makeEnv();
    const assetSpy = vi.spyOn(env.ASSETS, "fetch");
    await route(new Request("https://flagshipserver.com/api/build/iso-info"), env);
    expect(assetSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("qr-pipe relay routes (v2 protocol)", () => {
  function makeRelayStub() {
    const upgraded: Request[] = [];
    const stub: any = {
      newUniqueId: () => ({ toString: () => "do-from-uniq" }),
      idFromName: (n: string) => ({ toString: () => `do-by-name-${n}` }),
      idFromString: (s: string) => ({ toString: () => s }),
      get: (id: any) => ({
        async fetch(req: Request) {
          upgraded.push(req);
          return new Response("upgraded", { status: 200 });
        },
      }),
      _upgraded: upgraded,
    };
    return stub;
  }

  it("/api/build-relay/sessions is retired with 410 (was the v1 mint POST)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/build-relay/sessions", {
        method: "POST",
      }),
      makeEnv({ BUILD_RELAY: makeRelayStub() }),
    );
    expect(r.status).toBe(410);
  });

  it("/qr-pipe/<sid> forwards a browser-role upgrade to the DO addressed by name", async () => {
    const BUILD_RELAY = makeRelayStub();
    const r = await route(
      new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=browser", {
        headers: { upgrade: "websocket" },
      }),
      makeEnv({ BUILD_RELAY }),
    );
    expect(r.status).toBe(200);
    expect(BUILD_RELAY._upgraded).toHaveLength(1);
    expect(BUILD_RELAY._upgraded[0].url).toMatch(/role=browser/);
  });

  it("/qr-pipe/<sid> forwards a phone-role upgrade", async () => {
    const BUILD_RELAY = makeRelayStub();
    const r = await route(
      new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=phone", {
        headers: { upgrade: "websocket" },
      }),
      makeEnv({ BUILD_RELAY }),
    );
    expect(r.status).toBe(200);
    expect(BUILD_RELAY._upgraded[0].url).toMatch(/role=phone/);
  });

  it("/qr-pipe/<sid> without upgrade header returns 426", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-"),
      makeEnv({ BUILD_RELAY: makeRelayStub() }),
    );
    expect(r.status).toBe(426);
  });

  it("/qr-pipe/<bad-sid> returns 400", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/qr-pipe/short?role=browser", {
        headers: { upgrade: "websocket" },
      }),
      makeEnv({ BUILD_RELAY: makeRelayStub() }),
    );
    expect(r.status).toBe(400);
  });

  it("503 when BUILD_RELAY binding is missing", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=browser", {
        headers: { upgrade: "websocket" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(503);
  });

  describe("rate-limit (P2)", () => {
    function makeQrPipeRateBinding(allow: boolean) {
      const calls: string[] = [];
      return {
        binding: {
          async limit({ key }: { key: string }) {
            calls.push(key);
            return { success: allow };
          },
        },
        calls,
      };
    }

    it("returns 429 when RATE_LIMITER_QR_PIPE rejects, never reaches the DO", async () => {
      const BUILD_RELAY = makeRelayStub();
      const { binding, calls } = makeQrPipeRateBinding(false);
      const r = await route(
        new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=browser", {
          headers: { upgrade: "websocket", "cf-connecting-ip": "9.9.9.9" },
        }),
        makeEnv({ BUILD_RELAY, RATE_LIMITER_QR_PIPE: binding }),
      );
      expect(r.status).toBe(429);
      const body = JSON.parse(await r.text());
      expect(body.endpoint).toBe("qr-pipe-upgrade");
      expect(body.limit).toBe("ip");
      // Most importantly — the DO upgrade never fired. The whole point
      // of the gate is that throttled requests don't spawn DOs.
      expect(BUILD_RELAY._upgraded).toHaveLength(0);
      expect(calls).toEqual(["qr-pipe-upgrade|ip|9.9.9.9"]);
    });

    it("passes through when the binding allows and the DO upgrade runs as before", async () => {
      const BUILD_RELAY = makeRelayStub();
      const { binding } = makeQrPipeRateBinding(true);
      const r = await route(
        new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=phone", {
          headers: { upgrade: "websocket", "cf-connecting-ip": "9.9.9.9" },
        }),
        makeEnv({ BUILD_RELAY, RATE_LIMITER_QR_PIPE: binding }),
      );
      expect(r.status).toBe(200);
      expect(BUILD_RELAY._upgraded).toHaveLength(1);
    });

    it("is a no-op when the binding isn't configured (defense-in-depth, not a hard requirement)", async () => {
      const BUILD_RELAY = makeRelayStub();
      const r = await route(
        new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=browser", {
          headers: { upgrade: "websocket", "cf-connecting-ip": "9.9.9.9" },
        }),
        makeEnv({ BUILD_RELAY /* RATE_LIMITER_QR_PIPE deliberately omitted */ }),
      );
      expect(r.status).toBe(200);
      expect(BUILD_RELAY._upgraded).toHaveLength(1);
    });

    it("invalid-sid 400 short-circuits BEFORE the rate-limit check (no budget waste)", async () => {
      const BUILD_RELAY = makeRelayStub();
      const { binding, calls } = makeQrPipeRateBinding(true);
      const r = await route(
        new Request("https://flagshipserver.com/qr-pipe/short?role=browser", {
          headers: { upgrade: "websocket", "cf-connecting-ip": "9.9.9.9" },
        }),
        makeEnv({ BUILD_RELAY, RATE_LIMITER_QR_PIPE: binding }),
      );
      expect(r.status).toBe(400);
      // The limiter should NOT have been hit — sid validation is a
      // free, deterministic gate. Burning rate-limit budget on
      // obvious garbage would let attackers exhaust the limiter for
      // legitimate users.
      expect(calls).toHaveLength(0);
    });
  });

  describe("qr-pipe metrics (P3 — D1-backed daily counters)", () => {
    /**
     * Captures every D1 prepare()+bind()+run() call against the
     * Worker's DB so we can assert that the qr_pipe_metrics row was
     * incremented on the right path. The route handler awaits the
     * increment, so by the time `route()` returns the run() has
     * already been observed by this stub.
     */
    function makeDbSpy() {
      const runs: { query: string; bound: unknown[] }[] = [];
      const db = {
        prepare(query: string) {
          let bound: unknown[] = [];
          const stmt: any = {
            bind(...values: unknown[]) {
              bound = values;
              return stmt;
            },
            async run() {
              runs.push({ query, bound });
              return { success: true, meta: { changes: 1 } };
            },
            async all() {
              return { results: [], success: true, meta: {} };
            },
            async first() { return null; },
          };
          return stmt;
        },
        async batch() { return []; },
      };
      return { db, runs };
    }

    it("a successful upgrade records an upgrade_count increment for today's bucket", async () => {
      const BUILD_RELAY = makeRelayStub();
      const { db, runs } = makeDbSpy();
      const r = await route(
        new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=browser", {
          headers: { upgrade: "websocket", "cf-connecting-ip": "9.9.9.9" },
        }),
        makeEnv({ BUILD_RELAY, DB: db as unknown as import("@flagship/storage").D1Database }),
      );
      expect(r.status).toBe(200);
      const insert = runs.find((x) => /upgrade_count = upgrade_count \+ 1/.test(x.query));
      expect(insert).toBeDefined();
      // First bound value is the UTC bucket key — must look like a date.
      expect(insert!.bound[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("a rate-limited upgrade records rate_limited_count, not upgrade_count", async () => {
      const BUILD_RELAY = makeRelayStub();
      const { db, runs } = makeDbSpy();
      const { binding } = (() => {
        return {
          binding: {
            async limit() { return { success: false }; },
          },
        };
      })();
      const r = await route(
        new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=browser", {
          headers: { upgrade: "websocket", "cf-connecting-ip": "9.9.9.9" },
        }),
        makeEnv({
          BUILD_RELAY,
          RATE_LIMITER_QR_PIPE: binding,
          DB: db as unknown as import("@flagship/storage").D1Database,
        }),
      );
      expect(r.status).toBe(429);
      expect(runs.some((x) => /rate_limited_count = rate_limited_count \+ 1/.test(x.query))).toBe(true);
      expect(runs.some((x) => /upgrade_count = upgrade_count \+ 1/.test(x.query))).toBe(false);
    });

    it("works when DB binding is absent (metrics is best-effort)", async () => {
      const BUILD_RELAY = makeRelayStub();
      const r = await route(
        new Request("https://flagshipserver.com/qr-pipe/abc123XYZ_def456-?role=browser", {
          headers: { upgrade: "websocket", "cf-connecting-ip": "9.9.9.9" },
        }),
        makeEnv({ BUILD_RELAY /* DB omitted */ }),
      );
      // Upgrade still succeeds; the response is unaffected by the
      // metrics path. A missing DB is normal in local dev.
      expect(r.status).toBe(200);
    });

    it("/api/_status/relay returns recent buckets as JSON", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const db = {
        prepare(query: string) {
          let bound: unknown[] = [];
          const stmt: any = {
            bind(...vals: unknown[]) { bound = vals; return stmt; },
            async first() { return null; },
            async all() {
              if (!/SELECT bucket_day.*qr_pipe_metrics/s.test(query)) {
                throw new Error(`unexpected: ${query}`);
              }
              expect(typeof bound[0]).toBe("number"); // LIMIT bound
              return {
                results: [
                  { bucket_day: today,     upgrade_count: 42, rate_limited_count: 3, updated_at: 1 },
                  { bucket_day: yesterday, upgrade_count: 17, rate_limited_count: 1, updated_at: 2 },
                ],
                success: true,
                meta: {},
              };
            },
            async run() { return { success: true, meta: {} }; },
          };
          return stmt;
        },
        async batch() { return []; },
      };
      const r = await route(
        new Request("https://flagshipserver.com/api/_status/relay"),
        makeEnv({ DB: db as unknown as import("@flagship/storage").D1Database }),
      );
      expect(r.status).toBe(200);
      const body = JSON.parse(await r.text());
      expect(body.buckets).toHaveLength(2);
      expect(body.buckets[0]).toEqual({ day: today, upgrades: 42, rateLimited: 3, updatedAt: 1 });
      expect(body.buckets[1]).toEqual({ day: yesterday, upgrades: 17, rateLimited: 1, updatedAt: 2 });
      expect(typeof body.now).toBe("string");
    });

    it("/api/_status/relay honours ?days=N", async () => {
      let seenLimit: unknown = null;
      const db = {
        prepare(query: string) {
          let bound: unknown[] = [];
          const stmt: any = {
            bind(...vals: unknown[]) { bound = vals; return stmt; },
            async first() { return null; },
            async all() {
              if (/SELECT bucket_day/.test(query)) {
                seenLimit = bound[0];
                return { results: [], success: true, meta: {} };
              }
              throw new Error(`unexpected: ${query}`);
            },
            async run() { return { success: true, meta: {} }; },
          };
          return stmt;
        },
        async batch() { return []; },
      };
      await route(
        new Request("https://flagshipserver.com/api/_status/relay?days=7"),
        makeEnv({ DB: db as unknown as import("@flagship/storage").D1Database }),
      );
      expect(seenLimit).toBe(7);
    });

    it("/api/_status/relay returns an empty buckets array when DB is unbound", async () => {
      const r = await route(
        new Request("https://flagshipserver.com/api/_status/relay"),
        makeEnv(),
      );
      expect(r.status).toBe(200);
      const body = JSON.parse(await r.text());
      expect(body.buckets).toEqual([]);
    });
  });
});

describe("recovery.flagshipserver.com — dedicated WebAuthn-PRF origin (Task #73)", () => {
  it("/ on recovery host fetches ASSETS /recovery/ (binding serves index.html)", async () => {
    const r = await route(
      new Request("https://recovery.flagshipserver.com/"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/recovery/");
  });

  it("/recovery.js on recovery host fetches ASSETS /recovery/recovery.js", async () => {
    const r = await route(
      new Request("https://recovery.flagshipserver.com/recovery.js"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/recovery/recovery.js");
  });

  it("every response carries a strict Content-Security-Policy header", async () => {
    const r = await route(
      new Request("https://recovery.flagshipserver.com/"),
      makeEnv(),
    );
    const csp = r.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Critically: no inline scripts permitted on this origin.
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("POST/DELETE/PUT to recovery host is rejected with 405 (it's GET-only)", async () => {
    for (const method of ["POST", "DELETE", "PUT", "PATCH"]) {
      const r = await route(
        new Request("https://recovery.flagshipserver.com/", {
          method,
          body: method === "POST" || method === "PUT" || method === "PATCH" ? "{}" : undefined,
        }),
        makeEnv(),
      );
      expect(r.status).toBe(405);
      // Even the 405 carries the CSP — no XSS escape via error pages.
      expect(r.headers.get("content-security-policy")).toBeTruthy();
    }
  });

  it("apex /recovery/ 308-redirects to the dedicated sub-origin", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/recovery/"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://recovery.flagshipserver.com/");
  });

  it("apex /recovery (no trailing slash) also redirects to sub-origin /", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/recovery"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://recovery.flagshipserver.com/");
  });

  it("apex /recovery/anything preserves the tail + query when redirecting", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/recovery/foo.js?v=1#x"),
      makeEnv(),
    );
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(
      "https://recovery.flagshipserver.com/foo.js?v=1",
    );
  });

  it("CORS allowlist includes the recovery origin (so /api/recovery POSTs from there succeed)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/recovery", {
        method: "OPTIONS",
        headers: { origin: "https://recovery.flagshipserver.com" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(
      "https://recovery.flagshipserver.com",
    );
  });

  it("HEAD works on recovery host (some browsers preflight static assets)", async () => {
    const r = await route(
      new Request("https://recovery.flagshipserver.com/", { method: "HEAD" }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
  });
});

describe("/.well-known/apple-app-site-association — Universal Link binding", () => {
  it("rewrites Content-Type to application/json + sets a short cache header", async () => {
    const aasaJson = JSON.stringify({
      applinks: { details: [{ appIDs: ["8G8RHBU9BN.com.flagshipserver.app"] }] },
    });
    const env = makeEnv({
      ASSETS: {
        async fetch(req) {
          // The Worker asks the asset binding for the file verbatim;
          // here we hand it back with the wrong default content-type
          // Cloudflare actually serves it as (extension-less file).
          expect(new URL(req.url).pathname).toBe("/.well-known/apple-app-site-association");
          return new Response(aasaJson, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        },
      },
    });
    const r = await route(
      new Request("https://flagshipserver.com/.well-known/apple-app-site-association"),
      env,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("cache-control")).toMatch(/public/);
    expect(await r.json()).toEqual(JSON.parse(aasaJson));
  });

  it("propagates upstream status when the file is missing", async () => {
    const env = makeEnv({
      ASSETS: {
        async fetch() {
          return new Response("not found", { status: 404 });
        },
      },
    });
    const r = await route(
      new Request("https://flagshipserver.com/.well-known/apple-app-site-association"),
      env,
    );
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toBe("application/json");
  });

  it("does not hit the proxy fall-through (no upstream fetch call)", async () => {
    await route(
      new Request("https://flagshipserver.com/.well-known/apple-app-site-association"),
      makeEnv(),
    );
    // proxyToServices uses globalThis.fetch — should never fire.
    expect(calls).toEqual([]);
  });
});

describe("/.well-known/assetlinks.json — Android App Links binding", () => {
  it("falls through to the ASSETS binding (no manual route handler needed)", async () => {
    const assetlinks = JSON.stringify([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "com.flagshipserver.app",
        sha256_cert_fingerprints: ["3C:BF:B3:A6:75:A9:E0:73:91:D6:1C:25:58:D9:91:0C:E0:1D:A9:7C:2D:F3:55:9E:58:02:A2:94:ED:8F:7C:DD"],
      },
    }]);
    const env = makeEnv({
      ASSETS: {
        async fetch(req) {
          // .json extension means Cloudflare's asset binding serves
          // application/json by default — we don't need a manual
          // handler, unlike AASA.
          expect(new URL(req.url).pathname).toBe("/.well-known/assetlinks.json");
          return new Response(assetlinks, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    const r = await route(
      new Request("https://flagshipserver.com/.well-known/assetlinks.json"),
      env,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual(JSON.parse(assetlinks));
  });

  it("does not hit the proxy fall-through", async () => {
    await route(
      new Request("https://flagshipserver.com/.well-known/assetlinks.json"),
      makeEnv(),
    );
    expect(calls).toEqual([]);
  });
});

describe("Pre-launch stealth gate (/wip_ + /alpha + coming-soon)", () => {
  it("apex / returns coming-soon HTML when the preview cookie is missing", async () => {
    const env = makeEnv();
    const r = await route(new Request("https://flagshipserver.com/"), env);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toBe("asset:/coming-soon.html");
  });

  it("apex marketing paths (/faq.html, /deck/, /blog/, /docs/) all return coming-soon", async () => {
    for (const p of ["/faq.html", "/deck/", "/blog/", "/docs/", "/status/"]) {
      const r = await route(new Request(`https://flagshipserver.com${p}`), makeEnv());
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toBe("asset:/coming-soon.html");
    }
  });

  it("preview cookie bypasses the gate so the real asset is served", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/faq.html", {
        headers: { cookie: "x=1; flagship_preview=1; y=2" },
      }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/faq.html");
  });

  it("SITE_PUBLIC=1 lifts the gate for everyone (open-beta launch, no cookie)", async () => {
    for (const p of ["/", "/faq.html", "/deck/", "/docs/"]) {
      const r = await route(
        new Request(`https://flagshipserver.com${p}`),
        makeEnv({ SITE_PUBLIC: "1" }),
      );
      expect(r.status, p).toBe(200);
      const body = await r.text();
      expect(body, p).not.toBe("asset:/coming-soon.html");
    }
  });

  it("SITE_PUBLIC unset keeps the gate armed (still coming-soon)", async () => {
    const r = await route(new Request("https://flagshipserver.com/"), makeEnv());
    expect(await r.text()).toBe("asset:/coming-soon.html");
  });

  it("exempt static essentials are always served even without the cookie", async () => {
    for (const p of [
      "/coming-soon.html",
      "/favicon.svg",
      "/apple-touch-icon.svg",
      "/404.html",
      "/.well-known/security.txt",
      "/.well-known/assetlinks.json",
    ]) {
      const r = await route(new Request(`https://flagshipserver.com${p}`), makeEnv());
      expect(await r.text(), p).toBe(`asset:${p}`);
    }
  });

  it("/api/* still proxies to .services even without the cookie (apps keep working)", async () => {
    await route(
      new Request("https://flagshipserver.com/api/me/servers"),
      makeEnv(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://flagship.services/api/me/servers");
  });

  it("/og and /api/health still work without the cookie", async () => {
    const og = await route(
      new Request("https://flagshipserver.com/og?title=hi"),
      makeEnv(),
    );
    expect(og.headers.get("content-type")).toMatch(/image\/svg/);
    const health = await route(
      new Request("https://flagshipserver.com/api/health"),
      makeEnv(),
    );
    const body = await health.json() as { ok: boolean; surface: string };
    expect(body.ok).toBe(true);
    expect(body.surface).toBe("com");
  });

  it("/me/* and /webapp/* 308-redirects still fire without the cookie", async () => {
    const me = await route(new Request("https://flagshipserver.com/me/profile"), makeEnv());
    expect(me.status).toBe(308);
    expect(me.headers.get("location")).toMatch(/^https:\/\/web\.flagshipserver\.com/);
    const webapp = await route(new Request("https://flagshipserver.com/webapp/foo"), makeEnv());
    expect(webapp.status).toBe(308);
  });

  it("/wip_ serves the real index.html and sets the preview cookie", async () => {
    const r = await route(new Request("https://flagshipserver.com/wip_"), makeEnv());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/");
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/flagship_preview=1/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/SameSite=Lax/);
  });

  it("/wip_/ (trailing slash) is canonicalised to /", async () => {
    const r = await route(new Request("https://flagshipserver.com/wip_/"), makeEnv());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/");
    expect(r.headers.get("set-cookie") ?? "").toMatch(/flagship_preview=1/);
  });

  it("/wip_/<path> strips the prefix and serves the underlying asset", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/wip_/faq.html"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/faq.html");
    expect(r.headers.get("set-cookie") ?? "").toMatch(/flagship_preview=1/);
  });

  it("/wip_/deck/ preserves the trailing slash so the binding serves index.html", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/wip_/deck/"),
      makeEnv(),
    );
    expect(await r.text()).toBe("asset:/deck/");
  });

  it("/wip_/<path>?x=1 preserves the query string", async () => {
    let captured = "";
    const env = makeEnv({
      ASSETS: {
        async fetch(req) {
          captured = req.url;
          return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 });
        },
      },
    });
    await route(
      new Request("https://flagshipserver.com/wip_/faq.html?x=1"),
      env,
    );
    expect(new URL(captured).search).toBe("?x=1");
  });

  it("/wipx (no underscore) is NOT a preview path — gated as usual", async () => {
    const r = await route(new Request("https://flagshipserver.com/wipx"), makeEnv());
    expect(await r.text()).toBe("asset:/coming-soon.html");
  });

  it("/alpha is an alias for /wip_ — serves the real index and sets the cookie", async () => {
    const r = await route(new Request("https://flagshipserver.com/alpha"), makeEnv());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/");
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/flagship_preview=1/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/SameSite=Lax/);
  });

  it("/alpha/ (trailing slash) is canonicalised to /", async () => {
    const r = await route(new Request("https://flagshipserver.com/alpha/"), makeEnv());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/");
    expect(r.headers.get("set-cookie") ?? "").toMatch(/flagship_preview=1/);
  });

  it("/alpha/<path> strips the prefix and serves the underlying asset", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/alpha/faq.html"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/faq.html");
    expect(r.headers.get("set-cookie") ?? "").toMatch(/flagship_preview=1/);
  });

  it("/alpha/<path>?x=1 preserves the query string", async () => {
    let captured = "";
    const env = makeEnv({
      ASSETS: {
        async fetch(req) {
          captured = req.url;
          return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 });
        },
      },
    });
    await route(new Request("https://flagshipserver.com/alpha/faq.html?x=1"), env);
    expect(new URL(captured).search).toBe("?x=1");
  });

  it("/alphabet (no segment boundary) is NOT a preview path — gated as usual", async () => {
    const r = await route(new Request("https://flagshipserver.com/alphabet"), makeEnv());
    expect(await r.text()).toBe("asset:/coming-soon.html");
  });

  it("the gate does not affect web.flagshipserver.com (webapp origin)", async () => {
    const r = await route(
      new Request("https://web.flagshipserver.com/"),
      makeEnv(),
    );
    expect(await r.text()).toBe("asset:/webapp/");
  });

  it("the gate does not affect recovery.flagshipserver.com (recovery origin)", async () => {
    const r = await route(
      new Request("https://recovery.flagshipserver.com/"),
      makeEnv(),
    );
    expect(await r.text()).toBe("asset:/recovery/");
  });
});

describe("/download/<os> — on-brand installer redirect", () => {
  it("302s published installers to their artifacts and unset platforms to the explainer", async () => {
    // Published platforms point at their real artifacts; Linux keeps the
    // coming-soon explainer. The page only exposes stable on-brand routes.
    const mac = await route(
      new Request("https://flagshipserver.com/download/mac"),
      makeEnv(),
    );
    expect(mac.status).toBe(302);
    expect(mac.headers.get("location")).toBe("/downloads/FlagshipStudio.dmg");

    const windows = await route(
      new Request("https://flagshipserver.com/download/windows"),
      makeEnv(),
    );
    expect(windows.status).toBe(302);
    expect(windows.headers.get("location")).toBe(
      "https://github.com/ibisllc/flagship/releases/download/studio-windows-v0.0.1/FlagshipBuilder.exe",
    );

    const linux = await route(
      new Request("https://flagshipserver.com/download/linux"),
      makeEnv(),
    );
    expect(linux.status).toBe(302);
    expect(linux.headers.get("location")).toBe("/docs#burn");
  });

  it("works WITHOUT the preview cookie (download link survives the launch gate)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/download/mac"),
      makeEnv(),
    );
    // Not the coming-soon page — a real redirect.
    expect(r.status).toBe(302);
    expect(await r.text()).toBe("");
  });

  it("an unknown OS slug also falls back to the explainer (no 404)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/download/atari"),
      makeEnv(),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/docs#burn");
  });
});

describe("/studio — canonical desktop-builder page", () => {
  it("serves the short no-slash URL directly, even without a preview cookie", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/studio"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/studio/index.html");
  });

  it("canonicalizes the trailing slash and retires /ready + /build", async () => {
    for (const path of ["/studio/", "/ready", "/ready/", "/build", "/build/"]) {
      const r = await route(
        new Request(`https://flagshipserver.com${path}`),
        makeEnv(),
      );
      expect(r.status, path).toBe(308);
      expect(r.headers.get("location"), path).toBe("/studio");
    }
  });
});

describe("/how-to + /how-to.html — folded into /docs", () => {
  // The standalone explainer was folded into /docs; both the pretty path
  // and the .html form 302 to /docs with NO fragment (the browser keeps the
  // request's own #fragment, so /how-to#recommended-linux → /docs#…).
  for (const path of ["/how-to", "/how-to.html"]) {
    it(`302s ${path} → /docs (no fragment in Location)`, async () => {
      const r = await route(
        new Request(`https://flagshipserver.com${path}`),
        makeEnv(),
      );
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/docs");
    });
  }

  it("redirects WITHOUT the preview cookie (runs before the coming-soon gate)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/how-to"),
      makeEnv(),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/docs");
  });
});

describe("/api/iso-manifest — desktop-builder base-ISO manifest", () => {
  // The control-plane dispatch only runs when DB is bound; the handler
  // itself needs no DB, so a no-op stub is enough to reach it.
  function stubDb(): import("@flagship/storage").D1Database {
    return {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [], success: true, meta: {} }),
          run: async () => ({ success: true, meta: {} }),
        }),
      }),
      batch: async () => [],
    } as unknown as import("@flagship/storage").D1Database;
  }

  const BLESSED = {
    version: "debian-12.7.0-amd64",
    url: "https://r2.example.com/iso/debian-12.7.0-amd64-netinst.iso",
    sha256: "a".repeat(64),
    sizeBytes: 658505728,
    attestation:
      "https://cdimage.debian.org/debian-cd/12.7.0/amd64/iso-cd/SHA256SUMS",
  };

  it("returns { download: null } when FLAGSHIP_ISO_MANIFEST is unset", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/iso-manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "mac",
          builderVersion: "1.2.3",
          current: null,
        }),
      }),
      makeEnv({ DB: stubDb() }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ download: null });
    // Handled locally — no upstream proxy hop.
    expect(calls).toHaveLength(0);
  });

  it("returns the download block when FLAGSHIP_ISO_MANIFEST is set + builder has nothing", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/iso-manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "linux",
          builderVersion: "1.2.3",
          current: null,
        }),
      }),
      makeEnv({ DB: stubDb(), FLAGSHIP_ISO_MANIFEST: JSON.stringify(BLESSED) }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ download: BLESSED });
  });

  it("returns { download: null } when the builder already holds the blessed sha", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/iso-manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "windows",
          builderVersion: "1.2.3",
          current: { version: "debian-12.7.0-amd64", sha256: "a".repeat(64) },
        }),
      }),
      makeEnv({ DB: stubDb(), FLAGSHIP_ISO_MANIFEST: JSON.stringify(BLESSED) }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ download: null });
  });

  it("treats an unparseable FLAGSHIP_ISO_MANIFEST as unconfigured (no throw)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/iso-manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "mac",
          builderVersion: "1.2.3",
          current: null,
        }),
      }),
      makeEnv({ DB: stubDb(), FLAGSHIP_ISO_MANIFEST: "{not json" }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ download: null });
  });

  it("400s on a bad platform", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/iso-manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "freebsd",
          builderVersion: "1.2.3",
          current: null,
        }),
      }),
      makeEnv({ DB: stubDb(), FLAGSHIP_ISO_MANIFEST: JSON.stringify(BLESSED) }),
    );
    expect(r.status).toBe(400);
  });
});

describe("boot.flagshipserver.com — boot operations served by flagship-com", () => {
  // The consolidation: the box/phone-facing /api/boot/* contract now runs on
  // THIS worker, host-dispatched. These cases lock the host wiring (route.ts
  // → tryBootHost); the full unlock flow is in bootHost.integration.test.ts.
  it("/api/health on the boot host reports the boot surface", async () => {
    const r = await route(
      new Request("https://boot.flagshipserver.com/api/health"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; surface: string };
    expect(body.ok).toBe(true);
    expect(body.surface).toBe("boot");
  });

  it("a /api/boot/* path 503s when no DB is bound (reaches tryBootHost, not the proxy)", async () => {
    const r = await route(
      new Request("https://boot.flagshipserver.com/api/boot/lease/kitchen.alice.flagship.services"),
      makeEnv(),
    );
    expect(r.status).toBe(503);
  });

  it("a non-boot path on the boot host 404s (tiny single-purpose surface)", async () => {
    const r = await route(
      new Request("https://boot.flagshipserver.com/faq.html"),
      makeEnv(),
    );
    expect(r.status).toBe(404);
  });

  it("the boot host never falls through to the coming-soon marketing gate", async () => {
    // A bare GET / on the boot host must not serve the marketing coming-soon
    // page — boot is API-only. 404 (not 200 coming-soon).
    const r = await route(
      new Request("https://boot.flagshipserver.com/"),
      makeEnv(),
    );
    expect(r.status).toBe(404);
  });
});
