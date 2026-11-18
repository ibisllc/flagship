/**
 * Two promises of the privacy policy's §2.12 (calls), through the Worker over the real D1 adapter on SQLite:
 *   - the owner device's call-room URL names only the call: the Worker finds the account from the live call, ignores
 *     any `u` in the URL, and a device of another account fails its own signature;
 *   - a page that is removed (the owner's removal, an admin takedown) takes its missed calls and call-back channels
 *     with it, while the owner's call allows stay for a republish.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed, signAccountDirectoryRequest, signDeviceCapabilityGrant, type DeviceCapabilityGrant, type Keypair } from "@flagship/protocol";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { route, type RouteEnv } from "../src/route.js";
import { removeVoiciPageObjects } from "../src/voiciRoutes.js";
import { takedownVoiciPageFor } from "../src/voiciAbuse.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "../../../packages/protocol/test-vectors/voici-calls/vectors.json"), "utf8"));
const K = V.keys;
const CALL = "0123456789abcdef0123456789abcdef";
const DEVICE_ID = "2e191c32602192218acdb115dac152f0";
const CONV = "ab".repeat(32);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function key(): Keypair {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

async function world() {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const seed = new D1Storage(db);
  const adminRoot = key();
  const device = key();
  await seed.usernames.put({ username: "alice", irkPubHex: "11".repeat(32), adminRootPubHex: hex(adminRoot.publicKey), claimedAt: 1 });
  await seed.voici.publishPage(
    { username: "alice", pageId: K.pageId, seq: 8, issuedAt: V.now, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: K.ownerSignPub, indexJson: JSON.stringify(V.pageV2.signed), publishedAt: V.now },
    0,
  );
  await seed.deviceIdentities.put({ accountId: "alice", deviceId: DEVICE_ID, devicePubHex: hex(device.publicKey), platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null });
  const grant: DeviceCapabilityGrant = { grantId: "g1", username: "alice", deviceId: DEVICE_ID, devicePubKey: device.publicKey, scopes: ["admin"], issuedAt: V.now - 1000, expiresAt: V.now + 1e9 };
  await seed.deviceCapabilityGrants.put({
    grantId: "g1", username: "alice", deviceId: DEVICE_ID, devicePubHex: hex(device.publicKey), scopesJson: JSON.stringify(grant.scopes),
    issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, signatureHex: hex(signDeviceCapabilityGrant(grant, adminRoot)), revokedAt: null, signerRoot: "admin-root",
  });
  const joins: Headers[] = [];
  const env = {
    SERVICES_BASE_URL: "https://services.invalid",
    DB: db,
    VOICI_ENABLED: "on",
    VOICI_CALLS: "on",
    VOICI_CALL_ROOM: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async (r: Request | string) => (typeof r !== "string" && joins.push(r.headers), new Response("{}")) }),
    },
    FLAGSHIP_CA_PRIV_HEX: K.caSeed,
    SITE_PUBLIC: "1",
  } as unknown as RouteEnv;
  const call = (url: string, init: RequestInit = {}) => route(new Request(url, init), env, { waitUntil: () => {} });
  return { sqlite, db, seed, env, call, device, joins, close: () => sqlite.close() };
}

/** Device headers as the phones sign them (VoiciCallKeys.roomHeaders, VoiciCallSession.kt): the device's own account. */
function deviceHeaders(device: Keypair, account = "alice", requestId = "ffeeddccbbaa99887766554433221100"): Record<string, string> {
  const request = { accountId: account, deviceId: DEVICE_ID, signerPubHex: hex(device.publicKey), method: "GET", path: `/api/voici/calls/${CALL}/device`, requestId, issuedAt: V.now };
  return {
    upgrade: "websocket",
    "x-flagship-device-id": DEVICE_ID,
    "x-flagship-device-pub": request.signerPubHex,
    "x-flagship-request-id": requestId,
    "x-flagship-issued-at": String(V.now),
    "x-flagship-signature": signAccountDirectoryRequest(request, device),
  };
}

