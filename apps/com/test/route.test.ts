import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { route, _internal, type RouteEnv } from "../src/route.js";

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
  it("non-/api paths are served by the asset binding (marketing, /deck, /.well-known)", async () => {
    // /webapp/* used to fall through here too, but as of the
    // web.flagshipserver.com migration it 308-redirects to the new
    // origin — see the dedicated `/me + /webapp redirects` describe.
    const r = await route(new Request("https://flagshipserver.com/"), makeEnv());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/");
    const r2 = await route(
      new Request("https://flagshipserver.com/.well-known/security.txt"),
      makeEnv(),
    );
    expect(await r2.text()).toBe("asset:/.well-known/security.txt");
    const r3 = await route(
      new Request("https://flagshipserver.com/deck/"),
      makeEnv(),
    );
    expect(await r3.text()).toBe("asset:/deck/");
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
      new Request("https://flagshipserver.com/build/iso/alpine-3.21.0-x86_64.iso"),
      env,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-length")).toBe("1024");
    expect(r.headers.get("etag")).toBe('"abc123"');
    expect(r.headers.get("content-disposition")).toContain("alpine-3.21.0");
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
      new Request("https://flagshipserver.com/messages"),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/messages");
  });

  it("/webappish (similar prefix to /webapp) is NOT redirected — falls through to assets", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/webappish"),
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
