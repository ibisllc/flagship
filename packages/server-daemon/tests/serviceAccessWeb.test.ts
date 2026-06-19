import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  signKnockAuthorization,
  type KnockAuthorization,
} from "@flagship/protocol";
import {
  ServiceAccessStore,
  ServiceSessionStore,
  SESSION_COOKIE,
  decideServiceAccess,
} from "../src/serviceAccess.js";
import { buildServiceAccessWeb, KNOCK_HOLDER_COOKIE } from "../src/serviceAccessWeb.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "home.alice.flagship.services";
const SERVICE = "alice-notes";
const NOW = 1_700_000_000_000;

const friendUmk = { seed: new Uint8Array(32).fill(0x16) };
const strangerUmk = { seed: new Uint8Array(32).fill(0x33) };
const friendAid = deriveAccountId(friendUmk);
const strangerAid = deriveAccountId(strangerUmk);

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const friendAidHex = hex(friendAid.publicKey);

function tempStore(): ServiceAccessStore {
  return new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "saw-")), "service-access.json"));
}
function tempSessions(): ServiceSessionStore {
  return new ServiceSessionStore(join(mkdtempSync(join(tmpdir(), "saws-")), "service-sessions.json"));
}

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: { host: FQDN }, body: Buffer.alloc(0), ...over };
}

/** A top-level browser navigation (Accept: text/html) to the service origin. */
function browserNav(over: Partial<HttpRequest> = {}): HttpRequest {
  return req({
    headers: {
      host: `notes.${FQDN}`,
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (Test)",
      ...(over.headers ?? {}),
    },
    ...over,
  });
}

function pageIdFromHtml(html: string): string {
  const m = /&page=([0-9a-f]+)/.exec(html);
  if (!m) throw new Error("no pageId in knock page");
  return m[1]!;
}
function cookieValue(setCookie: string | undefined, name: string): string | null {
  if (!setCookie) return null;
  const m = new RegExp(`${name}=([^;]+)`).exec(setCookie);
  return m ? m[1]! : null;
}

function knockAuthBody(
  pageId: string,
  opts: {
    aid?: { publicKey: Uint8Array };
    signer?: { privateKey: Uint8Array };
    at?: number;
    serverId?: string;
    serviceRef?: string;
    tamperPageId?: string;
  } = {},
): Buffer {
  const aid = opts.aid ?? friendAid;
  const signer = opts.signer ?? friendAid;
  const k: KnockAuthorization = {
    serverId: opts.serverId ?? FQDN,
    serviceRef: opts.serviceRef ?? SERVICE,
    pageId,
    visitorAID: aid.publicKey,
    issuedAt: opts.at ?? NOW,
  };
  const sig = signKnockAuthorization(k, signer as { privateKey: Uint8Array; publicKey: Uint8Array });
  // tamperPageId: ship a DIFFERENT pageId than the one that was signed.
  const shipped = { ...k, pageId: opts.tamperPageId ?? k.pageId, visitorAID: hex(k.visitorAID) };
  return Buffer.from(JSON.stringify({ authorization: shipped, sig: hex(sig) }));
}

/** A restricted service with the friend AID allow-listed + the web handler over a shared clock. */
async function harness() {
  const store = tempStore();
  await store.load();
  await store.setMode(SERVICE, "restricted");
  await store.addAllowed(SERVICE, friendAidHex);
  const sessions = tempSessions();
  await sessions.load();
  let clock = NOW;
  const web = buildServiceAccessWeb({
    serverId: FQDN,
    store,
    sessions,
    now: () => clock,
    statusRateMs: 60_000,
  });
  return { store, sessions, web, setClock: (t: number) => (clock = t), now: () => clock };
}

describe("web-experience gating — knock page", () => {
  it("serves a self-contained knock page (HTML + holder cookie + pageId) on a browser nav", async () => {
    const { web } = await harness();
    const res = web.maybeServeKnock(SERVICE, browserNav());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers["content-type"]).toContain("text/html");
    const html = String(res!.body);
    expect(html).toContain("Access is restricted");
    // Self-contained: no remote asset FETCHES (the SVG's xmlns is a namespace
    // identifier, not a fetch — only <link>/<script src>/<img src>/@import/url()
    // would leak a visitor to another origin).
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import|url\(\s*https?:/i);
    expect(html).toContain("noindex");
    // Holder cookie set, scoped + httponly.
    const holder = cookieValue(res!.headers["set-cookie"], KNOCK_HOLDER_COOKIE);
    expect(holder).toMatch(/^[0-9a-f]+$/);
    expect(res!.headers["set-cookie"]).toContain("HttpOnly");
    // Embedded deeplink with the right params.
    expect(html).toContain("flagship://access?");
    expect(html).toContain(`ref=${SERVICE}`);
    expect(pageIdFromHtml(html)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does NOT serve the knock page to a non-browser (XHR/asset) request", async () => {
    const { web } = await harness();
    expect(web.maybeServeKnock(SERVICE, req({ headers: { host: `notes.${FQDN}`, accept: "application/json" } }))).toBeNull();
    expect(web.maybeServeKnock(SERVICE, req({ method: "POST", headers: { host: `notes.${FQDN}`, accept: "text/html" } }))).toBeNull();
  });
});

