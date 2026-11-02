/**
 * voi.ci pages and Messages through the Worker's router (apps/com/src/voiciRoutes.ts): the off switch, CORS for
 * exactly the voi.ci origin, the voi.ci host's page shells and a publish and a message end to end over the real D1
 * adapter on SQLite.
 */
import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { D1Storage } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { adminPub, buildPage, caSeed, fakeBucket, hex, irkPub, uploadHeaders, USER, visitor } from "../../../packages/control-plane/tests/support/voiciFixture.js";
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
  it("own their paths, leave the code minter alone, and are metered by voiciRoutes, not endpointFor", () => {
    expect(isVoiciApiPath("/api/voici/pages/alice/publish")).toBe(true);
    expect(isVoiciApiPath("/api/voici/web/send")).toBe(true);
    expect(isVoiciApiPath("/api/accounts/alice/voici-drafts/consume")).toBe(true);
    expect(isVoiciApiPath("/api/accounts/alice/messages-state")).toBe(true);
    expect(isVoiciApiPath("/api/voici/shorten")).toBe(false);
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
      expect([at.status, at.headers.get("location")]).toEqual([301, "/alice"]);
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
});
