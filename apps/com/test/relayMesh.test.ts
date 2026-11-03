/**
 * The relay mesh on `.com` (docs/architecture-v2/relay-mesh.md §3, §4, §15.2): the trigger-written relay log for every
 * writer (in the writer's own transaction), signing, the encrypted feed files and their cache headers, mesh-key epochs
 * and rotation, the CA-signed directory and its versions, the proof-of-key blessing, the backfill, the outage rule's
 * inputs and the endpoints' `relays`. D1 is the real schema over sqlite; R2 is a map.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, type D1Database } from "@flagship/storage";
import {
  accountHash,
  applyRelayLog,
  canonicalRelayBlessingRequest,
  canonicalServingPolicy,
  ed,
  emptyRelayLogState,
  emptyRevocationState,
  FEED_PAGE_ENTRIES,
  nameHash,
  relayLogAdminKey,
  relayLogBox,
  relayLogGrantId,
  relayLogHeadStatus,
  relayLogPolicyHead,
  servingDecision,
  signServingRecord,
  verifyRelayBlessing,
  verifyRelayDirectory,
  verifyRelayLogHead,
  type RelayBlessing,
  type RelayDirectory,
  type RelayLogState,
  type ServingPolicy,
  type SignedRelayLogEntry,
  type SignedRelayLogHead,
} from "@flagship/protocol";
import { caKeypairFromEnv, openRelayFeedObject, openRelayMeshKeys, type RelayMeshKeys } from "@flagship/control-plane";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import {
  backfillRelayLog,
  FEED_CACHE,
  publishRelayFeed,
  relayLogAppend,
  signPendingRelayLog,
  type RelayFeedBucket,
  type RelayFeedPublishState,
} from "../src/relayFeed.js";
import { endpointRelays, handleRelayAdmin, mintRelayDirectory, resetEndpointRelayCache, type RelayDirectoryEnv } from "../src/relayDirectory.js";
import { handleRelayBlessing, RELAY_BLESSING_COM_TTL_MS } from "../src/relayBlessing.js";
import { ServingFeed, type ServingFeedState } from "../src/servingFeed.js";
import { route } from "../src/route.js";

const APEX = "flagship.services";
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const seed = (n: number) => new Uint8Array(32).fill(n);
const pub = (n: number) => hex(ed.getPublicKey(seed(n)));
const LOG_SEED_HEX = "11".repeat(32);
const LOG_PUB = pub(0x11);
const MESH_SEED_HEX = "33".repeat(32);
const CA_PRIV_HEX = "44".repeat(32);
const CA_PUB = pub(0x44);
const ADMIN_SECRET = "admin-secret";
const IRK = pub(5);
const ADMIN_ROOT = seed(1);
const ADMIN_ROOT_PUB = pub(1);
const BOX = pub(9);
const BOX2 = pub(10);
const RELAY_A = seed(0x61);
const RELAY_B = seed(0x62);

class FakeBucket implements RelayFeedBucket {
  objects = new Map<string, { body: string; cacheControl: string | undefined }>();
  async put(key: string, value: string, options?: { httpMetadata?: { cacheControl?: string } }) {
    this.objects.set(key, { body: value, cacheControl: options?.httpMetadata?.cacheControl });
  }
  json<T>(key: string): T {
    const o = this.objects.get(key);
    if (!o) throw new Error(`no ${key}`);
    return JSON.parse(o.body) as T;
  }
}

/** A ServingFeed stub that runs the real Durable Object in-process. */
function feedNamespace(env: () => RelayDirectoryEnv, now: () => number) {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const state: ServingFeedState = {
    storage: {
      get: async <T,>(k: string) => store.get(k) as T | undefined,
      put: async (k, v) => void store.set(k, v),
      setAlarm: async (t) => void (alarm = t),
      getAlarm: async () => alarm,
    },
    acceptWebSocket: () => undefined,
    getWebSockets: () => [],
  };
  let feed: ServingFeed | null = null;
  const get = () => (feed ??= new ServingFeed(state, env(), now));
  return {
    ns: { idFromName: () => "one", get: () => ({ fetch: (r: Request) => get().fetch(r) }) },
    feed: get,
    alarm: () => alarm,
    store,
  };
}

async function setup(o: { mesh?: boolean } = {}) {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const storage = new D1Storage(db);
  const bucket = new FakeBucket();
  let now = Date.UTC(2026, 10, 1);
  const env: RelayDirectoryEnv & ControlPlaneEnv = {
    DB: db,
    SERVING_REVOCATION_SEED: LOG_SEED_HEX,
    RELAY_MESH_KEY_SEED: MESH_SEED_HEX,
    RELAY_MESH: o.mesh === false ? "off" : "on",
    RELAY_FEED: bucket,
    SERVICES_APEX: APEX,
    FLAGSHIP_ADMIN_SECRET: ADMIN_SECRET,
    FLAGSHIP_CA_PRIV_HEX: CA_PRIV_HEX,
    ACCOUNT_READ_TOKEN_SECRET: "route-secret",
  } as RelayDirectoryEnv & ControlPlaneEnv;
  const feed = feedNamespace(() => env, () => now);
  (env as RelayDirectoryEnv).SERVING_FEED = feed.ns as unknown as RelayDirectoryEnv["SERVING_FEED"];
  resetEndpointRelayCache();
  return {
    sqlite, db, storage, bucket, env, feed,
    now: () => now,
    tick: (ms: number) => void (now += ms),
    close: () => sqlite.close(),
  };
}
type World = Awaited<ReturnType<typeof setup>>;

