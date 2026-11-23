import { afterEach, describe, expect, it, vi } from "vitest";
import { coarsePath, route, type RouteEnv } from "../src/route.js";

// F2 (docs/security/F2-2fa-enrolment-investigation.md): a throw anywhere in the
// router used to escape as Cloudflare's error page, with no CORS header, so the
// webapp saw "Failed to fetch". Now it is a JSON 500 that the browser can read.

const throwingDb = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error("D1_ERROR: boom for alice@example.com");
      };
    },
  },
);

function env(): RouteEnv {
  return {
    SERVICES_BASE_URL: "https://flagship.services",
    ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
    DB: throwingDb,
    FLAGSHIP_TOTP_KEK: "11".repeat(32),
  } as unknown as RouteEnv;
}

afterEach(() => vi.restoreAllMocks());

describe("route(): no exception escapes", () => {
  it("answers a throwing route with JSON 500 internal-error, CORS and security headers", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await route(
      new Request("https://flagshipserver.com/api/users/alice/totp/enroll-begin", {
        method: "POST",
        headers: { origin: "https://webapp.flagshipserver.com", "content-type": "application/json", "cf-ray": "8f00aa11bb22cc33-IAD" },
        body: JSON.stringify({ request: { username: "alice", issuedAt: Date.now() }, signature: "00".repeat(64) }),
      }),
      env(),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://webapp.flagshipserver.com");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string; code: string; requestId: string };
    expect(body).toEqual({ error: "internal-error", code: "internal-error", requestId: "8f00aa11bb22cc33-IAD" });
    const lines = log.mock.calls.map((c) => c.join(" "));
    const line = lines.find((l) => l.startsWith("internal-error"));
    expect(line).toBe("internal-error POST /api/users/…/3 Error 8f00aa11bb22cc33-IAD");
    for (const l of lines) {
      expect(l).not.toContain("alice");
    }
  });

  it("gives a fresh request id when there is no ray id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await route(
      new Request("https://flagshipserver.com/api/users/alice/totp/enroll-begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: { username: "alice", issuedAt: Date.now() }, signature: "00".repeat(64) }),
      }),
      env(),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("coarsePath keeps two segments and counts the rest", () => {
    expect(coarsePath("/api/users/alice/totp/disable")).toBe("/api/users/…/3");
    expect(coarsePath("/api/health")).toBe("/api/health");
    expect(coarsePath("/")).toBe("/");
    expect(coarsePath("/Alice.Smith/x")).toBe("/…/x");
  });
});