describe("web-experience gating — authorize + poll", () => {
  it("phone authorize → holder poll receives the session cookie (single-use), which then reaches the service", async () => {
    const { web, store, sessions, now } = await harness();
    const knockRes = web.maybeServeKnock(SERVICE, browserNav())!;
    const html = String(knockRes.body);
    const pageId = pageIdFromHtml(html);
    const holder = cookieValue(knockRes.headers["set-cookie"], KNOCK_HOLDER_COOKIE)!;

    // Phone authorizes (AID-signed, allow-listed).
    const authRes = (await web.handle(
      req({ method: "POST", path: "/api/service-access/knock/authorize", body: knockAuthBody(pageId) }),
    ))!;
    expect(authRes.status).toBe(200);
    const auth = JSON.parse(String(authRes.body));
    expect(auth.authorized).toBe(true);
    expect(auth.secretId).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.serviceRef).toBe(SERVICE);

    // The HOLDER browser polls → authorized + Set-Cookie session.
    const pollRes = (await web.handle(
      req({ path: `/__flagship/knock/${pageId}/status`, headers: { host: `notes.${FQDN}`, cookie: `${KNOCK_HOLDER_COOKIE}=${holder}` } }),
    ))!;
    expect(JSON.parse(String(pollRes.body)).status).toBe("authorized");
    const sessTok = cookieValue(pollRes.headers["set-cookie"], SESSION_COOKIE);
    expect(sessTok).toMatch(/^[0-9a-f]+$/);

    // That session cookie now reaches the restricted service.
    const decision = decideServiceAccess(
      { serverId: FQDN, store, sessions, now },
      SERVICE,
      req({ headers: { host: `notes.${FQDN}`, cookie: `${SESSION_COOKIE}=${sessTok}` } }),
    );
    expect(decision).toEqual({ allow: true, reason: "cookie" });

    // Single-use: a second poll of the consumed page returns "pending" (NOT a
    // distinct "unknown" — the L fix removes the pageId-existence oracle) and no
    // second cookie.
    const poll2 = (await web.handle(
      req({ path: `/__flagship/knock/${pageId}/status`, headers: { host: `notes.${FQDN}`, cookie: `${KNOCK_HOLDER_COOKIE}=${holder}` } }),
    ))!;
    expect(JSON.parse(String(poll2.body)).status).toBe("pending");
    expect((poll2.headers as Record<string, string>)["set-cookie"]).toBeUndefined();
  });

  it("a NON-holder poller never receives the session cookie (race-fix)", async () => {
    const { web } = await harness();
    const knockRes = web.maybeServeKnock(SERVICE, browserNav())!;
    const pageId = pageIdFromHtml(String(knockRes.body));
    await web.handle(req({ method: "POST", path: "/api/service-access/knock/authorize", body: knockAuthBody(pageId) }));

    // Poll with NO holder cookie → pending, no Set-Cookie.
    const pollRes = (await web.handle(
      req({ path: `/__flagship/knock/${pageId}/status`, headers: { host: `notes.${FQDN}` } }),
    ))!;
    expect(JSON.parse(String(pollRes.body)).status).toBe("pending");
    expect(pollRes.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a non-allow-listed AID (401), wrong server (403), stale (403), bad sig (403)", async () => {
    const { web, setClock } = await harness();
    const fresh = () => pageIdFromHtml(String(web.maybeServeKnock(SERVICE, browserNav())!.body));

    const stranger = (await web.handle(
      req({ method: "POST", path: "/api/service-access/knock/authorize", body: knockAuthBody(fresh(), { aid: strangerAid, signer: strangerAid }) }),
    ))!;
    expect(stranger.status).toBe(401);

    const wrongServer = (await web.handle(
      req({ method: "POST", path: "/api/service-access/knock/authorize", body: knockAuthBody(fresh(), { serverId: "evil.bob.flagship.services" }) }),
    ))!;
    expect(wrongServer.status).toBe(403);

    const stale = (await web.handle(
      req({ method: "POST", path: "/api/service-access/knock/authorize", body: knockAuthBody(fresh(), { at: NOW - 10 * 60_000 }) }),
    ))!;
    expect(stale.status).toBe(403);
    setClock(NOW);

    // Sign for one pageId, ship a different one → signature covers the pageId, so it fails.
    const a = fresh();
    const b = fresh();
    const tampered = (await web.handle(
      req({ method: "POST", path: "/api/service-access/knock/authorize", body: knockAuthBody(a, { tamperPageId: b }) }),
    ))!;
    expect(tampered.status).toBe(403);
  });

  it("404s an unknown / expired pageId", async () => {
    const { web } = await harness();
    const res = (await web.handle(
      req({ method: "POST", path: "/api/service-access/knock/authorize", body: knockAuthBody("deadbeefdeadbeefdeadbeefdeadbeef") }),
    ))!;
    expect(res.status).toBe(404);
  });
});