async function rows(db: D1Database) {
  const r = await db.prepare("SELECT sequence, kind, account, src, f1, f2, f3, f4, signature FROM relay_log ORDER BY sequence").all<{
    sequence: number; kind: string; account: string | null; src: string | null; f1: string | null; f2: string; f3: string; f4: string | null; signature: string | null;
  }>();
  return r.results ?? [];
}

async function signedEntries(db: D1Database): Promise<SignedRelayLogEntry[]> {
  await signPendingRelayLog(db, LOG_SEED_HEX, APEX);
  return (await rows(db)).map((r) => ({
    entry: { sequence: r.sequence, kind: r.kind as SignedRelayLogEntry["entry"]["kind"], at: 0, f1: r.f1!, f2: r.f2, f3: r.f3, f4: r.f4! },
    signature: r.signature!,
  }));
}

/** The relay's view: apply the signed rows exactly as published. */
async function relayState(db: D1Database): Promise<RelayLogState> {
  await signPendingRelayLog(db, LOG_SEED_HEX, APEX);
  const r = await db.prepare("SELECT sequence, kind, at, f1, f2, f3, f4, signature FROM relay_log ORDER BY sequence").all<{
    sequence: number; kind: string; at: number; f1: string; f2: string; f3: string; f4: string; signature: string;
  }>();
  const entries = (r.results ?? []).map((x) => ({ entry: { sequence: x.sequence, kind: x.kind, at: x.at, f1: x.f1, f2: x.f2, f3: x.f3, f4: x.f4 }, signature: x.signature })) as SignedRelayLogEntry[];
  const applied = applyRelayLog(emptyRelayLogState(APEX), entries, LOG_PUB);
  expect(applied.ok).toBe(true);
  return applied.state;
}

function policy(o: Partial<ServingPolicy> = {}): ServingPolicy {
  return { account: "alice", box: BOX, regGen: 1, policyGen: 1, grace: "indefinite", onLapse: "stop-apps", scopeSha256: "ab".repeat(32), issuedAt: Date.UTC(2026, 10, 1), ...o };
}
async function sha256hex(b: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
}

async function claimAlice(w: World) {
  await w.storage.usernames.put({ username: "alice", irkPubHex: IRK, claimedAt: 1, adminRootPubHex: ADMIN_ROOT_PUB });
}

// ── the log: one entry per writer, in the writer's transaction ────────────

