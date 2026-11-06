/**
 * voi.ci pages and Messages through the Worker's router (apps/com/src/voiciRoutes.ts): the off switch, CORS for
 * exactly the voi.ci origin, the voi.ci host's page shells and a publish and a message end to end over the real D1
 * adapter on SQLite.
 */
import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@flagship/storage";
import { D1Storage } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { adminPub, adminSeed, buildPage, caSeed, fakeBucket, hex, irkPub, uploadHeaders, USER, visitor } from "../../../packages/control-plane/tests/support/voiciFixture.js";
import { sha256Hex, signVoiciAlertsP256, signVoiciPageRemove } from "@flagship/protocol";
import { route, type RouteEnv } from "../src/route.js";
import { isVoiciApiPath } from "../src/voiciRoutes.js";
import { endpointFor } from "../src/rateLimit.js";
import { VOICI_SITE_SHELL } from "../src/voiciSiteBuild.generated.js";

const SHELL = "<!doctype html><title>voi.ci</title>";

async function world(enabled = true) {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const seed = new D1Storage(db);
  await seed.usernames.put({ username: USER, irkPubHex: irkPub, adminRootPubHex: adminPub, claimedAt: 1 });
  const bucket = fakeBucket();
  const env = {
    SERVICES_BASE_URL: "https://services.invalid",
    ASSETS: {
      fetch: async (req: Request) =>
        new URL(req.url).pathname === "/_voici/index.html" ? new Response(SHELL, { headers: { "content-type": "text/html" } }) : new Response("nf", { status: 404 }),
    },
    DB: db,
    VOICI: bucket,
    VOICI_ENABLED: enabled ? "on" : "off",
    FLAGSHIP_CA_PRIV_HEX: hex(caSeed),
    SITE_PUBLIC: "1",
  } as unknown as RouteEnv;
  const call = (url: string, init: RequestInit = {}) => route(new Request(url, init), env, { waitUntil: () => {} });
  return { sqlite, seed, bucket, env, call, close: () => sqlite.close() };
}