describe("web-experience gating — session management", () => {
  async function authorizedSession() {
    const h = await harness();
    const knockRes = h.web.maybeServeKnock(SERVICE, browserNav())!;
    const pageId = pageIdFromHtml(String(knockRes.body));
    const holder = cookieValue(knockRes.headers["set-cookie"], KNOCK_HOLDER_COOKIE)!;
    const authRes = (await h.web.handle(
      req({ method: "POST", path: "/api/service-access/knock/authorize", body: knockAuthBody(pageId) }),
    ))!;
    const secretId = JSON.parse(String(authRes.body)).secretId as string;
    // holder picks up the cookie
    const pollRes = (await h.web.handle(
      req({ path: `/__flagship/knock/${pageId}/status`, headers: { host: `notes.${FQDN}`, cookie: `${KNOCK_HOLDER_COOKIE}=${holder}` } }),
    ))!;
    const sessTok = cookieValue(pollRes.headers["set-cookie"], SESSION_COOKIE)!;
    return { ...h, secretId, sessTok };
  }

  function statusReq(secretId: string): HttpRequest {
    return req({ method: "POST", path: "/api/service-access/session/status", body: Buffer.from(JSON.stringify({ secretId })) });
  }

  it("reports online, rate-limits a fast re-query, and re-allows after the window", async () => {
    const { web, secretId, setClock } = await authorizedSession();
    const r1 = (await web.handle(statusReq(secretId)))!;
    expect(JSON.parse(String(r1.body)).status).toBe("online");
    const r2 = (await web.handle(statusReq(secretId)))!;
    expect(r2.status).toBe(429);
    setClock(NOW + 61_000);
    const r3 = (await web.handle(statusReq(secretId)))!;
    expect(r3.status).toBe(200);
    expect(JSON.parse(String(r3.body)).status).toBe("online");
  });

  it("default-offline for an unknown secretId (no enumeration oracle)", async () => {
    const { web } = await harness();
    const r = (await web.handle(statusReq("a".repeat(64))))!;
    expect(r.status).toBe(200);
    expect(JSON.parse(String(r.body)).status).toBe("offline");
  });

  it("close kills the browser cookie + flips status offline", async () => {
    const { web, store, sessions, secretId, sessTok, setClock, now } = await authorizedSession();
    // close
    const closeRes = (await web.handle(
      req({ method: "POST", path: "/api/service-access/session/close", body: Buffer.from(JSON.stringify({ secretId })) }),
    ))!;
    expect(JSON.parse(String(closeRes.body)).closed).toBe(true);
    // cookie no longer reaches the service
    const decision = decideServiceAccess(
      { serverId: FQDN, store, sessions, now },
      SERVICE,
      req({ headers: { host: `notes.${FQDN}`, cookie: `${SESSION_COOKIE}=${sessTok}` } }),
    );
    expect(decision.allow).toBe(false);
    // status offline (advance past the rate window)
    setClock(NOW + 61_000);
    const st = (await web.handle(statusReq(secretId)))!;
    expect(JSON.parse(String(st.body)).status).toBe("offline");
  });

  it("a revoke (AID removed from allow-list) flips an existing session offline", async () => {
    const { web, store, setClock, secretId } = await authorizedSession();
    await store.removeAllowed(SERVICE, friendAidHex);
    setClock(NOW + 61_000);
    const st = (await web.handle(req({ method: "POST", path: "/api/service-access/session/status", body: Buffer.from(JSON.stringify({ secretId })) })))!;
    expect(JSON.parse(String(st.body)).status).toBe("offline");
  });
});

describe("v2 — web hardenings (L poll-oracle + M5 rate limit)", () => {
  it("L — an UNKNOWN pageId polls as 'pending' (not 'unknown'), no oracle", async () => {
    const { web } = await harness();
    const res = (await web.handle(
      req({ path: "/__flagship/knock/deadbeefdeadbeefdeadbeefdeadbeef/status", headers: { host: `notes.${FQDN}` } }),
    ))!;
    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body)).status).toBe("pending");
  });

  it("M5 — knock authorize is rate-limited per client", async () => {
    const store = tempStore();
    await store.load();
    await store.setMode(SERVICE, "restricted");
    await store.addAllowed(SERVICE, friendAidHex);
    const sessions = tempSessions();
    await sessions.load();
    const web = buildServiceAccessWeb({ serverId: FQDN, store, sessions, now: () => NOW, rateLimitPerMin: 3 });
    // Hammer authorize from one client (unknown pageId → 404/403, but the rate
    // limiter is hit BEFORE the handler). After the cap it's 429.
    let saw429 = false;
    for (let i = 0; i < 6; i++) {
      const r = (await web.handle(
        req({
          method: "POST",
          path: "/api/service-access/knock/authorize",
          headers: { host: FQDN, "x-forwarded-for": "203.0.113.7" },
          body: Buffer.from(JSON.stringify({ authorization: {}, sig: "00".repeat(64) })),
        }),
      ))!;
      if (r.status === 429) saw429 = true;
    }
    expect(saw429).toBe(true);
  });
});