describe("relay log writers (migration 0122 triggers)", () => {
  it("server register, re-key, revoke, un-revoke and delete", async () => {
    const w = await setup();
    try {
      await claimAlice(w);
      await w.storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
      let r = (await rows(w.db)).filter((x) => x.kind.startsWith("box"));
      expect(r).toMatchObject([{ kind: "box-register", account: "alice", src: "home.alice.flagship.services", f1: null, f2: BOX, f3: "1" }]);

      await w.storage.servers.revoke("home.alice.flagship.services", "lost", 5);
      await w.storage.servers.unrevoke("home.alice.flagship.services");
      await w.storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: BOX2, registeredAt: 6 });
      await w.db.prepare("DELETE FROM servers WHERE server_domain = ?").bind("home.alice.flagship.services").run();
      r = (await rows(w.db)).filter((x) => x.kind.startsWith("box"));
      expect(r.map((x) => [x.kind, x.f1 ?? x.src, x.f2, x.f3])).toEqual([
        ["box-register", "home.alice.flagship.services", BOX, "1"],
        ["box-revoke", BOX, "1", ""],
        ["box-register", "home.alice.flagship.services", BOX, "2"],
        ["box-register", "home.alice.flagship.services", BOX2, "2"],
        ["box-revoke", BOX2, "2", ""],
      ]);

      const s = await relayState(w.db);
      expect(relayLogBox(s, "home.alice.flagship.services")).toMatchObject({ boxPub: BOX2, regGen: 2 });
      expect(s.revokedBoxes.get(BOX2)).toBe(2);
      expect(s.revokedBoxes.get(BOX)).toBe(1);
      // The published name is hashed; .com's own `src` never reaches the wire.
      expect((await signedEntries(w.db)).find((e) => e.entry.kind === "box-register")!.entry.f1).toBe(nameHash("home.alice.flagship.services"));
    } finally {
      w.close();
    }
  });

  it("account claim, admin root and IRK change give a growing authority generation", async () => {
    const w = await setup();
    try {
      await w.storage.usernames.put({ username: "alice", irkPubHex: IRK, claimedAt: 1 });
      await w.db.prepare("UPDATE usernames SET admin_root_pub_hex = ? WHERE username = ?").bind(ADMIN_ROOT_PUB, "alice").run();
      await w.storage.usernames.swapIrkPub("alice", IRK, pub(6), 2);
      await w.db.prepare("UPDATE usernames SET claimed_at = 9 WHERE username = 'alice'").run(); // not a key change
      const r = (await rows(w.db)).filter((x) => x.kind === "account-authority");
      expect(r.map((x) => [x.f2, x.f3, x.f4])).toEqual([["", IRK, "1"], [ADMIN_ROOT_PUB, IRK, "2"], [ADMIN_ROOT_PUB, pub(6), "3"]]);
      const s = await relayState(w.db);
      expect(relayLogAdminKey(s, "alice")).toBe(ADMIN_ROOT_PUB);
      expect(s.authorities.get(accountHash("alice"))).toMatchObject({ authorityGen: 3, irkPub: pub(6) });
    } finally {
      w.close();
    }
  });

  it("a serving policy stored through the route appends its policy head", async () => {
    const w = await setup();
    try {
      await claimAlice(w);
      await w.storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
      const p = policy({ grace: "30d", issuedAt: Date.now() });
      const signature = hex(signServingRecord("serving-policy", p, (m) => ed.sign(m, ADMIN_ROOT)));
      const res = (await tryControlPlane(
        new Request("https://flagshipserver.com/api/accounts/alice/serving-policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: p, signature }) }),
        w.env,
      ))!;
      expect(res.status).toBe(200);
      const s = await relayState(w.db);
      expect(relayLogPolicyHead(s, BOX, 1)).toMatchObject({ policyGen: 1, policySha256: await sha256hex(canonicalServingPolicy(p)) });
    } finally {
      w.close();
    }
  });

  it("device removal revokes its grants and renewal keys; a grant revocation and a cert list append too", async () => {
    const w = await setup();
    try {
      await claimAlice(w);
      const dev = pub(20);
      await w.storage.deviceIdentities.put({ accountId: "alice", deviceId: "d".repeat(32), devicePubHex: dev, platformClass: null, createdAt: 1, lastSeenAt: 1, revokedAt: null });
      const grant = (n: string) =>
        w.db
          .prepare("INSERT INTO device_capability_grants (grant_id, username, device_id, device_pub_hex, scopes_json, issued_at, expires_at, signature_hex, revoked_at, signer_root) VALUES (?, 'alice', ?, ?, '[]', 1, 9999999999999, ?, NULL, 'admin-root')")
          .bind(n.repeat(64), "d".repeat(32), dev, "00".repeat(64))
          .run();
      await grant("a");
      const renewal = "02" + "cd".repeat(32);
      await w.db.prepare("INSERT INTO renewal_delegations (renewal_pub, username, device_id, record_json, signature, created_at) VALUES (?, 'alice', ?, '{}', 'x', 1)").bind(renewal, dev).run();
      await w.db.prepare("UPDATE device_identities SET revoked_at = 50 WHERE account_id = 'alice'").run();
      // Revoking the same grant again later adds nothing.
      await w.db.prepare("UPDATE device_capability_grants SET revoked_at = 51 WHERE grant_id = ?").bind("a".repeat(64)).run();
      await w.db.prepare("INSERT INTO entitlement_revocation_lists (username, cert_ids_json, irk_signature_hex, issued_at, updated_at) VALUES ('alice', ?, 'x', 1, 1)").bind(JSON.stringify(["e".repeat(64), "not-hex"])).run();
      await w.db.prepare("UPDATE entitlement_revocation_lists SET cert_ids_json = ? WHERE username = 'alice'").bind(JSON.stringify(["e".repeat(64), "f".repeat(64)])).run();
      const r = (await rows(w.db)).filter((x) => x.kind !== "account-authority");
      expect(r.map((x) => [x.kind, x.f1, x.f2])).toEqual([
        ["device-grant-revoke", "a".repeat(64), dev],
        ["renewal-key-revoke", renewal, ""],
        ["cert-revoke", null, "e".repeat(64)],
        ["cert-revoke", null, "f".repeat(64)],
      ]);
      const s = await relayState(w.db);
      expect(s.revokedGrants.get("a".repeat(64))).toBe(dev);
      expect(s.revokedRenewalKeys.has(renewal)).toBe(true);
      expect(s.revokedCerts.has(`${accountHash("alice")}|${"f".repeat(64)}`)).toBe(true);
    } finally {
      w.close();
    }
  });

  it("a grant the apps made (a UUID id, any case) is revoked in the log under its lowercased id (gym run 28)", async () => {
    const w = await setup();
    try {
      await claimAlice(w);
      const uuid = "0F8FAD5B-D9CB-469F-A165-70867728950E";
      const short32 = "ab".repeat(16);
      const devs = [pub(21), pub(22), pub(23)];
      for (const [i, id] of [uuid, short32, "not|an id"].entries()) {
        const deviceId = String(i).repeat(32);
        await w.storage.deviceIdentities.put({ accountId: "alice", deviceId, devicePubHex: devs[i]!, platformClass: null, createdAt: 1, lastSeenAt: 1, revokedAt: null });
        await w.db
          .prepare("INSERT INTO device_capability_grants (grant_id, username, device_id, device_pub_hex, scopes_json, issued_at, expires_at, signature_hex, revoked_at, signer_root) VALUES (?, 'alice', ?, ?, '[]', 1, 9999999999999, ?, NULL, 'admin-root')")
          .bind(id, deviceId, devs[i]!, "00".repeat(64))
          .run();
      }
      await w.db.prepare("UPDATE device_capability_grants SET revoked_at = 60 WHERE grant_id = ?").bind(uuid).run();
      await w.db.prepare("DELETE FROM device_capability_grants WHERE grant_id = ?").bind(short32).run();
      await w.db.prepare("UPDATE device_capability_grants SET revoked_at = 61 WHERE grant_id = ?").bind("not|an id").run();
      const r = (await rows(w.db)).filter((x) => x.kind === "device-grant-revoke");
      expect(r.map((x) => x.f1)).toEqual([uuid.toLowerCase(), short32]);
      const s = await relayState(w.db);
      expect(s.revokedGrants.get(relayLogGrantId(uuid))).toBe(devs[0]);
      expect(s.revokedGrants.get(short32)).toBe(devs[1]);
    } finally {
      w.close();
    }
  });

  it("the entry commits or rolls back with the writer's transaction", async () => {
    const w = await setup();
    try {
      await claimAlice(w);
      await w.storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
      const before = (await rows(w.db)).length;
      await expect(
        w.db.batch([
          w.db.prepare("UPDATE servers SET revoked_at = 7 WHERE server_domain = 'home.alice.flagship.services'"),
          w.db.prepare("INSERT INTO no_such_table VALUES (1)"),
        ]),
      ).rejects.toThrow();
      expect((await rows(w.db)).length).toBe(before);
      await w.storage.servers.revoke("home.alice.flagship.services", "lost", 7);
      expect((await rows(w.db)).length).toBe(before + 1);
    } finally {
      w.close();
    }
  });

  it("writes nothing it could not sign (a malformed key or name never stops the log)", async () => {
    const w = await setup();
    try {
      await claimAlice(w);
      await w.storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: "zz", registeredAt: 1 });
      await w.storage.servers.put({ serverDomain: "we|rd.alice.flagship.services", username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
      expect((await rows(w.db)).filter((x) => x.kind.startsWith("box"))).toEqual([]);
    } finally {
      w.close();
    }
  });
});

