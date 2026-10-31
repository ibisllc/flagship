/**
 * The ServingFeed Durable Object (docs/architecture-v2/serving-wiring.md §1): replay since a sequence on
 * hello, live revocations after a flush, `changed`, the beat, and stored acks. Sockets and state are fakes;
 * D1 is the real schema over sqlite, with the revocation log written by its triggers.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, type D1Database } from "@flagship/storage";
import { applyRevocationEntries, ed, emptyRevocationState } from "@flagship/protocol";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { BEAT_MS, ServingFeed, type ServingFeedState } from "../src/servingFeed.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const SEED_HEX = "22".repeat(32);
const REVOCATION_PUB = hex(ed.getPublicKey(new Uint8Array(32).fill(0x22)));
const box = (n: number) => hex(ed.getPublicKey(new Uint8Array(32).fill(n)));

class FakeSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private attachment: unknown = null;
  send(s: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(JSON.parse(s) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  frames(type: string) {
    return this.sent.filter((f) => f.type === type);
  }
}

function fakeState() {
  const store = new Map<string, unknown>();
  const sockets: Array<{ ws: FakeSocket; tags: string[] }> = [];
  let alarm: number | null = null;
  const state: ServingFeedState = {
    storage: {
      get: async <T,>(k: string) => store.get(k) as T | undefined,
      put: async (k, v) => void store.set(k, v),
      setAlarm: async (t) => void (alarm = t),
      getAlarm: async () => alarm,
    },
    acceptWebSocket: (ws, tags = []) => void sockets.push({ ws: ws as unknown as FakeSocket, tags }),
    getWebSockets: (tag?: string) => sockets.filter((s) => !s.ws.closed && (!tag || s.tags.includes(tag))).map((s) => s.ws as unknown as WebSocket),
  };
  return { state, alarm: () => alarm, clearAlarm: () => void (alarm = null) };
}

async function setup() {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const storage = new D1Storage(db);
  for (const [i, user] of ["alice", "bob", "carol"].entries()) {
    await storage.usernames.put({ username: user, irkPubHex: box(40 + i), claimedAt: 1 });
    await storage.servers.put({ serverDomain: `home.${user}.flagship.services`, username: user, identityPubKeyHex: box(50 + i), registeredAt: 1 });
  }
  const s = fakeState();
  let now = 1_000_000;
  const feed = new ServingFeed(s.state, { DB: db, SERVING_REVOCATION_SEED: SEED_HEX }, () => now);
  return { sqlite, storage, feed, ...s, tick: (ms: number) => void (now += ms), close: () => sqlite.close() };
}

const hello = (feed: ServingFeed, ws: FakeSocket, since: number) =>
  feed.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "hello", since }));

describe("ServingFeed", () => {
  it("replays the signed log after `since` on hello, then a beat", async () => {
    const t = await setup();
    try {
      await t.storage.servers.revoke("home.alice.flagship.services", "lost", 10);
      await t.storage.servers.revoke("home.bob.flagship.services", "lost", 20);
      const ws = new FakeSocket();
      await t.feed.accept(ws as unknown as WebSocket, "relay-1");
      expect(t.alarm()).not.toBeNull();
      await hello(t.feed, ws, 1);
      const revs = ws.frames("revocation") as Array<{ entry: { sequence: number }; signature: string }>;
      expect(revs.map((f) => f.entry.sequence)).toEqual([2]);
      expect(ws.sent.at(-1)).toEqual({ type: "beat", sequence: 2 });

      const fresh = new FakeSocket();
      await t.feed.accept(fresh as unknown as WebSocket, "relay-2");
      await hello(t.feed, fresh, 0);
      const all = fresh.frames("revocation") as Array<{ entry: never; signature: string }>;
      const applied = applyRevocationEntries(emptyRevocationState(), all.map((f) => ({ entry: f.entry, signature: f.signature })), REVOCATION_PUB);
      expect(applied.ok && applied.state.sequence).toBe(2);
    } finally {
      t.close();
    }
  });

  it("pushes a new revocation to every ready relay on flush, in order, once", async () => {
    const t = await setup();
    try {
      const a = new FakeSocket();
      const b = new FakeSocket();
      await t.feed.accept(a as unknown as WebSocket, "a");
      await t.feed.accept(b as unknown as WebSocket, "b");
      await hello(t.feed, a, 0);
      await t.feed.flush();
      await t.storage.servers.revoke("home.alice.flagship.services", "lost", 10);
      await t.storage.servers.revoke("home.carol.flagship.services", "lost", 11);
      const r = await t.feed.fetch(new Request("https://serving-feed/notify", { method: "POST", body: JSON.stringify({ type: "flush" }) }));
      expect(await r.json()).toEqual({ sequence: 2 });
      expect(a.frames("revocation").map((f) => (f.entry as { sequence: number }).sequence)).toEqual([1, 2]);
      // b never said hello: it gets nothing live until its replay.
      expect(b.frames("revocation")).toEqual([]);
      await t.feed.flush();
      expect(a.frames("revocation")).toHaveLength(2);
      await hello(t.feed, b, 1);
      expect(b.frames("revocation").map((f) => (f.entry as { sequence: number }).sequence)).toEqual([2]);
    } finally {
      t.close();
    }
  });

  it("relays `changed`, beats on the alarm and re-arms it while relays are connected", async () => {
    const t = await setup();
    try {
      const ws = new FakeSocket();
      await t.feed.accept(ws as unknown as WebSocket, "relay-1");
      await hello(t.feed, ws, 0);
      await t.feed.fetch(new Request("https://serving-feed/notify", { method: "POST", body: JSON.stringify({ type: "changed", username: "alice", boxPub: box(50) }) }));
      expect(ws.frames("changed")).toEqual([{ type: "changed", username: "alice", boxPub: box(50) }]);
      t.clearAlarm();
      t.tick(BEAT_MS);
      await t.storage.servers.revoke("home.bob.flagship.services", "lost", 10);
      await t.feed.alarm();
      expect(ws.frames("revocation")).toHaveLength(1);
      expect(ws.sent.at(-1)).toEqual({ type: "beat", sequence: 1 });
      expect(t.alarm()).toBe(1_000_000 + 2 * BEAT_MS);
      expect(BEAT_MS).toBeLessThanOrEqual(30_000);
    } finally {
      t.close();
    }
  });

  it("stores acks per relay and closes the older socket of a reconnecting relay", async () => {
    const t = await setup();
    try {
      const old = new FakeSocket();
      await t.feed.accept(old as unknown as WebSocket, "relay-1");
      const ws = new FakeSocket();
      await t.feed.accept(ws as unknown as WebSocket, "relay-1");
      expect(old.closed).toBe(true);
      await t.feed.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "ack", sequence: 3 }));
      await t.feed.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "ack", sequence: 2 }));
      const rows = t.sqlite.raw.prepare("SELECT relay_id, sequence, seen_at FROM serving_relay_acks").all();
      expect(rows).toEqual([{ relay_id: "relay-1", sequence: 3, seen_at: 1_000_000 }]);
    } finally {
      t.close();
    }
  });
});
