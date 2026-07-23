import { describe, expect, it } from "vitest";
import { corsPreflight, withCors, isWebappOrigin } from "../src/cors.js";
import type { HttpRequest, HttpResponse } from "../src/runtime.js";

const PROD = "https://webapp.flagshipserver.com";
const GYM = "https://webapp.gym.flagshipserver.com";
const REMOTE = "https://remote.flagshipserver.com";
const REMOTE_GYM = "https://remote.gym.flagshipserver.com";
const LEGACY = "https://web.flagshipserver.com";
const EVIL = "https://evil.example";

function req(over: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "GET",
    path: "/api/front-page",
    headers: {},
    body: Buffer.alloc(0),
    ...over,
  };
}

const okBody: HttpResponse = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ok: true }),
};

describe("isWebappOrigin", () => {
  it("allows the prod + gym webapp origins, rejects everything else", () => {
    expect(isWebappOrigin(PROD)).toBe(true);
    expect(isWebappOrigin(GYM)).toBe(true);
    expect(isWebappOrigin(EVIL)).toBe(false);
    expect(isWebappOrigin("http://webapp.flagshipserver.com")).toBe(false); // scheme matters
    expect(isWebappOrigin("https://flagshipserver.com")).toBe(false); // apex, not webapp
  });

  it("allows the remote origins — without them the remote ceremony can't start", () => {
    // /api/companion/dock/begin is called cross-origin from remote.<apex>
    // BEFORE any session exists; a missing ACAO blocks the whole flow.
    expect(isWebappOrigin(REMOTE)).toBe(true);
    expect(isWebappOrigin(REMOTE_GYM)).toBe(true);
  });

  it("still allows the retired web. origin until the fleet turns over", () => {
    expect(isWebappOrigin(LEGACY)).toBe(true);
    // …but it is NOT a wildcard: a longer label sharing the prefix is refused.
    expect(isWebappOrigin("https://web.evil.flagshipserver.com")).toBe(false);
    expect(isWebappOrigin("https://webapp.evil.com")).toBe(false);
  });
});

describe("corsPreflight", () => {
  it("answers OPTIONS /api/* from an allowed origin with 204 + the full header set", () => {
    for (const origin of [PROD, GYM, REMOTE, REMOTE_GYM]) {
      const r = corsPreflight(req({ method: "OPTIONS", headers: { origin } }));
      expect(r).not.toBeNull();
      expect(r!.status).toBe(204);
      expect(r!.body).toBe("");
      expect(r!.headers!["access-control-allow-origin"]).toBe(origin);
      expect(r!.headers!["vary"]).toBe("origin");
      expect(r!.headers!["access-control-allow-methods"]).toBe("GET, POST, DELETE, OPTIONS");
      expect(r!.headers!["access-control-allow-headers"]).toBe(
        "content-type, x-flagship-session, x-flagship-owner-irk, authorization",
      );
      expect(r!.headers!["access-control-max-age"]).toBe("600");
    }
  });

  it("returns null (falls through) for an evil origin", () => {
    expect(corsPreflight(req({ method: "OPTIONS", headers: { origin: EVIL } }))).toBeNull();
  });

  it("returns null for OPTIONS with no Origin (not a CORS preflight)", () => {
    expect(corsPreflight(req({ method: "OPTIONS" }))).toBeNull();
  });

  it("returns null for OPTIONS on a non-/api path", () => {
    expect(corsPreflight(req({ method: "OPTIONS", path: "/", headers: { origin: PROD } }))).toBeNull();
  });

  it("returns null for a non-OPTIONS method (the real request, not a preflight)", () => {
    expect(corsPreflight(req({ method: "GET", headers: { origin: PROD } }))).toBeNull();
  });
});

describe("withCors", () => {
  it("echoes the specific allowed origin + Vary + the CORS header set onto an /api/* response", () => {
    for (const origin of [PROD, GYM, REMOTE, REMOTE_GYM]) {
      const r = withCors(req({ headers: { origin } }), okBody);
      expect(r.headers!["access-control-allow-origin"]).toBe(origin);
      expect(r.headers!["vary"]).toBe("origin");
      expect(r.headers!["access-control-allow-methods"]).toBe("GET, POST, DELETE, OPTIONS");
      expect(r.headers!["access-control-allow-headers"]).toBe(
        "content-type, x-flagship-session, x-flagship-owner-irk, authorization",
      );
      // Never echo a wildcard, never set credentials.
      expect(r.headers!["access-control-allow-origin"]).not.toBe("*");
      expect(r.headers!["access-control-allow-credentials"]).toBeUndefined();
      // Original headers + body preserved.
      expect(r.headers!["content-type"]).toBe("application/json");
      expect(r.status).toBe(200);
      expect(r.body).toBe(okBody.body);
    }
  });

  it("does NOT echo ACAO for an evil origin", () => {
    const r = withCors(req({ headers: { origin: EVIL } }), okBody);
    expect(r.headers!["access-control-allow-origin"]).toBeUndefined();
  });

  it("is a no-op for a same-origin request (no Origin header)", () => {
    const r = withCors(req(), okBody);
    expect(r.headers!["access-control-allow-origin"]).toBeUndefined();
  });

  it("does NOT add CORS to a non-/api path (app-proxy / apex page scope guard)", () => {
    const r = withCors(req({ path: "/", headers: { origin: PROD } }), okBody);
    expect(r.headers!["access-control-allow-origin"]).toBeUndefined();
  });

  it("matches /api/* with a query string", () => {
    const r = withCors(req({ path: "/api/journal?lines=200", headers: { origin: PROD } }), okBody);
    expect(r.headers!["access-control-allow-origin"]).toBe(PROD);
  });
});