// ── the published feed ────────────────────────────────────────────────────

async function admit(w: World, relayId: string, key: Uint8Array, kind = "full") {
  const r = await handleRelayAdmin(
    new Request("https://flagshipserver.com/api/admin/relays", {
      method: "POST",
      headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ op: "add", relayId, relayKey: hex(ed.getPublicKey(key)), kind, region: "iad", ipv4: ["149.248.216.86"], ipv6: [] }),
    }),
    w.env,
    w.now(),
  );
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function admin(w: World, body: Record<string, unknown>) {
  const r = await handleRelayAdmin(
    new Request("https://flagshipserver.com/api/admin/relays", { method: "POST", headers: { "x-admin-secret": ADMIN_SECRET }, body: JSON.stringify(body) }),
    w.env,
    w.now(),
  );
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

function keysOf(w: World, relayId: string, key: Uint8Array) {
  const opened = openRelayMeshKeys(w.bucket.json<RelayMeshKeys>(`v1/keys/${relayId}.json`), key, { servicesApex: APEX, relayId });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.keys;
}

async function openHead(w: World, keys: Map<number, Uint8Array>) {
  const o = await openRelayFeedObject(w.bucket.json("v1/head.json"), { servicesApex: APEX, object: "head", page: null }, (e) => keys.get(e));
  if (!o.ok) return o;
  const head = JSON.parse(o.plaintext) as SignedRelayLogHead;
  expect(verifyRelayLogHead(head, LOG_PUB, APEX)).toEqual({ ok: true });
  return { ...o, head };
}
async function openPage(w: World, page: number, keys: Map<number, Uint8Array>) {
  const o = await openRelayFeedObject(w.bucket.json(`v1/log/${page}.json`), { servicesApex: APEX, object: "log", page }, (e) => keys.get(e));
  return o.ok ? { ...o, body: JSON.parse(o.plaintext) as { page: number; entries: SignedRelayLogEntry[] } } : o;
}

describe("feed files (§4.5, §4.5.1)", () => {
  it("publishes encrypted pages and a signed head a relay can open, verify and apply", async () => {
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      await claimAlice(w);
      await w.storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
      await w.feed.feed().publishRelayFeed();
      const keys = keysOf(w, "iad1", RELAY_A);
      const head = await openHead(w, keys);
      if (!("head" in head)) throw new Error("head did not open");
      const page = await openPage(w, 0, keys);
      if (!("body" in page)) throw new Error("page did not open");
      const applied = applyRelayLog(emptyRelayLogState(APEX), page.body.entries, LOG_PUB);
      expect(applied.ok).toBe(true);
      expect(relayLogHeadStatus(applied.state, head.head.head)).toBe("applied");
      expect(head.head.head.directoryVersion).toBe(1);
      expect(relayLogBox(applied.state, "home.alice.flagship.services")?.boxPub).toBe(BOX);
      // No plaintext of a box key or name hash is in what anyone can fetch.
      const raw = w.bucket.objects.get("v1/log/0.json")!.body;
      expect(raw).not.toContain(BOX);
      expect(raw).not.toContain(nameHash("home.alice.flagship.services"));
      expect(w.bucket.json("v1/log-key.json")).toEqual({ logKey: LOG_PUB });
      // Without the key, or with a page moved to another slot, nothing opens.
      expect(await openRelayFeedObject(w.bucket.json("v1/head.json"), { servicesApex: APEX, object: "head", page: null }, () => null)).toEqual({ ok: false, reason: "no-key" });
      expect(await openRelayFeedObject(w.bucket.json("v1/log/0.json"), { servicesApex: APEX, object: "log", page: 1 }, (e) => keys.get(e))).toEqual({ ok: false, reason: "wrong-place" });
      const tampered = { ...w.bucket.json<{ page: number }>("v1/log/0.json"), page: 1 };
      expect(await openRelayFeedObject(tampered, { servicesApex: APEX, object: "log", page: 1 }, (e) => keys.get(e))).toEqual({ ok: false, reason: "undecryptable" });
    } finally {
      w.close();
    }
  });

  it("caches the head and the tail page 2 s, a full page for a year, the directory a minute", async () => {
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      const stmts = [];
      for (let i = 0; i < FEED_PAGE_ENTRIES + 3; i++) {
        stmts.push(relayLogAppend(w.db, { kind: "renewal-key-revoke", at: i, f1: "02" + i.toString(16).padStart(64, "0") }, 1));
      }
      await w.db.batch(stmts);
      await w.feed.feed().publishRelayFeed();
      expect(w.bucket.objects.get("v1/head.json")!.cacheControl).toBe("public, max-age=2");
      expect(w.bucket.objects.get("v1/log/0.json")!.cacheControl).toBe(FEED_CACHE.fullPage);
      expect(FEED_CACHE.fullPage).toBe("public, max-age=31536000, immutable");
      expect(w.bucket.objects.get("v1/log/1.json")!.cacheControl).toBe("public, max-age=2");
      expect(w.bucket.objects.get("v1/directory.json")!.cacheControl).toBe("public, max-age=60");
      expect(w.bucket.objects.get("v1/log-key.json")!.cacheControl).toBe("public, max-age=3600");
      const keys = keysOf(w, "iad1", RELAY_A);
      const p0 = await openPage(w, 0, keys);
      const p1 = await openPage(w, 1, keys);
      if (!("body" in p0) || !("body" in p1)) throw new Error("pages did not open");
      expect(p0.body.entries.map((e) => e.entry.sequence)).toEqual(Array.from({ length: FEED_PAGE_ENTRIES - 1 }, (_, i) => i + 1));
      expect(p1.body.entries[0]!.entry.sequence).toBe(FEED_PAGE_ENTRIES);
      // The next publish rewrites only the tail page.
      w.bucket.objects.delete("v1/log/0.json");
      await w.db.batch([relayLogAppend(w.db, { kind: "renewal-key-revoke", at: 1, f1: "03" + "1".repeat(64) }, 1)]);
      await w.feed.feed().publishRelayFeed();
      expect(w.bucket.objects.has("v1/log/0.json")).toBe(false);
      expect(w.bucket.objects.has("v1/log/1.json")).toBe(true);
    } finally {
      w.close();
    }
  });

  it("re-mints the head every 5 s on the alarm while the mesh is on, and publishes nothing while it is off", async () => {
    const off = await setup({ mesh: false });
    try {
      await claimAlice(off);
      await off.feed.feed().publishRelayFeed();
      await off.feed.feed().fetch(new Request("https://serving-feed/notify", { method: "POST", body: JSON.stringify({ type: "ensure" }) }));
      expect(off.bucket.objects.size).toBe(0);
      expect(off.feed.alarm()).toBeNull();
      // Still signed, ready for the day the mesh is turned on.
      expect((await rows(off.db)).every((r) => r.signature)).toBe(true);
    } finally {
      off.close();
    }
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      await w.feed.feed().fetch(new Request("https://serving-feed/notify", { method: "POST", body: JSON.stringify({ type: "ensure" }) }));
      const keys = keysOf(w, "iad1", RELAY_A);
      const first = await openHead(w, keys);
      expect(w.feed.alarm()).not.toBeNull();
      w.tick(5_000);
      await w.feed.feed().alarm();
      const second = await openHead(w, keys);
      if (!("head" in first) || !("head" in second)) throw new Error("heads did not open");
      expect(second.head.head.issuedAt - first.head.head.issuedAt).toBe(5_000);
      expect(w.feed.alarm()).toBe(w.now() + 5_000);
    } finally {
      w.close();
    }
  });
});

