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
  /** Attachment surface used by the Hibernation API. */
  private attachment: unknown = undefined;

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
  serializeAttachment(value: unknown): void {
    this.attachment = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  deserializeAttachment(): unknown { return this.attachment; }

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

/**
 * State stub that mirrors the slice of `DurableObjectState` used by
 * the Hibernation-aware DO. acceptWebSocket records the socket + tag
 * and wires the FakeSocket's events to the DO's class-level handlers
 * (`webSocketMessage` / `webSocketClose` / `webSocketError`) — that
 * dispatch is what Workerd does for real, but we have to do it
 * manually in the harness. The DO is bound via `_bindDo` immediately
 * after construction.
 */
function makeState(id = "test-session-aaaaaaaaaaaaaaaa") {
  const storage = makeStorage();
  let doRef: any = null;
  const attached: { ws: FakeSocket; tags: string[]; closed: boolean }[] = [];
  return {
    id: { toString: () => id },
    storage,
    acceptWebSocket(ws: FakeSocket, tags?: string[]): void {
      const entry = { ws, tags: tags ?? [], closed: false };
      attached.push(entry);
      ws.addEventListener("message", (e) => {
        if (!doRef || entry.closed) return;
        void doRef.webSocketMessage(ws as unknown as WebSocket, e.data as string);
      });
      ws.addEventListener("close", (e) => {
        if (!doRef || entry.closed) return;
        entry.closed = true;
        void doRef.webSocketClose(
          ws as unknown as WebSocket,
          e.code ?? 1000,
          e.reason ?? "",
          e.wasClean ?? true,
        );
      });
      ws.addEventListener("error", () => {
        if (!doRef || entry.closed) return;
        entry.closed = true;
        void doRef.webSocketError(ws as unknown as WebSocket, new Error("ws error"));
      });
    },
    getWebSockets(tag?: string): FakeSocket[] {
      const live = attached.filter((a) => !a.closed && !a.ws.closed);
      if (tag === undefined) return live.map((a) => a.ws);
      return live.filter((a) => a.tags.includes(tag)).map((a) => a.ws);
    },
    /** Test-only — bind the DO after construction so acceptWebSocket can dispatch to it. */
    _bindDo(d: BuildRelaySession): void { doRef = d; },
    /** Test-only — current attachment table. */
    _attached: attached,
  };
}
type TestState = ReturnType<typeof makeState>;

function makeBound(id?: string): { state: TestState; obj: BuildRelaySession } {
  const state = makeState(id);
  const obj = new BuildRelaySession(state as any, {});
  state._bindDo(obj);
  return { state, obj };
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
    const { obj } = makeBound();
    const browser = await upgrade(obj, "browser");
    const accepted = await browser.waitFor((m) => m.kind === "accepted");
    expect(accepted.kind).toBe("accepted");
  });

  it("forwards a phone hello as peer-hello to the browser, and acks the phone", async () => {
    const { obj } = makeBound();
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
    const { obj } = makeBound();
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
    const { obj } = makeBound();
    await upgrade(obj, "browser");
    const second = await upgrade(obj, "browser");
    const rebind = await second.waitFor((m) => m.kind === "rebind");
    expect(rebind.kind).toBe("rebind");
    await new Promise((r) => setTimeout(r, 10));
    expect(second.closed).toBe(true);
  });

  it("rebinds any browser upgrade after the session is consumed", async () => {
    const { obj } = makeBound();
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
    const { obj } = makeBound();
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "QUJD" }));
    const m = await phone.waitFor((x) => x.kind === "peer-missing");
    expect(m.kind).toBe("peer-missing");
  });
});

