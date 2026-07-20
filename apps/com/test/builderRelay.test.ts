import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderRelaySession, _internal } from "../src/builderRelay.js";

/**
 * Builder relay — tests for the phone↔desktop-builder live-session DO.
 * Unlike the QR relay (one-shot deliver-once), this is a long-lived
 * bidirectional pipe: either peer may send app frames, presence is
 * surfaced (peer-joined / peer-gone), and keepalive pings re-arm an
 * idle TTL alarm. The relay stays a dumb pipe — it never inspects the
 * forwarded app frames beyond a size cap.
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
  /** Push a frame from the client side into the DO (server side). */
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
  /** Assert a frame matching the predicate did NOT arrive within the window. */
  async expectNone(predicate: (m: any) => boolean, windowMs = 60): Promise<void> {
    await new Promise((r) => setTimeout(r, windowMs));
    for (const raw of this.inbox) {
      try {
        if (predicate(JSON.parse(raw))) {
          throw new Error(`unexpected frame: ${raw}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("unexpected")) throw e;
      }
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
    _state: { kv, get alarm() { return alarmAt; } },
  };
}

function makeState(id = "builder-session-aaaaaaaaaaaaaaaa") {
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
    _bindDo(d: BuilderRelaySession): void { doRef = d; },
    _attached: attached,
  };
}
type TestState = ReturnType<typeof makeState>;

function makeBound(id?: string): { state: TestState; obj: BuilderRelaySession } {
  const state = makeState(id);
  const obj = new BuilderRelaySession(state as any, {});
  state._bindDo(obj);
  return { state, obj };
}

async function upgrade(
  obj: BuilderRelaySession,
  role: "builder" | "phone",
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

describe("builder relay — join + presence", () => {
  it("accepts a builder upgrade on a free session", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    const accepted = await builder.waitFor((m) => m.kind === "accepted");
    expect(accepted.role).toBe("builder");
    // The session deadline rides the accepted frame so both sides can show
    // a matching auto-lock countdown.
    expect(typeof accepted.expiresAt).toBe("number");
    expect(accepted.expiresAt).toBeGreaterThan(Date.now());
  });

  it("tells both sides about presence when the phone joins after the builder", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");

    const phone = await upgrade(obj, "phone");
    // Newcomer learns the builder is already present.
    const present = await phone.waitFor((m) => m.kind === "peer-present");
    expect(present.kind).toBe("peer-present");
    // The existing builder is told the phone joined.
    const joined = await builder.waitFor((m) => m.kind === "peer-joined");
    expect(joined.kind).toBe("peer-joined");
  });

  it("evicts a stale socket and lets the same role reconnect (resume)", async () => {
    const { obj } = makeBound();
    const first = await upgrade(obj, "builder");
    await first.waitFor((m) => m.kind === "accepted");
    // A reconnect for the same role: the stale socket is evicted and the
    // newcomer is accepted (last-writer-wins), NOT told "slot taken".
    const second = await upgrade(obj, "builder");
    const accepted = await second.waitFor((m) => m.kind === "accepted");
    expect(accepted.role).toBe("builder");
    await new Promise((r) => setTimeout(r, 10));
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it("a phone reconnect does NOT fire a spurious peer-gone at the builder", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    const phone1 = await upgrade(obj, "phone");
    await phone1.waitFor((m) => m.kind === "peer-present");
    await builder.waitFor((m) => m.kind === "peer-joined");

    // Phone reconnects (its old socket is still draining) — the builder must
    // be told the peer (re)joined, and must NOT be told peer-gone.
    const phone2 = await upgrade(obj, "phone");
    await phone2.waitFor((m) => m.kind === "accepted");
    await builder.waitFor((m) => m.kind === "peer-joined");
    await builder.expectNone((m) => m.kind === "peer-gone");
    expect(phone1.closed).toBe(true);
  });
});

describe("builder relay — bidirectional forwarding", () => {
  it("forwards a builder app frame to the phone wrapped as {kind:peer,frame}", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    await phone.waitFor((m) => m.kind === "peer-present");

    builder.push(JSON.stringify({ kind: "builder-hello", builderPk: "QUJD" }));
    const fwd = await phone.waitFor((m) => m.kind === "peer");
    expect(fwd.frame).toEqual({ kind: "builder-hello", builderPk: "QUJD" });
  });

  it("forwards a phone app frame to the builder (the reverse direction)", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    await phone.waitFor((m) => m.kind === "peer-present");

    phone.push(JSON.stringify({ kind: "deliver", ciphertext: "T1BB", nonce: "Tk9O" }));
    const fwd = await builder.waitFor((m) => m.kind === "peer");
    expect(fwd.frame.kind).toBe("deliver");
    expect(fwd.frame.ciphertext).toBe("T1BB");
  });

  it("tells a sender peer-missing when no peer is connected", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    builder.push(JSON.stringify({ kind: "builder-hello", builderPk: "QUJD" }));
    const m = await builder.waitFor((x) => x.kind === "peer-missing");
    expect(m.kind).toBe("peer-missing");
  });

  it("does not forward relay control frames as peer frames (ping is handled, not relayed)", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    await phone.waitFor((m) => m.kind === "peer-present");

    builder.push(JSON.stringify({ kind: "ping" }));
    const pong = await builder.waitFor((m) => m.kind === "pong");
    expect(pong.kind).toBe("pong");
    // The phone must NOT receive a forwarded ping.
    await phone.expectNone((m) => m.kind === "peer" && m.frame?.kind === "ping");
  });
});

describe("builder relay — keepalive", () => {
  it("replies pong to a ping", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    builder.push(JSON.stringify({ kind: "ping" }));
    const pong = await builder.waitFor((m) => m.kind === "pong");
    expect(pong.kind).toBe("pong");
  });

  it("re-arms the idle alarm on a ping (keepalive pushes TTL forward)", async () => {
    const { state, obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    const before = state.storage._state.alarm;
    await new Promise((r) => setTimeout(r, 5));
    await obj.webSocketMessage(
      state._attached[0]!.ws as unknown as WebSocket,
      JSON.stringify({ kind: "ping" }),
    );
    const after = state.storage._state.alarm;
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThanOrEqual(before!);
  });
});

describe("builder relay — presence loss → re-lock", () => {
  it("tells the survivor peer-gone when the other side closes", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    await phone.waitFor((m) => m.kind === "peer-present");

    phone.close(1000, "phone gone");
    const gone = await builder.waitFor((m) => m.kind === "peer-gone");
    expect(gone.kind).toBe("peer-gone");
  });

  it("eagerly wipes storage when both peers have left", async () => {
    const { state, obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    const phone = await upgrade(obj, "phone");
    await phone.waitFor((m) => m.kind === "peer-present");
    expect(state.storage._state.kv.size).toBeGreaterThan(0);

    phone.close(1000, "x");
    await builder.waitFor((m) => m.kind === "peer-gone");
    expect(state.storage._state.kv.size).toBeGreaterThan(0); // builder still here
    builder.close(1000, "x");
    await new Promise((r) => setTimeout(r, 10));
    expect(state.storage._state.kv.size).toBe(0);
    expect(state.storage._state.alarm).toBeNull();
  });
});

describe("builder relay — validation", () => {
  it("errors on a malformed (non-JSON) frame", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    builder.push("not json");
    const err = await builder.waitFor((m) => m.kind === "error");
    expect(err.reason).toMatch(/malformed/);
  });

  it("errors on a frame over the size cap", async () => {
    const { obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    const huge = "A".repeat(_internal.MAX_FRAME_BYTES + 1);
    builder.push(JSON.stringify({ kind: "deliver", blob: huge }));
    const err = await builder.waitFor((m) => m.kind === "error");
    expect(err.reason).toMatch(/too large/);
  });

  it("rejects an upgrade with a bad role", async () => {
    const { obj } = makeBound();
    const resp = await obj.fetch(new Request("https://do.internal/x?role=hacker", {
      method: "GET",
      headers: { upgrade: "websocket" },
    }));
    expect(resp.status).toBe(400);
  });
});

describe("builder relay — TTL + hibernation", () => {
  it("arms a storage alarm on first construction (no setTimeout pinning)", async () => {
    const before = Date.now();
    const { state, obj } = makeBound();
    await obj.fetch(new Request("https://do.internal/x"));
    const alarm = state.storage._state.alarm;
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(before + _internal.IDLE_TTL_MS - 1_000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + _internal.IDLE_TTL_MS + 1_000);
  });

  it("persists createdAt so a reconstructed (hibernated) DO honours the same lifetime", async () => {
    const { state, obj: obj1 } = makeBound();
    await obj1.fetch(new Request("https://do.internal/x"));
    const first = state.storage._state.kv.get("createdAt");
    expect(typeof first).toBe("number");
    const obj2 = new BuilderRelaySession(state as any, {});
    state._bindDo(obj2);
    await obj2.fetch(new Request("https://do.internal/x"));
    expect(state.storage._state.kv.get("createdAt")).toBe(first);
  });

  it("refuses upgrades after the absolute TTL", async () => {
    vi.useFakeTimers();
    const { obj } = makeBound();
    await Promise.resolve();
    vi.advanceTimersByTime(_internal.ABSOLUTE_TTL_MS + 1_000);
    const r = await obj.fetch(new Request("https://do.internal/x?role=builder", {
      method: "GET",
      headers: { upgrade: "websocket" },
    }));
    expect(r.status).toBe(410);
  });

  it("alarm() notifies open sockets with {expired} and wipes storage", async () => {
    const { state, obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    await obj.alarm();
    const expired = await builder.waitFor((m) => m.kind === "expired");
    expect(expired.kind).toBe("expired");
    expect(state.storage._state.kv.size).toBe(0);
    expect(state.storage._state.alarm).toBeNull();
  });

  it("accepts sockets via state.acceptWebSocket with a role tag (hibernation API)", async () => {
    const { state, obj } = makeBound();
    const builder = await upgrade(obj, "builder");
    await builder.waitFor((m) => m.kind === "accepted");
    expect(state._attached).toHaveLength(1);
    expect(state._attached[0]!.tags).toContain("builder");
    expect((state._attached[0]!.ws as FakeSocket).deserializeAttachment()).toEqual({ role: "builder" });
  });

  it("source: uses the hibernation API, not legacy ws.accept()", async () => {
    const fs = await import("fs/promises");
    const url = new URL("../src/builderRelay.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");
    expect(src).toContain("state.acceptWebSocket");
    expect(src).toContain("webSocketMessage");
    expect(src).toContain("webSocketClose");
  });
});
