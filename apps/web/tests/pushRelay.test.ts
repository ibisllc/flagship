import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import {
  InMemoryPushTokenStore,
  NoopPushDispatcher,
  type PushDispatcher,
  type PushTokenRecord,
} from "../src/routes/pushRelay.js";

const irkA = "11".repeat(32);
const irkB = "22".repeat(32);

function tracingDispatcher(): PushDispatcher & { events: { token: string; size: number; collapseId?: string }[] } {
  const events: { token: string; size: number; collapseId?: string }[] = [];
  return {
    events,
    async dispatch(rec: PushTokenRecord, opts: { ciphertext: Uint8Array; collapseId?: string }) {
      events.push({ token: rec.pushToken, size: opts.ciphertext.length, collapseId: opts.collapseId });
      return { ok: true };
    },
  };
}

describe("/api/push/register", () => {
  it("stores a registration and looks it up by IRK pubkey hex", async () => {
    const store = new InMemoryPushTokenStore();
    const app = buildServer({ pushTokenStore: store, pushDispatcher: new NoopPushDispatcher() });
    const r = await app.inject({
      method: "POST",
      url: "/api/push/register",
      payload: { irkPub: irkA, platform: "apns", pushToken: "apns-token-abc" },
    });
    expect(r.statusCode).toBe(200);
    expect(store.getByIrk(irkA)?.platform).toBe("apns");
    expect(store.getByIrk(irkA)?.pushToken).toBe("apns-token-abc");
  });

  it("rejects malformed irkPub or platform", async () => {
    const app = buildServer();
    expect(
      (await app.inject({
        method: "POST",
        url: "/api/push/register",
        payload: { irkPub: "short", platform: "apns", pushToken: "x" },
      })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({
        method: "POST",
        url: "/api/push/register",
        payload: { irkPub: irkA, platform: "blackberry", pushToken: "x" },
      })).statusCode,
    ).toBe(400);
  });
});

describe("/api/push/dispatch", () => {
  it("forwards an opaque ciphertext to the registered push token (server cannot read payload)", async () => {
    const store = new InMemoryPushTokenStore();
    const dispatcher = tracingDispatcher();
    const app = buildServer({ pushTokenStore: store, pushDispatcher: dispatcher });
    await app.inject({
      method: "POST",
      url: "/api/push/register",
      payload: { irkPub: irkA, platform: "fcm", pushToken: "fcm-tok-XYZ" },
    });
    const cipher = "deadbeef".repeat(8);
    const r = await app.inject({
      method: "POST",
      url: "/api/push/dispatch",
      payload: { toIrkPub: irkA, ciphertext: cipher, collapseId: "boot-auth" },
    });
    expect(r.statusCode).toBe(200);
    expect(dispatcher.events).toHaveLength(1);
    expect(dispatcher.events[0]!.token).toBe("fcm-tok-XYZ");
    expect(dispatcher.events[0]!.size).toBe(cipher.length / 2);
    expect(dispatcher.events[0]!.collapseId).toBe("boot-auth");
  });

  it("returns 404 when the target IRK has no registered token", async () => {
    const app = buildServer();
    const r = await app.inject({
      method: "POST",
      url: "/api/push/dispatch",
      payload: { toIrkPub: irkB, ciphertext: "00" },
    });
    expect(r.statusCode).toBe(404);
  });

  it("rejects oversize payloads with 413 (APNs/FCM cap)", async () => {
    const store = new InMemoryPushTokenStore();
    const app = buildServer({ pushTokenStore: store, pushDispatcher: new NoopPushDispatcher() });
    await app.inject({
      method: "POST",
      url: "/api/push/register",
      payload: { irkPub: irkA, platform: "apns", pushToken: "tok" },
    });
    const big = "00".repeat(4 * 1024); // 4 KiB > 3 KiB cap
    const r = await app.inject({
      method: "POST",
      url: "/api/push/dispatch",
      payload: { toIrkPub: irkA, ciphertext: big },
    });
    expect(r.statusCode).toBe(413);
  });

  it("rate-limits to one dispatch per minIntervalMs per IRK", async () => {
    const store = new InMemoryPushTokenStore();
    const app = buildServer({ pushTokenStore: store, pushDispatcher: new NoopPushDispatcher() });
    await app.inject({
      method: "POST",
      url: "/api/push/register",
      payload: { irkPub: irkA, platform: "apns", pushToken: "tok" },
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/push/dispatch",
      payload: { toIrkPub: irkA, ciphertext: "00" },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/push/dispatch",
      payload: { toIrkPub: irkA, ciphertext: "11" },
    });
    expect(second.statusCode).toBe(429);
  });

  it("rejects malformed bodies", async () => {
    const app = buildServer();
    const r = await app.inject({
      method: "POST",
      url: "/api/push/dispatch",
      payload: { toIrkPub: "short", ciphertext: "00" },
    });
    expect(r.statusCode).toBe(400);
  });
});
