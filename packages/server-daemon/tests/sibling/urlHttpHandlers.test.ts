import { describe, expect, it } from "vitest";
import { InMemoryAppAuthTokens } from "../../src/appAuthToken.js";
import { buildUrlHttpHandlers } from "../../src/sibling/urlHttpHandlers.js";
import type { HttpRequest, UrlController } from "../../src/runtime.js";

const POD = "home.alice.flagship.services";
const APP_A = "alice-notes";
const APP_B = "alice-tasks";

function inMemoryUrlController(): UrlController & { _list: Set<string> } {
  const set = new Set<string>();
  return {
    _list: set,
    async claim(f: string) {
      set.add(f.toLowerCase());
    },
    async release(f: string) {
      set.delete(f.toLowerCase());
    },
    list(): string[] {
      return [...set];
    },
  };
}

async function setup() {
  const tokens = new InMemoryAppAuthTokens();
  const tokenA = await tokens.mint(APP_A);
  const tokenB = await tokens.mint(APP_B);
  const ctrl = inMemoryUrlController();
  const handle = buildUrlHttpHandlers({
    appAuthTokens: tokens,
    urlController: ctrl,
    thisSiblingId: POD,
    canonicalFqdnsForApp: (appId) => {
      if (appId === APP_A) return [`notes.${POD}`];
      if (appId === APP_B) return [`tasks.${POD}`];
      return [];
    },
    now: () => 2_000,
  });
  return { tokens, tokenA, tokenB, ctrl, handle };
}

function req(opts: {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}): HttpRequest {
  return {
    method: opts.method,
    path: opts.path,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    body: Buffer.from(opts.body !== undefined ? JSON.stringify(opts.body) : ""),
  };
}

describe("/api/url/claim — thin pass-through under entitlement model", () => {
  it("forwards to urlController.claim and tracks the URL", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/claim",
        token: s.tokenA,
        body: { fqdn: "notes.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(s.ctrl._list.has("notes.alice.flagship.services")).toBe(true);
  });

  it("REJECTS attempts to claim canonical URLs", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/claim",
        token: s.tokenA,
        body: { fqdn: POD },
      }),
    );
    expect(r?.status).toBe(400);
  });

  it("rejects an unauthenticated request", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/claim",
        body: { fqdn: "notes.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(401);
  });

  it("rejects malformed body", async () => {
    const s = await setup();
    const r = await s.handle(
      req({ method: "POST", path: "/api/url/claim", token: s.tokenA, body: { wrong: "shape" } }),
    );
    expect(r?.status).toBe(400);
  });
});

describe("/api/url/release", () => {
  it("removes the fqdn from urlController state", async () => {
    const s = await setup();
    await s.ctrl.claim("notes.alice.flagship.services");
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/release",
        token: s.tokenA,
        body: { fqdn: "notes.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(s.ctrl._list.size).toBe(0);
  });

  it("is a no-op when the fqdn isn't tracked locally", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/release",
        token: s.tokenA,
        body: { fqdn: "tasks.alice.flagship.services" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(s.ctrl._list.size).toBe(0);
  });

  it("REJECTS attempts to release canonical URLs", async () => {
    const s = await setup();
    const r = await s.handle(
      req({
        method: "POST",
        path: "/api/url/release",
        token: s.tokenA,
        body: { fqdn: POD },
      }),
    );
    expect(r?.status).toBe(400);
  });
});

describe("/api/url and /api/url/owned", () => {
  it("/api/url lists the calling app's canonical FQDNs + currently-owned URLs", async () => {
    const s = await setup();
    await s.ctrl.claim("notes.alice.flagship.services");
    const r = await s.handle(req({ method: "GET", path: "/api/url", token: s.tokenA }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body)) as {
      urls: Array<{ fqdn: string; kind: string; ownedBy: string | null }>;
    };
    const byFqdn = Object.fromEntries(body.urls.map((u) => [u.fqdn, u]));
    expect(byFqdn[`notes.${POD}`]).toMatchObject({
      kind: "canonical",
      ownedBy: "self",
    });
    expect(byFqdn["notes.alice.flagship.services"]).toMatchObject({
      kind: "alias",
      ownedBy: "self",
    });
  });

  it("/api/url for app B returns only B's canonical (not A's owned URLs)", async () => {
    const s = await setup();
    const r = await s.handle(req({ method: "GET", path: "/api/url", token: s.tokenB }));
    const body = JSON.parse(String(r!.body)) as { urls: Array<{ fqdn: string }> };
    const fqdns = body.urls.map((u) => u.fqdn);
    expect(fqdns).toContain(`tasks.${POD}`);
    expect(fqdns).not.toContain(`notes.${POD}`);
  });

  it("/api/url/owned reflects current urlController state", async () => {
    const s = await setup();
    await s.ctrl.claim("notes.alice.flagship.services");
    await s.ctrl.claim("custom.example");
    const r = await s.handle(req({ method: "GET", path: "/api/url/owned", token: s.tokenA }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body)) as { owned: Array<{ fqdn: string }> };
    expect(body.owned.map((x) => x.fqdn).sort()).toEqual(
      ["custom.example", "notes.alice.flagship.services"].sort(),
    );
  });
});