describe("signer stall (§4.6; security review 2026-11-02)", () => {
  it("a row unsigned for more than 60 s stops fresh heads and raises an alarm; signed again, heads resume", async () => {
    const w = await setup();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => void errors.push(String(m));
    try {
      await admit(w, "iad1", RELAY_A);
      await w.feed.feed().publishRelayFeed();
      const keys = keysOf(w, "iad1", RELAY_A);
      const first = await openHead(w, keys);
      if (!("head" in first)) throw new Error("head did not open");
      // A row the signer cannot carry (a policy head whose policy is not JSON).
      await relayLogAppend(w.db, { kind: "policy-head", at: w.now(), src: "not json", f1: BOX, f2: "1", f3: "1", f4: null }, w.now()).run();
      w.tick(5_000);
      await w.feed.feed().publishRelayFeed();
      const second = await openHead(w, keys);
      if (!("head" in second)) throw new Error("head did not open");
      expect(second.head.head.issuedAt).toBe(first.head.head.issuedAt + 5_000);
      w.tick(61_000);
      expect(await w.feed.feed().publishRelayFeed()).toBeNull();
      const stalled = await openHead(w, keys);
      if (!("head" in stalled)) throw new Error("head did not open");
      expect(stalled.head.head.issuedAt).toBe(second.head.head.issuedAt);
      expect(errors.some((e) => e.includes("relay-log-signer-stalled"))).toBe(true);
      // The alarm keeps firing, so the head comes back once the row is gone or signable.
      await w.db.prepare("DELETE FROM relay_log WHERE signature IS NULL").run();
      w.tick(5_000);
      await w.feed.feed().publishRelayFeed();
      const resumed = await openHead(w, keys);
      if (!("head" in resumed)) throw new Error("head did not open");
      expect(resumed.head.head.issuedAt).toBe(w.now());
    } finally {
      console.error = orig;
      w.close();
    }
  });
});

