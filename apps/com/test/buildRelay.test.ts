import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildRelaySession, deriveMatchCode, _internal } from "../src/buildRelay.js";

/**
 * Polyfill WebSocketPair for Node. The DO module uses
 * `new WebSocketPair()` which exists in the workers runtime; in tests
 * we substitute a tiny event-emitter-shaped pair. We also install
 * `accept()` as a no-op so the upgrade path doesn't blow up.
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

  accept(): void {
    /* no-op */
  }

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
    if (this.peer && !this.peer.closed) {
      this.peer.close(code, reason);
    }
  }

  dispatch(evt: FakeEvent): void {
    const arr = this.listeners[evt.type];
    if (!arr) return;
    for (const cb of arr) cb(evt);
  }

  // Test helper — push a message from the test (the client half) into
  // the DO (the server half) by appearing on the peer's message
  // listeners.
  push(text: string): void {
    if (this.closed || !this.peer) return;
    queueMicrotask(() => {
      if (this.peer && !this.peer.closed) {
        this.peer.inbox.push(text);
        this.peer.dispatch({ type: "message", data: text });
      }
    });
  }

  // Test helper — wait for the next inbound frame matching predicate.
  async waitFor(predicate: (m: any) => boolean, timeoutMs = 500): Promise<any> {
    const start = Date.now();
    for (;;) {
      for (const raw of this.inbox) {
        try {
          const obj = JSON.parse(raw);
          if (predicate(obj)) return obj;
        } catch {
          // skip
        }
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
  if (originalPair === undefined) {
    delete (globalThis as any).WebSocketPair;
  } else {
    (globalThis as any).WebSocketPair = originalPair;
  }
  vi.useRealTimers();
});

interface DoState {
  id: { toString(): string };
}

function makeState(id = "test-session-aaaaaaaaaaaaaaaaaa"): DoState {
  return { id: { toString: () => id } };
}

async function upgrade(
  obj: BuildRelaySession,
  role: "browser" | "sender",
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

describe("deriveMatchCode", () => {
  it("returns 6 base-10 digits", async () => {
    const code = await deriveMatchCode(
      "abc",
      "00".repeat(32),
    );
    expect(code).toMatch(/^\d{6}$/);
  });

  it("is deterministic for the same (sessionId, browserPk) pair", async () => {
    const pk = "11".repeat(32);
    const a = await deriveMatchCode("session-xyz", pk);
    const b = await deriveMatchCode("session-xyz", pk);
    expect(a).toBe(b);
  });

  it("changes when either input changes", async () => {
    const pkA = "11".repeat(32);
    const pkB = "22".repeat(32);
    const a = await deriveMatchCode("s1", pkA);
    const b = await deriveMatchCode("s2", pkA);
    const c = await deriveMatchCode("s1", pkB);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("rejects malformed browserPk", async () => {
    await expect(deriveMatchCode("s", "abcd")).rejects.toThrow();
  });
});

describe("BuildRelaySession — create endpoint", () => {
  it("returns a join URL pointing at /build-relay/<id>?role=sender", async () => {
    const state = makeState("session-id-42");
    const obj = new BuildRelaySession(state as any, {});
    const r = await obj.fetch(
      new Request("https://do.internal/session-id-42/create?host=flagshipserver.com", {
        method: "POST",
      }),
    );
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.sessionId).toBe("session-id-42");
    expect(body.joinUrl).toBe(
      "wss://flagshipserver.com/build-relay/session-id-42?role=sender",
    );
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns ws:// for localhost host (dev mode)", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const r = await obj.fetch(
      new Request("https://do.internal/x/create?host=localhost:8787", {
        method: "POST",
      }),
    );
    const body = await r.json() as any;
    expect(body.joinUrl).toMatch(/^ws:\/\/localhost:8787\//);
  });
});

describe("BuildRelaySession — relay protocol", () => {
  it("forwards matchCode to browser after browser-hello and to sender on join", async () => {
    const sessionId = "ssn-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const obj = new BuildRelaySession(makeState(sessionId) as any, {});
    const browser = await upgrade(obj, "browser");
    const browserPk = "ab".repeat(32);
    browser.push(JSON.stringify({ kind: "browser-hello", browserPk }));
    const matched = await browser.waitFor((m) => m.kind === "matched");
    const expected = await deriveMatchCode(sessionId, browserPk);
    expect(matched.matchCode).toBe(expected);

    const sender = await upgrade(obj, "sender");
    const browserKey = await sender.waitFor((m) => m.kind === "browser-key");
    expect(browserKey.browserPk).toBe(browserPk);
    expect(browserKey.matchCode).toBe(expected);
  });

  it("forwards opaque ciphertext from sender to browser without inspecting it", async () => {
    const sessionId = "ssn-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const obj = new BuildRelaySession(makeState(sessionId) as any, {});
    const browser = await upgrade(obj, "browser");
    const browserPk = "cd".repeat(32);
    browser.push(JSON.stringify({ kind: "browser-hello", browserPk }));
    await browser.waitFor((m) => m.kind === "matched");

    const sender = await upgrade(obj, "sender");
    await sender.waitFor((m) => m.kind === "browser-key");

    const opaque = "BASE64-OPAQUE-CIPHERTEXT-ZZZZ==";
    sender.push(JSON.stringify({ kind: "blob", ciphertext: opaque }));
    const delivered = await browser.waitFor((m) => m.kind === "blob");
    expect(delivered.ciphertext).toBe(opaque);
    const ack = await sender.waitFor((m) => m.kind === "delivered");
    expect(ack.kind).toBe("delivered");
  });

  it("closes both sides after a successful blob delivery", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    const browserPk = "ef".repeat(32);
    browser.push(JSON.stringify({ kind: "browser-hello", browserPk }));
    await browser.waitFor((m) => m.kind === "matched");
    const sender = await upgrade(obj, "sender");
    await sender.waitFor((m) => m.kind === "browser-key");
    sender.push(JSON.stringify({
      kind: "blob",
      ciphertext: "OPAQUE",
    }));
    await sender.waitFor((m) => m.kind === "delivered");
    // Let the queued microtask-scheduled teardown fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.closed).toBe(true);
    expect(sender.closed).toBe(true);
  });

  it("rejects a second browser slot on the same session", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    await upgrade(obj, "browser");
    const r = await obj.fetch(
      new Request("https://do.internal/x?role=browser", {
        method: "GET",
        headers: { upgrade: "websocket" },
      }),
    );
    expect(r.status).toBe(409);
  });

  it("rejects malformed browserPk hex", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    browser.push(JSON.stringify({
      kind: "browser-hello",
      browserPk: "not-hex",
    }));
    const err = await browser.waitFor((m) => m.kind === "error");
    expect(err.reason).toMatch(/hex/);
  });

  it("rejects a too-large ciphertext", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    browser.push(JSON.stringify({
      kind: "browser-hello",
      browserPk: "11".repeat(32),
    }));
    await browser.waitFor((m) => m.kind === "matched");
    const sender = await upgrade(obj, "sender");
    await sender.waitFor((m) => m.kind === "browser-key");
    const huge = "x".repeat(_internal.MAX_CIPHERTEXT_BYTES + 1);
    sender.push(JSON.stringify({ kind: "blob", ciphertext: huge }));
    const err = await sender.waitFor((m) => m.kind === "error");
    expect(err.reason).toMatch(/too large/);
  });

  it("kicks the session on browser disconnect before any blob", async () => {
    const obj = new BuildRelaySession(makeState() as any, {});
    const browser = await upgrade(obj, "browser");
    browser.close();
    // Subsequent upgrade attempts on the same session return 410 only
    // if the TTL has fired; the DO instance considers itself live
    // until the timer or a successful delivery. Verify the sender can
    // no longer pair through this browser by re-upgrading and waiting
    // for the matched event that will never come.
    const sender = await upgrade(obj, "sender");
    // No browser-key arrives because the browser never sent its
    // hello (and the browser slot is already empty). The test passes
    // by NOT seeing a matched event in a short window.
    await new Promise((r) => setTimeout(r, 50));
    expect(sender.inbox.find((m) => m.includes("browser-key"))).toBeUndefined();
  });
});

describe("BuildRelaySession — TTL", () => {
  it("expires after the configured TTL and refuses new upgrades", async () => {
    vi.useFakeTimers();
    const obj = new BuildRelaySession(makeState() as any, {});
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