describe("privacy §2.12: the device's call-room URL names only the call", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(V.now);
  });
  afterEach(() => vi.useRealTimers());

  it("an admin device joins a live call with no account in the URL", async () => {
    const w = await world();
    try {
      await w.seed.voiciCalls.claimLiveCall("alice", CALL, V.now, V.now + 60_000);
      const r = await w.call(`https://flagshipserver.com/api/voici/calls/${CALL}/device`, { headers: deviceHeaders(w.device) });
      expect(r.status).toBe(200);
      expect(w.joins).toHaveLength(1);
      expect(w.joins[0]!.get("x-voici-device-ref")).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      w.close();
    }
  });

  it("ignores a `u` an older app sends: the account is the live call's", async () => {
    const w = await world();
    try {
      await w.seed.voiciCalls.claimLiveCall("alice", CALL, V.now, V.now + 60_000);
      const r = await w.call(`https://flagshipserver.com/api/voici/calls/${CALL}/device?u=bob`, { headers: deviceHeaders(w.device, "alice", "00112233445566778899aabbccddeeff") });
      expect(r.status).toBe(200);
    } finally {
      w.close();
    }
  });

  it("refuses a call that isn't ringing or running, and a device that signed for another account", async () => {
    const w = await world();
    try {
      const none = await w.call(`https://flagshipserver.com/api/voici/calls/${CALL}/device`, { headers: deviceHeaders(w.device) });
      expect(none.status).toBe(403);
      await w.seed.voiciCalls.claimLiveCall("alice", CALL, V.now, V.now + 60_000);
      const other = await w.call(`https://flagshipserver.com/api/voici/calls/${CALL}/device`, { headers: deviceHeaders(w.device, "bob", "00112233445566778899aabbccddee01") });
      expect(other.status).toBe(403);
      vi.setSystemTime(V.now + 61_000);
      const ended = await w.call(`https://flagshipserver.com/api/voici/calls/${CALL}/device`, { headers: deviceHeaders(w.device, "alice", "00112233445566778899aabbccddee02") });
      expect(ended.status).toBe(403);
      expect(w.joins).toHaveLength(0);
    } finally {
      w.close();
    }
  });
});

describe("privacy §2.12: a removed page's call data goes with it", () => {
  async function seeded() {
    const w = await world();
    const calls = w.seed.voiciCalls;
    await calls.putMissedCall({ pageId: K.pageId, conv: CONV, callId: CALL, sealed: "c2VhbGVk", storedAt: V.now });
    await calls.putRingBack({ pageId: K.pageId, conv: CONV, username: "bob", issuedAt: V.now, expiresAt: V.now + 86_400_000 });
    await calls.putRing({ pageId: K.pageId, conv: CONV, ringId: "cd".repeat(16), hint: "aGludA", media: "audio", issuedAt: V.now, expiresAt: V.now + 45_000 });
    await calls.setCallAllow({ pageId: K.pageId, conv: CONV, op: "allow", issuedAt: V.now, signature: "00" }, V.now);
    const left = async () => ({
      missed: (await calls.listMissedCalls(K.pageId, 0, 10)).length,
      ringBack: !!(await calls.getRingBack(K.pageId, CONV, V.now)),
      ring: !!(await calls.getRing(K.pageId, CONV, V.now)),
      allow: !!(await calls.getCallAllow(K.pageId, CONV)),
    });
    expect(await left()).toEqual({ missed: 1, ringBack: true, ring: true, allow: true });
    return { ...w, left };
  }
  const bucket = () => ({ get: async () => null, list: async () => ({ objects: [], truncated: false }), delete: async () => {}, put: async () => {} });

  it("the owner's removal deletes missed calls, call-back channels and rings; call allows stay", async () => {
    const w = await seeded();
    try {
      await removeVoiciPageObjects({ DB: w.db, VOICI: bucket() } as never, { voici: w.seed.voici }, "alice", K.pageId, { keepAlerts: true });
      expect(await w.left()).toEqual({ missed: 0, ringBack: false, ring: false, allow: true });
    } finally {
      w.close();
    }
  });

  it("an admin takedown deletes them too", async () => {
    const w = await seeded();
    try {
      const r = await takedownVoiciPageFor(w.db, { DB: w.db, VOICI: bucket() } as never, (async () => new Response("{}")) as typeof fetch, "alice", "spam", V.now);
      expect(r).toEqual({ took: true, done: true });
      expect(await w.left()).toEqual({ missed: 0, ringBack: false, ring: false, allow: true });
    } finally {
      w.close();
    }
  });
});
