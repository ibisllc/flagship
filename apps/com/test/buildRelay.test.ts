import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildRelaySession, _internal } from "../src/buildRelay.js";

/**
 * QR relay v2 — tests for the DO. We exercise the WS-only protocol:
 * browser opens, gets accepted; phone opens and sends hello+deliver;
 * relay forwards both as peer-hello / peer-deliver to the browser.
 *
 * No POST endpoint, no server-side match code derivation.
 */

interface FakeEvent {
  type: string;
  data?: string | ArrayBuffer;
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

class FakeSocket {
  readonly listeners: Record<string, ((e: FakeEvent) => void)[]> = {};
  peer: FakeSocket | null = null;
  inbox: string[] = [];
  closed = false;

  addEventListener(type: string, cb: (e: FakeEvent) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: (e: FakeEvent) => void): void {
    const arr = this.listeners[type];
    if (!arr) return;
    const idx = arr.indexOf(cb);
    if (idx >= 0) arr.splice(idx, 1);
  }
  accept(): void { /* no-op */ }

  send(data: string): void {
    if (this.closed) return;
    if (!this.peer) return;
    queueMicrotask(() => {
      if (this.peer && !this.peer.closed) {
        this.peer.inbox.push(data);
        this.peer.dispatch({ type: "message", data });
      }
    });
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatch({ type: "close", code, reason, wasClean: true });
    if (this.peer && !this.peer.closed) this.peer.close(code, reason);
  }
  dispatch(evt: FakeEvent): void {
    const arr = this.listeners[evt.type];
    if (!arr) return;
    for (const cb of arr) cb(evt);
  }
  push(text: string): void {
    if (this.closed || !this.peer) return;
    queueMicrotask(() => {
      if (this.peer && !this.peer.closed) {
        this.peer.inbox.push(text);
        this.peer.dispatch({ type: "message", data: text });
      }
    });
  }
  async waitFor(predicate: (m: any) => boolean, timeoutMs = 500): Promise<any> {
    const start = Date.now();
    for (;;) {
      for (const raw of this.inbox) {
        try {
          const obj = JSON.parse(raw);
          if (predicate(obj)) return obj;
        } catch { /* skip */ }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitFor timeout; inbox = ${JSON.stringify(this.inbox)}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

class FakeWebSocketPair {
  0: FakeSocket;
  1: FakeSocket;
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

const originalPair = (globalThis as any).WebSocketPair;

beforeEach(() => {
  (globalThis as any).WebSocketPair = FakeWebSocketPair;
});
afterEach(() => {
  if (originalPair === undefined) delete (globalThis as any).WebSocketPair;
  else (globalThis as any).WebSocketPair = originalPair;
  vi.useRealTimers();
});

/**
 * In-memory `storage` stub matching the slice of DurableObjectStorage
 * the DO relies on (see BuildRelayStorage in src/buildRelay.ts).
 *
 * Tracks alarms as plain timestamps; tests assert on `_state.alarm`
 * to verify the DO armed (and later cleared) its TTL alarm correctly.
 */
function makeStorage() {
  const kv = new Map<string, unknown>();
  let alarmAt: number | null = null;
  return {
    async get<T>(k: string): Promise<T | undefined> { return kv.get(k) as T | undefined; },
    async put(k: string, v: unknown): Promise<void> { kv.set(k, v); },
    async deleteAll(): Promise<void> { kv.clear(); alarmAt = null; },
    async setAlarm(t: number | Date): Promise<void> {
      alarmAt = typeof t === "number" ? t : t.getTime();
    },
    async getAlarm(): Promise<number | null> { return alarmAt; },
    async deleteAlarm(): Promise<void> { alarmAt = null; },
    /** Test-only escape hatch. */
    _state: { kv, get alarm() { return alarmAt; } },
  };
}
type TestStorage = ReturnType<typeof makeStorage>;

interface DoState {
  id: { toString(): string };
  storage: TestStorage;
}
function makeState(id = "test-session-aaaaaaaaaaaaaaaa"): DoState {
  return { id: { toString: () => id }, storage: makeStorage() };
}

async function upgrade(
  obj: BuildRelaySession,
  role: "browser" | "phone",
): Promise<FakeSocket> {
  const req = new Request(`https://do.internal/test?role=${role}`, {
    method: "GET",
    headers: { upgrade: "websocket" },
  });
  const resp = (await obj.fetch(req)) as Response & { webSocket?: FakeSocket };
  if (resp.status !== 101) {
    throw new Error(`upgrade failed: ${resp.status} ${await resp.text()}`);
  }
  return (resp as any).webSocket as FakeSocket;
}

// ───────────────────────────────────────────────────────────────────

describe("QR relay v2 — handshake", () => {
  it("sends {accepted} when the browser upgrades on a free session", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    const accepted = await browser.waitFor((m) => m.kind === "accepted");
    expect(accepted.kind).toBe("accepted");
  });

  it("forwards a phone hello as peer-hello to the browser, and acks the phone", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");

    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "QUJD" })); // "ABC" b64url

    const peer = await browser.waitFor((m) => m.kind === "peer-hello");
    expect(peer.phonePk).toBe("QUJD");
    const ack = await phone.waitFor((m) => m.kind === "ack");
    expect(ack.kind).toBe("ack");
  });

  it("forwards opaque ciphertext as peer-deliver, sends {delivered} to phone, tears both down", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "QUJD" }));
    await browser.waitFor((m) => m.kind === "peer-hello");
    await phone.waitFor((m) => m.kind === "ack");

