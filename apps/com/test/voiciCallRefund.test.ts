/**
 * Refunding an answered voi.ci call's ring (docs/voici-calls.md §6): the counter's refund op, and the call room giving
 * the ring back once, only to a caller still in good standing, never the per-address budget.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Storage, type D1Database } from "@flagship/storage";
import type { VoiciCallRoomInit } from "@flagship/control-plane";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { checkRateLimit, refundSubjectRateLimit, type RateLimitEndpoint, type RateLimitNamespace } from "../src/rateLimit.js";
import { refundWindows } from "../src/rateLimitCounter.js";
import { VoiciCallRoom } from "../src/voiciCallRoom.js";
import { memoryRateLimits } from "./rateLimitFakes.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "../../../packages/protocol/test-vectors/voici-calls/vectors.json"), "utf8"));
const K = V.keys;
const NOW: number = V.now;
const RANG = NOW - 5_000;

describe("the counter's refund", () => {
  it("drops the one pass nearest the ring time from every window, within a minute", () => {
    expect(refundWindows({ "3/3600": [1000, 50_000, 51_000], "10/86400": [1000, 50_000] }, 49_000)).toEqual({ logs: { "3/3600": [1000, 51_000], "10/86400": [1000] }, refunded: 2 });
    expect(refundWindows({ "3/3600": [1000] }, 200_000)).toEqual({ logs: { "3/3600": [1000] }, refunded: 0 });
  });

  it("frees a slot in a full subject budget; the per-address budget is never refundable", async () => {
    let t = RANG;
    const { ns } = memoryRateLimits({ now: () => t });
    const env = { RATE_LIMITS: ns };
    const hit = (endpoint: RateLimitEndpoint, subject?: string) => checkRateLimit(env, { endpoint, ip: "1.2.3.4", ...(subject ? { subject } : {}) });
    for (let i = 0; i < 3; i++) expect((await hit("voici-call-caller", "p")).limited).toBe(false);
    t += 1000;
    expect((await hit("voici-call-caller", "p")).limited).toBe(true);
    expect(await refundSubjectRateLimit(env, "voici-call-caller", "p", RANG)).toBe(true);
    expect((await hit("voici-call-caller", "p")).limited).toBe(false);
    expect(await refundSubjectRateLimit(env, "voici-call", "1.2.3.4", RANG)).toBe(false);
    expect(await refundSubjectRateLimit({}, "voici-call-caller", "p", RANG)).toBe(false);
  });
});

function roomState() {
  const data = new Map<string, unknown>();
  return {
    data,
    storage: {
      get: async <T>(k: string) => data.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
      deleteAll: async () => data.clear(),
      setAlarm: async () => {},
    },
    acceptWebSocket: () => {},
    getWebSockets: () => [] as WebSocket[],
  };
}

const device = { send: () => {}, close: () => {}, readyState: 1, deserializeAttachment: () => ({ role: "device", deviceRef: K.deviceRef }) } as unknown as WebSocket;

describe("the call room's refund", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  async function call(o: { talkMs: number; blocked?: boolean; endless?: boolean }) {
    vi.setSystemTime(RANG);
    const sqlite = createSqliteD1();
    const db = sqlite as unknown as D1Database;
    const { ns } = memoryRateLimits({ now: () => Date.now() });
    const counted = { caller: 0, page: 0 };
    const rl: RateLimitNamespace = {
      idFromName: ns.idFromName,
      get: (id: never) => {
        const stub = ns.get(id);
        return {
          fetch: async (r: Request) => {
            const body = (await r.clone().json()) as { op?: string };
            if (body.op === "refund") String(id).startsWith("voici-call-caller|") ? counted.caller++ : String(id).startsWith("voici-call-page|") ? counted.page++ : 0;
            return stub.fetch(r);
          },
        };
      },
    };
    const env = { DB: db, FLAGSHIP_CA_PRIV_HEX: K.caSeed, RATE_LIMITS: rl };
    await checkRateLimit(env, { endpoint: "voici-call-caller", ip: "1.2.3.4", subject: K.pseudonymPub });
    await checkRateLimit(env, { endpoint: "voici-call-page", ip: "1.2.3.4", subject: K.pageId });
    if (o.blocked) await new D1Storage(db).voici.setBlock({ pageId: K.pageId, pseudonymPub: K.pseudonymPub, op: "block", issuedAt: NOW, signature: "00" }, NOW);
    const state = roomState();
    const room = new VoiciCallRoom(state as never, env);
    const init: VoiciCallRoomInit = {
      callId: V.request.signed.callId,
      username: "alice",
      pageId: K.pageId,
      ownerSignPub: K.ownerSignPub,
      inboxPub: V.pageV2.signed.inboxPub,
      request: V.request.signed,
      callerPub: K.browserPub,
      callerTokenHash: "00".repeat(32),
      ringingAt: RANG,
      charged: { at: RANG, caller: K.pseudonymPub, page: K.pageId },
    };
    expect((await room.fetch(new Request("https://room/init", { method: "POST", body: JSON.stringify(init) }))).status).toBe(200);
    vi.setSystemTime(NOW);
    await room.webSocketMessage(device, JSON.stringify({ t: "answer", answer: V.answer.signed }));
    vi.setSystemTime(NOW + o.talkMs);
    await room.webSocketClose(device);
    return { counted, state, room, sqlite };
  }

  it("refunds the caller's and the page's ring after 15 s of talk", async () => {
    const w = await call({ talkMs: 15_000 });
    expect(w.counted).toEqual({ caller: 1, page: 1 });
    expect(w.state.data.get("refunded")).toBe(true);
    w.sqlite.close();
  });

  it("does not refund after 14 s", async () => {
    const w = await call({ talkMs: 14_000 });
    expect(w.counted).toEqual({ caller: 0, page: 0 });
    w.sqlite.close();
  });

  it("does not refund a caller blocked by the end", async () => {
    const w = await call({ talkMs: 30_000, blocked: true });
    expect(w.counted).toEqual({ caller: 0, page: 0 });
    w.sqlite.close();
  });

  it("refunds once, whatever ends the call again", async () => {
    const w = await call({ talkMs: 30_000 });
    await w.room.webSocketClose(device);
    const perform = (w.room as unknown as { perform(s: unknown, a: unknown[]): Promise<void> }).perform.bind(w.room);
    await perform(w.state.data.get("room"), [{ kind: "refund", charged: { at: RANG, caller: K.pseudonymPub, page: K.pageId } }]);
    expect(w.counted).toEqual({ caller: 1, page: 1 });
    w.sqlite.close();
  });
});
