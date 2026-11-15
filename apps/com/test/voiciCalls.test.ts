/**
 * voi.ci calls through the Worker's router (apps/com/src/voiciCallRoutes.ts) over the real D1 adapter on SQLite
 * (migration 0146 applied): the off switch, CORS for the voi.ci origin, a call request that opens a room and rings,
 * busy with a missed call, the owner's call-allow, and the missed-call list behind a read token.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@flagship/storage";
import { D1Storage } from "@flagship/storage";
import { hexToBytes, signVoiciCallRequestP256 } from "@flagship/protocol";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { route, type RouteEnv } from "../src/route.js";
import { isVoiciApiPath } from "../src/voiciRoutes.js";
import { endpointFor } from "../src/rateLimit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "../../../packages/protocol/test-vectors/voici-calls/vectors.json"), "utf8"));
const K = V.keys;

async function world(calls = "on") {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const seed = new D1Storage(db);
  await seed.usernames.put({ username: "alice", irkPubHex: "11".repeat(32), adminRootPubHex: "17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce", claimedAt: 1 });
  await seed.voici.publishPage(
    { username: "alice", pageId: K.pageId, seq: 8, issuedAt: V.now, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: K.ownerSignPub, indexJson: JSON.stringify(V.pageV2.signed), publishedAt: V.now },
    0,
  );
  const inits: unknown[] = [];
  const env = {
    SERVICES_BASE_URL: "https://services.invalid",
    DB: db,
    VOICI_ENABLED: "on",
    VOICI_CALLS: calls,
    VOICI_CALL_ROOM: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async (_u: string, init?: RequestInit) => (inits.push(JSON.parse(String(init?.body))), new Response("{}")) }),
    },
    FLAGSHIP_CA_PRIV_HEX: K.caSeed,
    SITE_PUBLIC: "1",
  } as unknown as RouteEnv;
  const call = (url: string, init: RequestInit = {}) => route(new Request(url, init), env, { waitUntil: () => {} });
  return { sqlite, seed, env, call, inits, close: () => sqlite.close() };
}

const post = (request: unknown) => ({ method: "POST", headers: { "content-type": "application/json", origin: "https://voi.ci" }, body: JSON.stringify({ request }) });

describe("voi.ci call routes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(V.now);
  });
  afterEach(() => vi.useRealTimers());

  it("are voi.ci paths, metered by their own buckets", () => {
    for (const p of ["/api/voici/calls", `/api/voici/calls/${"ab".repeat(16)}/caller`, "/api/voici/pages/alice/calls", "/api/voici/pages/alice/call-allow", "/api/accounts/alice/voici-voip-token"]) {
      expect(isVoiciApiPath(p), p).toBe(true);
      expect(endpointFor("POST", p)).toBeNull();
    }
  });

  it("answer 404 while VOICI_CALLS is off", async () => {
    const w = await world("off");
    try {
      expect((await w.call("https://flagshipserver.com/api/voici/calls", post(V.request.signed))).status).toBe(404);
    } finally {
      w.close();
    }
  });

  it("a call from an allowed conversation opens a room; a second call is busy and leaves a missed call", async () => {
    const w = await world();
    try {
      const pre = await w.call("https://flagshipserver.com/api/voici/calls", {
        method: "OPTIONS",
        headers: { origin: "https://voi.ci", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
      expect(pre.headers.get("access-control-allow-origin")).toBe("https://voi.ci");

      const refused = await w.call("https://flagshipserver.com/api/voici/calls", post(V.request.signed));
      expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([403, "not-allowed"]);

      vi.setSystemTime(V.allow.order.issuedAt);
      const allow = await w.call("https://flagshipserver.com/api/voici/pages/alice/call-allow", { method: "POST", body: JSON.stringify({ allow: V.allow.order, signature: V.allow.signature }) });
      expect(allow.status).toBe(200);
      vi.setSystemTime(V.now);

      const r = await w.call("https://flagshipserver.com/api/voici/calls", post(V.request.signed));
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("https://voi.ci");
      const body = (await r.json()) as { callId: string; room: string; token: string };
      expect(body.room).toBe(`wss://flagshipserver.com/api/voici/calls/${V.request.signed.callId}/caller`);
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(w.inits).toHaveLength(1);
      expect(w.inits[0]).toMatchObject({ callId: V.request.signed.callId, username: "alice", callerPub: K.browserPub });

      const second = signVoiciCallRequestP256({ ...V.request.body, callId: "b2".repeat(16) }, hexToBytes(K.browserPriv));
      const busy = await w.call("https://flagshipserver.com/api/voici/calls", post(second));
      expect([busy.status, ((await busy.json()) as { code: string }).code]).toEqual([409, "busy"]);
      const missed = await w.seed.voiciCalls.listMissedCalls(K.pageId, 0, 10);
      expect(missed.map((m) => [m.callId, m.conv])).toEqual([["b2".repeat(16), K.conv]]);

      const list = await w.call("https://flagshipserver.com/api/voici/pages/alice/calls?since=");
      expect(list.status).toBe(401);
    } finally {
      w.close();
    }
  });

  it("a device room socket needs the device headers of an admin device", async () => {
    const w = await world();
    try {
      const r = await w.call(`https://flagshipserver.com/api/voici/calls/${V.request.signed.callId}/device?u=alice`, { headers: { upgrade: "websocket" } });
      expect(r.status).toBe(403);
      const c = await w.call(`https://flagshipserver.com/api/voici/calls/${V.request.signed.callId}/caller?t=00`, { headers: { upgrade: "websocket", origin: "https://evil.example" } });
      expect(c.status).toBe(403);
    } finally {
      w.close();
    }
  });
});