    const opaque = "T1BBUVVF"; // "OPAQUE" b64url
    const nonce  = "Tk9OQ0U";  // "NONCE"  b64url
    phone.push(JSON.stringify({ kind: "deliver", ciphertext: opaque, nonce }));

    const delivered = await browser.waitFor((m) => m.kind === "peer-deliver");
    expect(delivered.ciphertext).toBe(opaque);
    expect(delivered.nonce).toBe(nonce);

    const ack = await phone.waitFor((m) => m.kind === "delivered");
    expect(ack.kind).toBe("delivered");

    await new Promise((r) => setTimeout(r, 10));
    expect(browser.closed).toBe(true);
    expect(phone.closed).toBe(true);
  });
});

describe("QR relay v2 — arbitration", () => {
  it("rebinds a second browser claiming the same sid (slot taken)", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    await upgrade(obj, "browser");
    const second = await upgrade(obj, "browser");
    const rebind = await second.waitFor((m) => m.kind === "rebind");
    expect(rebind.kind).toBe("rebind");
    await new Promise((r) => setTimeout(r, 10));
    expect(second.closed).toBe(true);
  });

  it("rebinds any browser upgrade after the session is consumed", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "QUJD" }));
    await phone.waitFor((m) => m.kind === "ack");
    phone.push(JSON.stringify({ kind: "deliver", ciphertext: "T1BBUVVF", nonce: "Tk9OQ0U" }));
    await phone.waitFor((m) => m.kind === "delivered");
    await new Promise((r) => setTimeout(r, 10));

    // The original browser slot is now consumed. Any future browser
    // upgrade on this DO gets rebound.
    const fresh = await upgrade(obj, "browser");
    const rebind = await fresh.waitFor((m) => m.kind === "rebind");
    expect(rebind.kind).toBe("rebind");
  });

  it("tells the phone peer-missing when there's no browser registered", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "QUJD" }));
    const m = await phone.waitFor((x) => x.kind === "peer-missing");
    expect(m.kind).toBe("peer-missing");
  });
});

describe("QR relay v2 — validation", () => {
  it("rejects malformed phonePk", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "not base64url!@#" }));
    const err = await phone.waitFor((m) => m.kind === "error");
    expect(err.reason).toMatch(/phonePk/);
  });

  it("rejects ciphertext over the size cap", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "QUJD" }));
    await phone.waitFor((m) => m.kind === "ack");
    const huge = "A".repeat(_internal.MAX_CIPHERTEXT_BYTES + 1);
    phone.push(JSON.stringify({ kind: "deliver", ciphertext: huge, nonce: "Tk9OQ0U" }));
    const err = await phone.waitFor((m) => m.kind === "error");
    expect(err.reason).toMatch(/too large/);
  });

  it("rejects an unknown message kind from the phone", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "whatever", other: 1 }));
    const err = await phone.waitFor((m) => m.kind === "error");
    expect(err.reason).toMatch(/malformed|unknown/);
  });
});

