/**
 * A name freed by the admin reclaim or a demo cleanup must not hand its voi.ci page, mailbox or state to whoever
 * claims it next (security review): both routes delete the account's voi.ci data, as account deletion does, before
 * the name is released. Through the Worker's router over the real D1 adapter on SQLite.
 */
import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { D1Storage } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { adminPub, buildPage, caSeed, fakeBucket, hex, irkPub, uploadHeaders, USER } from "../../../packages/control-plane/tests/support/voiciFixture.js";
import { route, type RouteEnv } from "../src/route.js";

const ADMIN = "admin-secret-for-tests";

async function world() {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const seed = new D1Storage(db);
  await seed.usernames.put({ username: USER, irkPubHex: irkPub, adminRootPubHex: adminPub, claimedAt: 1 });
  const bucket = fakeBucket();
  const env = {
    SERVICES_BASE_URL: "https://services.invalid",
    ASSETS: { fetch: async () => new Response("nf", { status: 404 }) },
    DB: db,
    VOICI: bucket,
    VOICI_ENABLED: "on",
    FLAGSHIP_CA_PRIV_HEX: hex(caSeed),
    FLAGSHIP_ADMIN_SECRET: ADMIN,
    SITE_PUBLIC: "1",
  } as unknown as RouteEnv;
  const call = (url: string, init: RequestInit = {}) => route(new Request(url, init), env, { waitUntil: () => {} });
  const now = Date.now();
  const page = buildPage({ seq: 1, issuedAt: now });
  for (const bytes of page.pieces.values()) {
    const h = uploadHeaders(bytes, now);
    const r = await call(`https://flagshipserver.com/api/voici/pages/${USER}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-flagship-page-id": h.pageId, "x-flagship-issued-at": h.issuedAt, "x-flagship-signature": h.signature },
      body: bytes,
    });
    expect(r.status).toBe(200);
  }
  expect((await call(`https://flagshipserver.com/api/voici/pages/${USER}/publish`, { method: "POST", body: JSON.stringify(page.index) })).status).toBe(200);
  const pageId = (await seed.voici.getPage(USER))!.pageId;
  await seed.voici.insertMessage({
    pageId, conv: "a".repeat(64), msgId: "01".repeat(16), kind: "voici-message", fromPub: "bb".repeat(32), delegatePub: "04" + "cd".repeat(64),
    sentAt: 1, envelope: "{}", size: 2, direct: false, pushed: false, storedAt: 1,
  });
  await seed.voici.putState(USER, 1, "blob", 1);
  await seed.voici.putDraft({ username: USER, opId: "01".repeat(16), devicePub: "aa".repeat(32), envelope: "{}", size: 2, createdAt: 1 });
  expect(bucket.objects.has(`v1/u/${USER}.json`)).toBe(true);
  const gone = async () => {
    expect(await seed.voici.getPage(USER)).toBeNull();
    expect(await seed.voici.listInbox(pageId, 0, 10)).toEqual([]);
    expect(await seed.voici.getState(USER)).toBeNull();
    expect(await seed.voici.listDrafts(USER)).toEqual([]);
    expect(bucket.objects.has(`v1/u/${USER}.json`)).toBe(false);
  };
  return { sqlite, seed, call, gone, close: () => sqlite.close() };
}

describe("a freed name leaves no voi.ci data behind", () => {
  it("the admin reclaim of a dormant name deletes its page, public index, mailbox, drafts and state", async () => {
    const w = await world();
    try {
      const r = await w.call(`https://flagshipserver.com/api/admin/username/${USER}/reclaim`, { method: "POST", headers: { "x-admin-secret": ADMIN } });
      expect(r.status).toBe(200);
      expect(await w.seed.usernames.get(USER)).toBeUndefined();
      await w.gone();
    } finally {
      w.close();
    }
  });

  it("a demo account's cleanup deletes them before it releases the name", async () => {
    const w = await world();
    try {
      await w.seed.demoUsers.insert({
        username: USER, idempotencyKey: "key-1", snapshotId: null, isoR2Key: null, ttlIdleMinutes: 30, region: "r", size: "s",
        activeServerId: null, activeServerIp: null, image: null, activeServerFqdn: null, lastActivityAt: 1, state: "ready",
        createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
      });
      const r = await w.call("https://flagshipserver.com/api/dev/sample-user/cleanup", {
        method: "POST",
        headers: { "x-admin-secret": ADMIN, "content-type": "application/json" },
        body: JSON.stringify({ username: USER, idempotencyKey: "key-1" }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ deleted: true, voiciCleanup: "ok" });
      await w.gone();
    } finally {
      w.close();
    }
  });
});