// ── mesh-key epochs ──────────────────────────────────────────────────────

describe("mesh key rotation", () => {
  it("a retired relay keeps old pages but cannot open anything written after its removal", async () => {
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      await admit(w, "ams1", RELAY_B);
      await claimAlice(w);
      await w.feed.feed().publishRelayFeed();
      const oldKeysB = keysOf(w, "ams1", RELAY_B);
      expect([...oldKeysB.keys()]).toEqual([1]);
      const before = await openPage(w, 0, oldKeysB);
      expect(before.ok).toBe(true);

      const r = await admin(w, { op: "retire", relayId: "ams1" });
      expect(r.status).toBe(200);
      expect(r.body.meshEpoch).toBe(2);
      // The retired relay's own key file was not re-sealed; the remaining one holds both epochs.
      expect(w.bucket.json<RelayMeshKeys>("v1/keys/ams1.json").current).toBe(1);
      const keysA = keysOf(w, "iad1", RELAY_A);
      expect([...keysA.keys()]).toEqual([1, 2]);

      const headA = await openHead(w, keysA);
      expect(headA.ok && headA.epoch).toBe(2);
      expect(await openHead(w, oldKeysB)).toEqual({ ok: false, reason: "no-key" });
      expect(await openPage(w, 0, oldKeysB)).toEqual({ ok: false, reason: "no-key" });
      const pageA = await openPage(w, 0, keysA);
      if (!("body" in pageA)) throw new Error("page did not open");
      expect(pageA.body.entries.some((e) => e.entry.kind === "relay-revoke" && e.entry.f1 === "ams1")).toBe(true);
      // A sealed key file names its relay: another relay's seed opens nothing in it.
      expect(openRelayMeshKeys(w.bucket.json("v1/keys/iad1.json"), RELAY_B, { servicesApex: APEX, relayId: "iad1" })).toEqual({ ok: false, reason: "no-current-key" });
      expect(openRelayMeshKeys(w.bucket.json("v1/keys/iad1.json"), RELAY_A, { servicesApex: APEX, relayId: "ams1" })).toEqual({ ok: false, reason: "wrong-relay" });
    } finally {
      w.close();
    }
  });
});

// ── directory ─────────────────────────────────────────────────────────────

describe("relay directory (§3.3)", () => {
  it("bumps the version on every change, re-mints the same version daily, and is CA-signed", async () => {
    const w = await setup();
    try {
      const ca = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: CA_PRIV_HEX });
      expect((await mintRelayDirectory(w.env, w.db, ca, w.now())).directory).toBeNull();
      expect((await admit(w, "iad1", RELAY_A)).body.directoryVersion).toBe(1);
      expect((await admit(w, "iad1", RELAY_B)).status).toBe(409);
      expect((await admit(w, "ams1", RELAY_A)).status).toBe(409);
      expect((await admit(w, "ams1", RELAY_B, "entry")).body.directoryVersion).toBe(2);
      const same = await mintRelayDirectory(w.env, w.db, ca, w.now());
      expect(same.minted).toBe(false);
      w.tick(24 * 3_600_000 + 1_000);
      const daily = await mintRelayDirectory(w.env, w.db, ca, w.now());
      expect(daily).toMatchObject({ minted: true, directory: { directoryVersion: 2, issuedAt: w.now() } });
      expect((await admin(w, { op: "update", relayId: "ams1", ipv6: ["2a09:8280:1::1"] })).body.directoryVersion).toBe(3);
      expect((await admin(w, { op: "retire", relayId: "ams1" })).body.directoryVersion).toBe(4);
      const published = w.bucket.json<{ directory: RelayDirectory; blessings: RelayBlessing[] }>("v1/directory.json");
      expect(published.directory.directoryVersion).toBe(4);
      expect(published.directory.relays.map((r) => r.relayId)).toEqual(["iad1"]);
      expect(verifyRelayDirectory(published.directory, [CA_PUB], w.now(), APEX)).toEqual({ ok: true, expired: false });
      expect((await admin(w, { op: "list" })).body).toMatchObject({ directoryVersion: 4, meshEpoch: 2, mesh: true });
    } finally {
      w.close();
    }
  });

  it("the admin route needs the admin secret", async () => {
    const w = await setup();
    try {
      const r = await handleRelayAdmin(new Request("https://x/api/admin/relays", { method: "POST", body: JSON.stringify({ op: "list" }) }), w.env);
      expect(r.status).toBe(401);
      const wrong = await handleRelayAdmin(new Request("https://x/api/admin/relays", { method: "POST", headers: { "x-admin-secret": "no" }, body: "{}" }), w.env);
      expect(wrong.status).toBe(403);
    } finally {
      w.close();
    }
  });

  it("GET /api/services/endpoints lists the directory's relays", async () => {
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      resetEndpointRelayCache();
      const res = await route(new Request("https://flagshipserver.com/api/services/endpoints"), w.env as never);
      const body = (await res.json()) as { relays: unknown; tunnelHub: string };
      expect(body.relays).toEqual([{ relayId: "iad1", tunnelHost: "iad1.tunnel.flagship.services", ipv4: ["149.248.216.86"], ipv6: [] }]);
      expect(body.tunnelHub).toBe("wss://tunnel.flagship.services:8443/tunnel");
      expect(await endpointRelays(undefined, 0)).toEqual([]);
    } finally {
      w.close();
    }
  });
});

// ── blessing (§3.2) ───────────────────────────────────────────────────────