describe("QR relay v2 — validation", () => {
  it("rejects malformed phonePk", async () => {
    const { obj } = makeBound();
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    phone.push(JSON.stringify({ kind: "hello", phonePk: "not base64url!@#" }));
    const err = await phone.waitFor((m) => m.kind === "error");
    expect(err.reason).toMatch(/phonePk/);
  });

  it("rejects ciphertext over the size cap", async () => {
    const { obj } = makeBound();
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
    const { obj } = makeBound();
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
    const { obj } = makeBound();
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
    const before = Date.now();
    const { state, obj } = makeBound();
    // Block until loadOrInit settles.
    await obj.fetch(new Request("https://do.internal/x"));
    const alarm = state.storage._state.alarm;
    expect(alarm).not.toBeNull();
    // Alarm should be ~SESSION_TTL_MS in the future from construction.
    expect(alarm!).toBeGreaterThanOrEqual(before + _internal.SESSION_TTL_MS - 1_000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + _internal.SESSION_TTL_MS + 1_000);
  });

  it("persists createdAt so a hibernated/reconstructed DO honours the same TTL", async () => {
    const { state, obj: obj1 } = makeBound();
    // Force initial setup.
    await obj1.fetch(new Request("https://do.internal/x"));
    const firstCreatedAt = state.storage._state.kv.get("createdAt");
    expect(typeof firstCreatedAt).toBe("number");

    // Simulate hibernation: a brand-new DO instance backed by the
    // same storage. createdAt must be preserved.
    const obj2 = new BuildRelaySession(state as any, {});
    state._bindDo(obj2);
    await obj2.fetch(new Request("https://do.internal/x"));
    expect(state.storage._state.kv.get("createdAt")).toBe(firstCreatedAt);
  });

  it("alarm() notifies any open sockets with {expired} and wipes storage", async () => {
    const { state, obj } = makeBound();
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
    const { state, obj } = makeBound();
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

describe("QR relay v2 — WebSocket Hibernation (P1.2)", () => {
  /**
   * The DO must use state.acceptWebSocket(ws, [role]) — NOT
   * ws.accept() + addEventListener — so the Workerd runtime can evict
   * the DO from memory while WebSockets are idle. Without this, every
   * open connection is billed for wallclock duration regardless of
   * whether any frames are flowing.
   */
  it("registers accepted sockets with state.acceptWebSocket and a role tag", async () => {
    const { state, obj } = makeBound();
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    expect(state._attached).toHaveLength(1);
    expect(state._attached[0]!.tags).toContain("browser");

    const phone = await upgrade(obj, "phone");
    // Probe message so we know the test harness wired phone's events.
    phone.push(JSON.stringify({ kind: "hello", phonePk: "QUJD" }));
    await browser.waitFor((m) => m.kind === "peer-hello");
    expect(state._attached).toHaveLength(2);
    expect(state._attached[1]!.tags).toContain("phone");
  });

  it("dispatches phone frames via webSocketMessage (Hibernation API)", async () => {
    // The class-level handler must be wired — direct addEventListener
    // on the WS would pin the DO to memory and skip the runtime's
    // hibernation lifecycle. We confirm by calling webSocketMessage
    // directly and asserting peer-hello is forwarded.
    const { state, obj } = makeBound();
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    const phoneServer = state._attached[1]!.ws;
    await obj.webSocketMessage(
      phoneServer as unknown as WebSocket,
      JSON.stringify({ kind: "hello", phonePk: "QUJD" }),
    );
    const peer = await browser.waitFor((m) => m.kind === "peer-hello");
    expect(peer.phonePk).toBe("QUJD");
    expect(phone.closed).toBe(false);
  });

  it("persists each socket's role via serializeAttachment for wake-from-hibernation", async () => {
    const { state, obj } = makeBound();
    await upgrade(obj, "browser");
    await upgrade(obj, "phone");
    expect(state._attached).toHaveLength(2);
    const [b, p] = state._attached;
    expect((b!.ws as FakeSocket).deserializeAttachment()).toEqual({ role: "browser" });
    expect((p!.ws as FakeSocket).deserializeAttachment()).toEqual({ role: "phone" });
  });

  it("looks up live sockets via state.getWebSockets (no in-memory cache)", async () => {
    // Source-level guarantee: the DO must not rely on member-variable
    // socket caches that wouldn't survive hibernation. We check by
    // peeking at state.getWebSockets after attaching, plus verifying
    // detachBrowser still finds the phone via the runtime list.
    const { state, obj } = makeBound();
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");

    expect(state.getWebSockets("browser")).toHaveLength(1);
    expect(state.getWebSockets("phone")).toHaveLength(1);
    expect(state.getWebSockets()).toHaveLength(2);

    // Browser drops; phone-side close handler must find phone via
    // state.getWebSockets and tell it peer-missing.
    browser.close(1000, "test");
    const missing = await phone.waitFor((m) => m.kind === "peer-missing");
    expect(missing.kind).toBe("peer-missing");
    // Browser is no longer live.
    expect(state.getWebSockets("browser")).toHaveLength(0);
  });

  it("webSocketClose detaches the right role (browser → peer-missing to phone)", async () => {
    const { state, obj } = makeBound();
    const browser = await upgrade(obj, "browser");
    await browser.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");

    // Simulate the runtime invoking webSocketClose directly (instead of
    // the FakeSocket dispatch we already exercise) — both paths must
    // reach the same detach logic.
    const browserServer = state._attached[0]!.ws;
    (browserServer as FakeSocket).closed = true;
    state._attached[0]!.closed = true;
    await obj.webSocketClose(browserServer as unknown as WebSocket, 1000, "test", true);
    const missing = await phone.waitFor((m) => m.kind === "peer-missing");
    expect(missing.kind).toBe("peer-missing");
  });

  it("source: uses state.acceptWebSocket, not the legacy ws.accept() path", async () => {
    // A regression guard. If anyone reverts to (server).accept(), the
    // file ships with a non-hibernation DO and the duration bug returns.
    const fs = await import("fs/promises");
    const url = new URL("../src/buildRelay.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");
    expect(src).toContain("state.acceptWebSocket");
    expect(src).toContain("webSocketMessage");
    expect(src).toContain("webSocketClose");
    expect(src).not.toMatch(/\b\(server as unknown as \{ accept\(\): void \}\)\.accept\(\)/);
  });
});