describe("QR relay v2 — TTL", () => {
  it("refuses upgrades after the configured TTL", async () => {
    vi.useFakeTimers();
    const obj = new BuildRelaySession(makeState() as any, {});
    // Let loadOrInit run to completion before we advance time so it
    // captures the real `createdAt`. Otherwise the awaited storage
    // writes never settle under fake timers.
    await Promise.resolve();
    vi.advanceTimersByTime(_internal.SESSION_TTL_MS + 1_000);
    const r = await obj.fetch(
      new Request("https://do.internal/x?role=browser", {
        method: "GET",
        headers: { upgrade: "websocket" },
      }),
    );
    expect(r.status).toBe(410);
  });
});

describe("QR relay v2 — alarm-based TTL (P1.1: no setTimeout pinning)", () => {
  /**
   * The DO MUST NOT use setTimeout in its constructor to schedule the
   * TTL. setTimeout keeps the DO resident in memory for the full
   * 5-minute window — that's the bug that burned the free-tier
   * duration budget. The fix uses state.storage.setAlarm, which
   * persists the wake-up time and lets the DO be evicted in between.
   */
  it("arms a storage alarm on first construction, not a setTimeout", async () => {
    const state = makeState();
    const before = Date.now();
    const obj = new BuildRelaySession(state as any, {});
    // Block until loadOrInit settles.
    await obj.fetch(new Request("https://do.internal/x"));
    const alarm = state.storage._state.alarm;
    expect(alarm).not.toBeNull();
    // Alarm should be ~SESSION_TTL_MS in the future from construction.
    expect(alarm!).toBeGreaterThanOrEqual(before + _internal.SESSION_TTL_MS - 1_000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + _internal.SESSION_TTL_MS + 1_000);
  });

  it("persists createdAt so a hibernated/reconstructed DO honours the same TTL", async () => {
    const state = makeState();
    const obj1 = new BuildRelaySession(state as any, {});
    // Force initial setup.
    await obj1.fetch(new Request("https://do.internal/x"));
    const firstCreatedAt = state.storage._state.kv.get("createdAt");
    expect(typeof firstCreatedAt).toBe("number");

    // Simulate hibernation: a brand-new DO instance backed by the
    // same storage. createdAt must be preserved.
    const obj2 = new BuildRelaySession(state as any, {});
    await obj2.fetch(new Request("https://do.internal/x"));
    expect(state.storage._state.kv.get("createdAt")).toBe(firstCreatedAt);
  });

  it("alarm() notifies any open sockets with {expired} and wipes storage", async () => {
    const state = makeState();
    const obj = new BuildRelaySession(state as any, {});
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    expect(state.storage._state.kv.size).toBeGreaterThan(0);

    await obj.alarm();
    const expired = await browser.waitFor((m) => m.kind === "expired");
    expect(expired.kind).toBe("expired");
    expect(state.storage._state.kv.size).toBe(0);
    expect(state.storage._state.alarm).toBeNull();
  });

  it("delivery tears down + wipes storage (no resident state after consumption)", async () => {
    const state = makeState();
    const obj = new BuildRelaySession(state as any, {});
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "QUJD" }));
    await phone.waitFor((m) => m.kind === "ack");
    phone.push(JSON.stringify({ kind: "deliver", ciphertext: "T1BBUVVF", nonce: "Tk9OQ0U" }));
    await phone.waitFor((m) => m.kind === "delivered");
    // Tear-down queued via microtask + an async deleteAll — wait for both.
    await new Promise((r) => setTimeout(r, 20));
    expect(state.storage._state.kv.size).toBe(0);
    expect(state.storage._state.alarm).toBeNull();
  });
});