async function publishPage(w: Awaited<ReturnType<typeof world>>, now: number) {
  const page = buildPage({ seq: 1, issuedAt: now });
  for (const bytes of page.pieces.values()) {
    const h = uploadHeaders(bytes, now);
    const r = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-flagship-page-id": h.pageId, "x-flagship-issued-at": h.issuedAt, "x-flagship-signature": h.signature },
      body: bytes,
    });
    expect(r.status).toBe(200);
  }
  const r = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/publish`, { method: "POST", body: JSON.stringify(page.index) });
  expect(r.status).toBe(200);
  return page;
}

describe("voi.ci routes", () => {
  it("own their paths (the removed shortener's included, so it is a 404) and are metered by voiciRoutes, not endpointFor", () => {
    expect(isVoiciApiPath("/api/voici/pages/alice/publish")).toBe(true);
    expect(isVoiciApiPath("/api/voici/web/send")).toBe(true);
    expect(isVoiciApiPath("/api/accounts/alice/voici-drafts/consume")).toBe(true);
    expect(isVoiciApiPath("/api/accounts/alice/messages-state")).toBe(true);
    expect(isVoiciApiPath("/api/voici/shorten")).toBe(true);
    expect(endpointFor("POST", "/api/voici/shorten")).toBeNull();
    expect(endpointFor("POST", "/api/voici/web/send")).toBeNull();
  });

  it("answer 404 while VOICI_ENABLED is off, and voi.ci keeps its old behaviour", async () => {
    const w = await world(false);
    try {
      const r = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}`);
      expect([r.status, await r.json()]).toEqual([404, { error: "not-found", code: "not-found" }]);
      expect((await w.call("https://voi.ci/@alice")).status).toBe(404);
      const pre = await w.call("https://flagshipserver.com/api/voici/web/send", {
        method: "OPTIONS",
        headers: { origin: "https://voi.ci", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      w.close();
    }
  });

  it("publish, then serve the page to voi.ci with CORS for exactly that origin", async () => {
    const w = await world();
    try {
      const page = await publishPage(w, Date.now());
      const read = (origin?: string) => w.call(`https://flagshipserver.com/api/voici/pages/${USER}`, { headers: origin ? { origin } : {} });
      const ok = await read("https://voi.ci");
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://voi.ci");
      expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
      expect(((await ok.json()) as { index: unknown }).index).toEqual(page.index);
      expect((await read("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
      const lookup = await w.call(`https://flagshipserver.com/api/username/${USER}`, { headers: { origin: "https://voi.ci" } });
      expect(lookup.headers.get("access-control-allow-origin")).toBe("https://voi.ci");
      const inbox = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/inbox`, { headers: { origin: "https://voi.ci" } });
      expect(inbox.headers.get("access-control-allow-origin")).toBeNull();
      const pre = (headers: string) =>
        w.call("https://flagshipserver.com/api/voici/web/send", {
          method: "OPTIONS",
          headers: { origin: "https://voi.ci", "access-control-request-method": "POST", "access-control-request-headers": headers },
        });
      const good = await pre("content-type");
      expect([good.status, good.headers.get("access-control-allow-origin"), good.headers.get("access-control-allow-headers")]).toEqual([204, "https://voi.ci", "content-type"]);
      expect((await pre("content-type, authorization")).headers.get("access-control-allow-origin")).toBeNull();
      expect(w.bucket.objects.has(`v1/u/${USER}.json`)).toBe(true);
    } finally {
      w.close();
    }
  });

  it("serve the page shell on voi.ci, /@name as a redirect, and 410 for a page taken down", async () => {
    const w = await world();
    try {
      await publishPage(w, Date.now());
      const shell = await w.call("https://voi.ci/alice");
      expect([shell.status, await shell.text()]).toEqual([200, VOICI_SITE_SHELL]);
      expect(shell.headers.get("content-security-policy")).toContain("img-src 'self' blob:;");
      expect(shell.headers.get("x-frame-options")).toBe("DENY");
      const at = await w.call("https://voi.ci/@alice");
      expect([at.status, at.headers.get("location")]).toEqual([301, "https://voi.ci/alice"]);
      expect((await w.call("https://voi.ci/nobody-here")).status).toBe(404);
      await w.seed.voici.setTakedown(USER, Date.now(), "spam");
      expect((await w.call("https://voi.ci/alice")).status).toBe(410);
    } finally {
      w.close();
    }
  });

  it("serve a listed piece to the webapp, and nothing the stored index does not list", async () => {
    const w = await world();
    try {
      const page = await publishPage(w, Date.now());
      const avatar = page.index.pieces.find((p) => p.role === "avatar")!;
      const r = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/pieces/${avatar.sha256}`);
      expect([r.status, r.headers.get("content-type"), r.headers.get("cache-control")]).toEqual([200, "image/jpeg", "public, max-age=31536000, immutable"]);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(page.pieces.get(avatar.sha256));
      expect((await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/pieces/${"ab".repeat(32)}`)).status).toBe(404);
    } finally {
      w.close();
    }
  });

  it("remove the page on the owner's signed order: 404 everywhere, no CORS, messages kept, republish works", async () => {
    const w = await world();
    try {
      const now = Date.now();
      const page = await publishPage(w, now);
      const v = visitor(now);
      const env = v.message(now);
      await w.call("https://flagshipserver.com/api/voici/web/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
      const avatar = page.index.pieces.find((p) => p.role === "avatar")!;
      const removal = signVoiciPageRemove({ username: USER, pageId: page.index.pageId, seq: 2, issuedAt: now, signerKind: "admin-root" }, adminSeed);
      const pre = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/remove`, {
        method: "OPTIONS",
        headers: { origin: "https://voi.ci", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
      const r = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/remove`, { method: "POST", headers: { origin: "https://voi.ci" }, body: JSON.stringify(removal) });
      expect([r.status, await r.json()]).toEqual([200, { ok: true, pageId: page.index.pageId, seq: 2 }]);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(w.bucket.objects.size).toBe(0);
      expect((await w.call(`https://flagshipserver.com/api/voici/pages/${USER}`)).status).toBe(404);
      expect((await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/pieces/${avatar.sha256}`)).status).toBe(404);
      const host = await w.call("https://voi.ci/alice");
      expect(host.status).toBe(404);
      expect(await w.seed.voici.listInbox(env.audience, 0, 10)).toHaveLength(1);
      const replay = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/remove`, { method: "POST", body: JSON.stringify(removal) });
      expect(replay.status).toBe(404);
      const old = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/publish`, { method: "POST", body: JSON.stringify(page.index) });
      expect([old.status, ((await old.json()) as { code: string }).code]).toEqual([409, "seq-conflict"]);
      const p3 = buildPage({ seq: 3, issuedAt: now });
      for (const bytes of p3.pieces.values()) {
        const h = uploadHeaders(bytes, now);
        await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/pieces`, {
          method: "POST",
          headers: { "x-flagship-page-id": h.pageId, "x-flagship-issued-at": h.issuedAt, "x-flagship-signature": h.signature },
          body: bytes,
        });
      }
      const back = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/publish`, { method: "POST", body: JSON.stringify(p3.index) });
      expect(back.status).toBe(200);
      expect((await w.call("https://voi.ci/alice")).status).toBe(200);
      const piece = await w.call(`https://flagshipserver.com/api/voici/pages/${USER}/pieces/${avatar.sha256}`);
      expect(new Uint8Array(await piece.arrayBuffer())).toEqual(page.pieces.get(avatar.sha256));
    } finally {
      w.close();
    }
  });

  it("carry a visitor's message to the owner's inbox", async () => {
    const w = await world();
    try {
      const now = Date.now();
      await publishPage(w, now);
      const v = visitor(now);
      const env = v.message(now);
      const sent = await w.call("https://flagshipserver.com/api/voici/web/send", {
        method: "POST",
        headers: { origin: "https://voi.ci", "content-type": "application/json" },
        body: JSON.stringify(env),
      });
      expect(sent.headers.get("access-control-allow-origin")).toBe("https://voi.ci");
      expect(await sent.json()).toMatchObject({ ok: true, status: "accepted", msgId: env.msgId });
      const rows = await w.seed.voici.listInbox(env.audience, 0, 10);
      expect(rows.map((r) => r.msgId)).toEqual([env.msgId]);
    } finally {
      w.close();
    }
  });

  it("turn reply alerts on for the visitor's own conversation and push once after the owner's reply", async () => {
    const w = await world();
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
    const vapidPub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", ua.publicKey)).toString("base64url");
    Object.assign(w.env as unknown as Record<string, string>, {
      WEBPUSH_VAPID_PRIVATE_KEY_PEM: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
      WEBPUSH_VAPID_PUBLIC_KEY_B64URL: vapidPub,
      WEBPUSH_CONTACT: "mailto:test@example.invalid",
    });
    const realFetch = globalThis.fetch;
    const pushed: { url: string; headers: Record<string, string> }[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://fcm.googleapis.com/")) return realFetch(input, init);
      pushed.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(null, { status: 201 });
    });
    const jobs: Promise<unknown>[] = [];
    const call = (url: string, init: RequestInit = {}) => route(new Request(url, init), w.env, { waitUntil: (p: Promise<unknown>) => void jobs.push(p) });
    try {
      const now = Date.now();
      await publishPage(w, now);
      const key = await call("https://flagshipserver.com/api/voici/web/alert-key", { headers: { origin: "https://voi.ci" } });
      expect([key.status, key.headers.get("access-control-allow-origin"), await key.json()]).toEqual([200, "https://voi.ci", { key: vapidPub }]);
      const v = visitor(now);
      const endpoint = "https://fcm.googleapis.com/fcm/send/visitor-1";
      const order = { conv: v.conv, op: "on" as const, endpointHash: sha256Hex(endpoint), issuedAt: now };
      const body = { ...order, endpoint, sig: signVoiciAlertsP256(order, v.browserPriv), cred: v.cred, subscription: { endpoint, keys: { p256dh, auth: "AAAAAAAAAAAAAAAAAAAAAA" } } };
      delete (body as { endpointHash?: string }).endpointHash;
      const post = (b: unknown) =>
        call("https://flagshipserver.com/api/voici/web/alerts", { method: "POST", headers: { origin: "https://voi.ci", "content-type": "application/json" }, body: JSON.stringify(b) });
      expect(await (await post(body)).json()).toMatchObject({ code: "no-conversation" });
      await call("https://flagshipserver.com/api/voici/web/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v.message(now)) });
      const on = await post(body);
      expect([on.status, on.headers.get("access-control-allow-origin"), await on.json()]).toEqual([200, "https://voi.ci", { ok: true, alerts: "on" }]);
      for (const [i, msgId] of ["aa".repeat(16), "ab".repeat(16)].entries()) {
        const r = await call("https://flagshipserver.com/api/voici/web/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v.reply(now + i, msgId)) });
        expect(r.status).toBe(200);
        await Promise.all(jobs.splice(0));
      }
      expect(pushed.map((p) => [p.url, p.headers["content-encoding"]])).toEqual([[endpoint, "aes128gcm"]]);
      expect(pushed[0]!.headers.authorization).toMatch(new RegExp(`^vapid t=.+, k=${vapidPub}$`));
    } finally {
      spy.mockRestore();
      w.close();
    }
  });
});