function blessingRequest(key: Uint8Array, relayId: string, issuedAt: number, o: { apex?: string; signWith?: Uint8Array } = {}) {
  const r = { relayId, relayKey: hex(ed.getPublicKey(key)), servicesApex: o.apex ?? APEX, issuedAt };
  return { ...r, signature: hex(ed.sign(canonicalRelayBlessingRequest(r), o.signWith ?? key)) };
}
async function bless(w: World, body: unknown) {
  const r = await handleRelayBlessing(
    new Request("https://flagshipserver.com/api/services/relay-blessing", { method: "POST", body: JSON.stringify(body) }),
    w.env,
    { now: w.now },
  );
  return { status: r.status, body: (await r.json()) as { relayBlessing?: RelayBlessing; serviceBlessing?: { hubKeyPub: string; expiresAt: number }; meshKeys?: RelayMeshKeys; code?: string } };
}

describe("POST /api/services/relay-blessing (proof of key)", () => {
  it("blesses an admitted relay for 30 days and hands it its sealed mesh keys", async () => {
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      const r = await bless(w, blessingRequest(RELAY_A, "iad1", w.now()));
      expect(r.status).toBe(200);
      const b = r.body.relayBlessing!;
      expect(verifyRelayBlessing(b, [CA_PUB], w.now(), APEX)).toEqual({ ok: true });
      expect(b).toMatchObject({ relayId: "iad1", relayKind: "full", tunnelHost: "iad1.tunnel.flagship.services", expiresAt: w.now() + RELAY_BLESSING_COM_TTL_MS });
      expect(RELAY_BLESSING_COM_TTL_MS).toBe(30 * 86_400_000);
      expect(r.body.serviceBlessing).toMatchObject({ hubKeyPub: b.relayKey, expiresAt: b.expiresAt });
      const keys = openRelayMeshKeys(r.body.meshKeys, RELAY_A, { servicesApex: APEX, relayId: "iad1" });
      expect(keys.ok).toBe(true);
      // Peers can hand a restarted relay its blessing back: the directory file carries it.
      expect(w.bucket.json<{ blessings: RelayBlessing[] }>("v1/directory.json").blessings).toEqual([b]);
    } finally {
      w.close();
    }
  });

  it("refuses a bad signature, a stale clock, another apex, an unknown or retired relay and another key", async () => {
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      expect((await bless(w, blessingRequest(RELAY_A, "iad1", w.now(), { signWith: RELAY_B }))).body.code).toBe("relay-blessing-signature");
      expect((await bless(w, blessingRequest(RELAY_A, "iad1", w.now() - 61_000))).body.code).toBe("relay-blessing-stale");
      expect((await bless(w, blessingRequest(RELAY_A, "iad1", w.now(), { apex: "gym.flagship.services" }))).body.code).toBe("relay-blessing-wrong-apex");
      expect((await bless(w, { relayId: "iad1" })).body.code).toBe("relay-blessing-malformed");
      expect((await bless(w, blessingRequest(RELAY_A, "ams1", w.now()))).body.code).toBe("relay-not-admitted");
      expect((await bless(w, blessingRequest(RELAY_B, "iad1", w.now()))).body.code).toBe("relay-key-unknown");
      await admin(w, { op: "retire", relayId: "iad1" });
      expect((await bless(w, blessingRequest(RELAY_A, "iad1", w.now()))).body.code).toBe("relay-not-admitted");
    } finally {
      w.close();
    }
  });

  it("forced rotation: past the deadline the old key is refused; the staged key promotes itself", async () => {
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      const next = hex(ed.getPublicKey(RELAY_B));
      expect((await admin(w, { op: "stage-key", relayId: "iad1", nextKey: next, deadline: w.now() + 3_600_000 })).status).toBe(200);
      expect((await bless(w, blessingRequest(RELAY_A, "iad1", w.now()))).status).toBe(200);
      w.tick(3_600_001);
      expect((await bless(w, blessingRequest(RELAY_A, "iad1", w.now()))).body.code).toBe("relay-key-rotation-required");
      const promoted = await bless(w, blessingRequest(RELAY_B, "iad1", w.now()));
      expect(promoted.status).toBe(200);
      expect(promoted.body.relayBlessing!.relayKey).toBe(next);
      expect(openRelayMeshKeys(promoted.body.meshKeys, RELAY_B, { servicesApex: APEX, relayId: "iad1" }).ok).toBe(true);
      const dir = w.bucket.json<{ directory: RelayDirectory }>("v1/directory.json").directory;
      expect(dir.directoryVersion).toBe(2);
      expect(dir.relays[0]!.relayKey).toBe(next);
      expect((await bless(w, blessingRequest(RELAY_A, "iad1", w.now()))).body.code).toBe("relay-key-unknown");
    } finally {
      w.close();
    }
  });

  it("promoting a staged key starts a new mesh-key epoch the old key is not sealed to", async () => {
    const w = await setup();
    try {
      await admit(w, "iad1", RELAY_A);
      const before = (await bless(w, blessingRequest(RELAY_A, "iad1", w.now()))).body.meshKeys!.current;
      await admin(w, { op: "stage-key", relayId: "iad1", nextKey: hex(ed.getPublicKey(RELAY_B)) });
      const promoted = await bless(w, blessingRequest(RELAY_B, "iad1", w.now()));
      expect(promoted.status).toBe(200);
      expect(promoted.body.meshKeys!.current).toBe(before + 1);
      expect(openRelayMeshKeys(promoted.body.meshKeys, RELAY_B, { servicesApex: APEX, relayId: "iad1" }).ok).toBe(true);
      expect(openRelayMeshKeys(promoted.body.meshKeys, RELAY_A, { servicesApex: APEX, relayId: "iad1" }).ok).toBe(false);
      expect(w.bucket.json<RelayMeshKeys>("v1/keys/iad1.json").current).toBe(before + 1);
    } finally {
      w.close();
    }
  });
});

