/**
 * The operator's example voi.ci page of a sample account (POST /api/dev/sample-user/<u>/voici-example-page,
 * docs/sample-users.md "Example voi.ci page") through the Worker's router over the real D1 adapter on SQLite: admin
 * secret only, sample accounts only, a page a client verifies against the account's own key, republish and removal.
 */
import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { D1Storage } from "@flagship/storage";
import { checkVoiciPageIndex, parseVoiciProfilePiece } from "@flagship/protocol";
import { deriveDemoAdminRoot, deriveDemoUserIrk, demoExamplePageContent } from "@flagship/control-plane";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { fakeBucket } from "../../../packages/control-plane/tests/support/voiciFixture.js";
import { route, type RouteEnv } from "../src/route.js";
import { endpointFor, extractUsernameHash, LIMITS } from "../src/rateLimit.js";

const ADMIN = "admin-secret-for-tests";
const KEK_HEX = "09".repeat(32);
const KEK = new Uint8Array(32).fill(9);
const DEMO = "playstore-test-0725";
const REAL = "alice";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const adminPub = hex(deriveDemoAdminRoot(KEK, DEMO).publicKey);

async function world(o: { enabled?: boolean } = {}) {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const seed = new D1Storage(db);
  await seed.usernames.put({
    username: DEMO,
    irkPubHex: hex(deriveDemoUserIrk(KEK, DEMO).publicKey),
    adminRootPubHex: adminPub,
    claimedAt: 1,
    isDemo: true,
    accountType: "demo",
  });
  await seed.demoUsers.insert({
    username: DEMO, idempotencyKey: "k", snapshotId: null, isoR2Key: null, ttlIdleMinutes: 30, region: "fsn1", size: "cpx11",
    activeServerId: null, activeServerIp: null, image: null, activeServerFqdn: null, lastActivityAt: 1, state: "ready",
    createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
  });
  await seed.usernames.put({ username: REAL, irkPubHex: "ab".repeat(32), adminRootPubHex: "cd".repeat(32), claimedAt: 1 });
  const bucket = fakeBucket();
  const env = {
    SERVICES_BASE_URL: "https://services.invalid",
    ASSETS: { fetch: async () => new Response("nf", { status: 404 }) },
    DB: db,
    VOICI: bucket,
    VOICI_ENABLED: o.enabled === false ? "off" : "on",
    FLAGSHIP_ADMIN_SECRET: ADMIN,
    DEMO_IRK_KEK: KEK_HEX,
    SITE_PUBLIC: "1",
  } as unknown as RouteEnv;
  const call = (url: string, init: RequestInit = {}) => route(new Request(url, init), env, { waitUntil: () => {} });
  const example = (u: string, body?: unknown, secret: string | null = ADMIN) =>
    call(`https://flagshipserver.com/api/dev/sample-user/${u}/voici-example-page`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-admin-secret": secret } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { seed, bucket, call, example, close: () => sqlite.close() };
}

describe("POST /api/dev/sample-user/<u>/voici-example-page", () => {
  it("needs the admin secret", async () => {
    const w = await world();
    try {
      expect((await w.example(DEMO, undefined, null)).status).toBe(401);
      expect((await w.example(DEMO, undefined, "wrong")).status).toBe(403);
      expect(await w.seed.voici.getPage(DEMO)).toBeNull();
    } finally {
      w.close();
    }
  });

  it("refuses a real account and an unknown one", async () => {
    const w = await world();
    try {
      const real = await w.example(REAL);
      expect(real.status).toBe(404);
      expect(await w.seed.voici.getPage(REAL)).toBeNull();
      expect((await w.example("nobody-here")).status).toBe(404);
    } finally {
      w.close();
    }
  });

  it("answers 503 while voi.ci is off", async () => {
    const w = await world({ enabled: false });
    try {
      expect((await w.example(DEMO)).status).toBe(503);
    } finally {
      w.close();
    }
  });

  it("publishes a page a client verifies against the account's key, republishes, and removes it", async () => {
    const w = await world();
    try {
      const r = await w.example(DEMO);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, seq: 1 });
      // The public read every client makes.
      const read = await w.call(`https://flagshipserver.com/api/voici/pages/${DEMO}`);
      expect(read.status).toBe(200);
      const { index } = (await read.json()) as { index: unknown };
      const checked = checkVoiciPageIndex(index, { username: DEMO, sensitiveKind: "admin-root", sensitivePub: adminPub });
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      const profileRef = checked.index.pieces.find((p) => p.role === "profile")!;
      const piece = await w.call(`https://flagshipserver.com/api/voici/pages/${DEMO}/pieces/${profileRef.sha256}`);
      expect(parseVoiciProfilePiece(new Uint8Array(await piece.arrayBuffer()))).toEqual(demoExamplePageContent(DEMO).profile);

      const again = await w.example(DEMO, {});
      expect(await again.json()).toMatchObject({ ok: true, seq: 2, pageId: checked.index.pageId });

      const rm = await w.example(DEMO, { remove: true });
      expect(await rm.json()).toMatchObject({ ok: true, seq: 3, removed: true });
      expect((await w.call(`https://flagshipserver.com/api/voici/pages/${DEMO}`)).status).toBe(404);
      expect(w.bucket.objects.has(`v1/u/${DEMO}.json`)).toBe(false);

      const back = await w.example(DEMO);
      expect(await back.json()).toMatchObject({ ok: true, seq: 4 });
    } finally {
      w.close();
    }
  });

  it("takes no content from the request", async () => {
    const w = await world();
    try {
      const r = await w.example(DEMO, { bio: "anything" });
      expect(r.status).toBe(400);
      expect(await w.seed.voici.getPage(DEMO)).toBeNull();
    } finally {
      w.close();
    }
  });

  it("is metered per source and per account", () => {
    const path = `/api/dev/sample-user/${DEMO}/voici-example-page`;
    expect(endpointFor("POST", path)).toBe("demo-example-page");
    expect(extractUsernameHash(path)).toBe(DEMO);
    expect(LIMITS["demo-example-page"].map((l) => l.axis).sort()).toEqual(["ip", "usernameHash"]);
  });
});
