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
  it("non-/api paths are served by the asset binding (marketing, /webapp, /deck)", async () => {
    const r = await route(new Request("https://flagshipserver.com/"), makeEnv());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("asset:/");
    const r2 = await route(new Request("https://flagshipserver.com/webapp/"), makeEnv());
    expect(await r2.text()).toBe("asset:/webapp/");
    const r3 = await route(
      new Request("https://flagshipserver.com/.well-known/security.txt"),
      makeEnv(),
    );
    expect(await r3.text()).toBe("asset:/.well-known/security.txt");
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
      new Request("https://flagshipserver.com/api/health", {
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
      new Request("https://flagshipserver.com/api/health"),
      makeEnv(),
    );
    expect(calls[0]!.headers["x-forwarded-host"]).toBe("flagshipserver.com");
    expect(calls[0]!.headers["x-forwarded-proto"]).toBe("https");
  });

  it("returns 500 if SERVICES_BASE_URL is not absolute (misconfig guard)", async () => {
    const r = await route(
      new Request("https://flagshipserver.com/api/health"),
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
      new Request("https://flagshipserver.com/api/health"),
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
      new Request("https://flagshipserver.com/api/health", { method: "HEAD" }),
      makeEnv(),
    );
    expect(calls[0]!.body).toBeUndefined();
  });
});
