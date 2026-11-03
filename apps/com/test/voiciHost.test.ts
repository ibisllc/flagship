/**
 * The voi.ci host through the Worker's router over the real D1 adapter (docs/voici-namespace-spec.md, Resolution):
 * one resolve() for people, link names and codes, the canonical-form 301 (D13), `/@x` for usernames only (D10, D5),
 * the site's own routes under `/-/` (D11), 410 for a removed link or code, and one 404 for unknown, reserved,
 * unpublished and held names. The acceptance tests at the HTTP level carry their number.
 */
import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { D1Storage } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { adminPub, fakeBucket, irkPub, PAGE_ID, USER } from "../../../packages/control-plane/tests/support/voiciFixture.js";
import { route, type RouteEnv } from "../src/route.js";
import { VOICI_SITE_DIR, VOICI_SITE_SHELL, VOICI_SITE_SHELL_404, VOICI_SITE_SHELL_410 } from "../src/voiciSiteBuild.generated.js";

async function world(enabled = true) {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const seed = new D1Storage(db);
  await seed.usernames.put({ username: USER, irkPubHex: irkPub, adminRootPubHex: adminPub, claimedAt: 1 });
  const env = {
    SERVICES_BASE_URL: "https://services.invalid",
    ASSETS: {
      fetch: async (req: Request) => {
        const p = new URL(req.url).pathname;
        return p === `/_voici/${VOICI_SITE_DIR}/style.css` ? new Response("body{}", { headers: { "content-type": "text/css" } }) : new Response("nf", { status: 404 });
      },
    },
    DB: db,
    VOICI: fakeBucket(),
    VOICI_ENABLED: enabled ? "on" : "off",
    SITE_PUBLIC: "1",
  } as unknown as RouteEnv;
  const call = (path: string, init: RequestInit = {}) => route(new Request(`https://voi.ci${path}`, { redirect: "manual", ...init }), env, { waitUntil: () => {} });
  return { sqlite, seed, call, close: () => sqlite.close() };
}

/** A published page as `.com` stores it (publishing through the API is covered by voiciRoutes.test.ts). */
async function publish(w: Awaited<ReturnType<typeof world>>) {
  const now = Date.now();
  await w.seed.voici.publishPage(
    { username: USER, pageId: PAGE_ID, seq: 1, issuedAt: now, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: adminPub, indexJson: "{}", publishedAt: now },
    0,
  );
}

const location = (r: Response) => [r.status, r.headers.get("location")];

describe("the voi.ci host (one namespace)", () => {
  it("T1 + D13: capitals and a trailing slash 301 to the canonical path, the query kept", async () => {
    const w = await world();
    try {
      expect(location(await w.call("/Alice/"))).toEqual([301, "/alice"]);
      expect(location(await w.call("/alice/?ref=card"))).toEqual([301, "/alice?ref=card"]);
    } finally {
      w.close();
    }
  });

  it("T7: /@alice 301s to /alice, which is the page shell once the page is published", async () => {
    const w = await world();
    try {
      expect(location(await w.call("/@alice"))).toEqual([301, "/alice"]);
      const before = await w.call("/alice");
      expect([before.status, await before.text()]).toEqual([404, VOICI_SITE_SHELL_404]);
      await publish(w);
      const after = await w.call("/alice");
      expect([after.status, await after.text()]).toEqual([200, VOICI_SITE_SHELL]);
    } finally {
      w.close();
    }
  });

  it("T10: /@<link name> is a 404; the link name itself 302s to its app", async () => {
    const w = await world();
    try {
      await w.seed.voiciNames.claim({ key: "chess-club", display: "chess-club", username: USER, serviceId: `${USER}--chess`, state: "live", setAt: 1, lastActiveAt: 1, warned: 0 });
      await w.seed.voiciLinks.insert({ code: "4bcdef", username: USER, targetUrl: "https://example.com/one-off", createdAt: 1 });
      expect((await w.call("/@chess-club")).status).toBe(404);
      expect((await w.call("/@4bcdef")).status).toBe(404);
      expect(location(await w.call("/4bcdef"))).toEqual([302, "https://example.com/one-off"]);
    } finally {
      w.close();
    }
  });

  it("T12: a retired code is 410 with the site's 'link removed' shell, and the code can't be claimed again", async () => {
    const w = await world();
    try {
      await w.seed.voiciLinks.insert({ code: "3k9x2q", username: USER, serviceId: `${USER}--app`, targetUrl: "https://example.com/", createdAt: 1 });
      await w.seed.voiciLinks.retireByService(USER, `${USER}--app`, 2);
      const r = await w.call("/3k9x2q");
      expect([r.status, r.headers.get("location"), await r.text()]).toEqual([410, null, VOICI_SITE_SHELL_410]);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect((await w.seed.voiciLinks.insert({ code: "3k9x2q", username: USER, targetUrl: "https://x/", createdAt: 3 })).ok).toBe(false);
    } finally {
      w.close();
    }
  });

  it("T17: a deleted account's name is the same 404 as an unknown or reserved one during its hold", async () => {
    const w = await world();
    try {
      await publish(w);
      await w.seed.voici.deleteAccount(USER);
      await w.seed.usernames.delete(USER);
      for (const p of ["/alice", "/@alice", "/admin", "/nobody-here"]) {
        const r = await w.call(p);
        expect([r.status, await r.text()], p).toEqual([404, VOICI_SITE_SHELL_404]);
      }
      expect((await w.seed.usernames.put({ username: USER, irkPubHex: "11".repeat(32), claimedAt: 2 })).ok).toBe(false);
    } finally {
      w.close();
    }
  });

  it("D11: the site's files are under /-/ and keep their case; the old /_/ paths are names, so a 404", async () => {
    const w = await world();
    try {
      const css = await w.call(`/-/${VOICI_SITE_DIR}/style.css`);
      expect([css.status, await css.text()]).toEqual([200, "body{}"]);
      const about = await w.call("/-/about");
      expect([about.status, await about.text()]).toEqual([200, VOICI_SITE_SHELL]);
      expect((await w.call(`/_/${VOICI_SITE_DIR}/style.css`)).status).toBe(404);
      expect((await w.call("/-/nothing-here")).status).toBe(404);
    } finally {
      w.close();
    }
  });

  it("refuses anything but GET and HEAD, and HEAD carries no body", async () => {
    const w = await world();
    try {
      expect((await w.call("/alice", { method: "POST" })).status).toBe(405);
      const head = await w.call("/nobody-here", { method: "HEAD" });
      expect([head.status, await head.text()]).toEqual([404, ""]);
    } finally {
      w.close();
    }
  });

  it("before VOICI_ENABLED is on, only links and codes resolve, and refusals carry no text", async () => {
    const w = await world(false);
    try {
      await w.seed.voiciLinks.insert({ code: "4bcdef", username: USER, targetUrl: "https://example.com/one-off", createdAt: 1 });
      expect(location(await w.call("/4bcdef"))).toEqual([302, "https://example.com/one-off"]);
      for (const p of ["/alice", "/@alice", `/-/${VOICI_SITE_DIR}/style.css`]) {
        const r = await w.call(p);
        expect([r.status, await r.text()], p).toEqual([404, ""]);
      }
    } finally {
      w.close();
    }
  });
});