// ── backfill ──────────────────────────────────────────────────────────────

describe("backfill (§13.2 step 1)", () => {
  it("appends the current state once; a second run appends nothing", async () => {
    const w = await setup();
    try {
      await claimAlice(w);
      await w.storage.usernames.put({ username: "bob", irkPubHex: pub(7), claimedAt: 1 });
      await w.storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
      await w.storage.servers.put({ serverDomain: "home.bob.flagship.services", username: "bob", identityPubKeyHex: BOX2, registeredAt: 2 });
      await w.storage.servers.revoke("home.bob.flagship.services", "lost", 3);
      const p = policy();
      await w.db.prepare("INSERT INTO serving_policies (username, box_pub, reg_gen, policy_gen, record_json, signature, updated_at) VALUES ('alice', ?, 1, 1, ?, 'x', 1)").bind(BOX, JSON.stringify(p)).run();
      // A database from before migration 0122: the log is empty.
      const expected = await relayState(w.db);
      await w.db.batch([w.db.prepare("DELETE FROM relay_log"), w.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'relay_log'")]);

      const first = await backfillRelayLog(w.env, w.db);
      // alice and bob's authorities, alice's server, her policy, bob's revoked server.
      expect(first.appended).toBe(5);
      const second = await backfillRelayLog(w.env, w.db);
      expect(second).toEqual({ appended: 0, sequence: first.sequence });
      const s = await relayState(w.db);
      expect(relayLogBox(s, "home.alice.flagship.services")).toMatchObject({ boxPub: BOX, regGen: 1 });
      expect(s.revokedBoxes).toEqual(expected.revokedBoxes);
      expect(relayLogAdminKey(s, "alice")).toBe(ADMIN_ROOT_PUB);
      expect(relayLogAdminKey(s, "bob")).toBe(pub(7));
      expect(relayLogPolicyHead(s, BOX, 1)?.policySha256).toBe(expected.policyHeads.get(`${BOX}|1`)?.policySha256);
      // A key change after the backfill is appended once, by its trigger; the backfill then has nothing to add.
      await w.storage.usernames.swapIrkPub("bob", pub(7), pub(8), 4);
      expect((await backfillRelayLog(w.env, w.db)).appended).toBe(0);
      expect(relayLogAdminKey(await relayState(w.db), "bob")).toBe(pub(8));
    } finally {
      w.close();
    }
  });
});

// ── the outage rule's inputs (§4.6, owner decision 2026-11-01) ────────────

describe("outage rule inputs", () => {
  it("the policy head lets a relay tell an indefinite box from a time-limited one", async () => {
    const w = await setup();
    try {
      await claimAlice(w);
      await w.storage.usernames.put({ username: "bob", irkPubHex: pub(7), claimedAt: 1 });
      await w.storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
      await w.storage.servers.put({ serverDomain: "home.bob.flagship.services", username: "bob", identityPubKeyHex: BOX2, registeredAt: 1 });
      const indefinite = policy();
      const limited = policy({ account: "bob", box: BOX2, grace: "7d" });
      await w.db.prepare("INSERT INTO serving_policies (username, box_pub, reg_gen, policy_gen, record_json, signature, updated_at) VALUES ('alice', ?, 1, 1, ?, 'x', 1)").bind(BOX, JSON.stringify(indefinite)).run();
      await w.db.prepare("INSERT INTO serving_policies (username, box_pub, reg_gen, policy_gen, record_json, signature, updated_at) VALUES ('bob', ?, 1, 1, ?, 'x', 1)").bind(BOX2, JSON.stringify(limited)).run();
      const s = await relayState(w.db);
      const decide = (account: string, box: string, p: ServingPolicy, key: Uint8Array) => {
        const admin = relayLogAdminKey(s, account)!;
        const head = relayLogPolicyHead(s, box, 1);
        return servingDecision({
          account, box, regGen: relayLogBox(s, `home.${account}.flagship.services`)!.regGen, adminKeyFromCom: admin, adminKeyFromBox: admin,
          policies: [{ record: p, signature: hex(signServingRecord("serving-policy", p, (m) => ed.sign(m, key))) }],
          leases: [], revocations: emptyRevocationState(), policyHead: head, now: w.now(),
        });
      };
      // Indefinite: apps on with no end, so the relay keeps it through a .com outage.
      expect(decide("alice", BOX, indefinite, ADMIN_ROOT)).toMatchObject({ apps: true, until: null });
      // Time-limited (here with no lease): not exempt; the strict contact rule applies.
      expect(decide("bob", BOX2, limited, seed(7))).toMatchObject({ apps: false });
      // A box cannot pass a time-limited server off as indefinite: the head names the stored policy's hash.
      const forged = { ...limited, grace: "indefinite" as const };
      expect(decide("bob", BOX2, forged, seed(7))).toMatchObject({ apps: false, reason: "policy-stale" });
    } finally {
      w.close();
    }
  });
});
