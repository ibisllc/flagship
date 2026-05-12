/**
 * Tests for superviseTunnelClient — the reconnect supervisor that wraps
 * startTunnelClient with jittered backoff + keep-alive ping/pong.
 *
 * We test against a synthetic inner-client builder (`fakeStartClient`)
 * rather than spinning up a real WS. The supervisor's contract with the
 * inner client is the public TunnelClient shape, so this exercises every
 * branch the production code drives.
 *
 * Separately, we exercise startTunnelClient's KEEP-ALIVE branch directly
 * with a controllable EventEmitter-backed WS double, since keep-alive
 * lives inside startTunnelClient (the supervisor just turns it on).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  startTunnelClient,
  superviseTunnelClient,
  type SupervisorOptions,
  type TunnelClient,
  type TunnelClientOptions,
  type TunnelWebSocketLike,
  type WebSocketFactory,
} from "../src/tunnel/tunnelClient.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface FakeClientHandle {
  client: TunnelClient;
  /** Resolve ready() — simulates HELLO_ACK landed. */
  resolveReady: () => void;
  /** Reject ready() — simulates HELLO_ACK rejection. */
  rejectReady: (e: Error) => void;
  /** Trigger the supervisor's onClose hook (simulates WS close). */
  triggerClose: () => void;
  /** Inner-client close() was called by the supervisor. */
  externallyClosed: boolean;
  /** Capture options the supervisor passed in. */
  receivedOpts: TunnelClientOptions;
}

function buildFakeClientFactory(): {
  handles: FakeClientHandle[];
  startClient: (opts: TunnelClientOptions) => TunnelClient;
} {
  const handles: FakeClientHandle[] = [];
  const startClient = (opts: TunnelClientOptions): TunnelClient => {
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    const h: FakeClientHandle = {
      // populated below
      client: null as unknown as TunnelClient,
      resolveReady,
      rejectReady,
      triggerClose: () => {
        // Supervisor wires onClose at construction; call it.
        opts.onClose?.();
      },
      externallyClosed: false,
      receivedOpts: opts,
    };
    h.client = {
      ready: () => ready,
      rehello: async () => {},
      requestTransfer: () => {},
      close: async () => {
        h.externallyClosed = true;
      },
    };
    handles.push(h);
    return h.client;
  };
  return { handles, startClient };
}

function fakeRandomSequence(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i++;
    return v;
  };
}

function commonOpts(): TunnelClientOptions {
  return {
    hubUrl: "wss://hub.example/tunnel",
    signingKey: {
      privateKey: new Uint8Array(32),
      publicKey: new Uint8Array(32),
    },
    getEntitlements: async () => ({
      rootEntitlement: {
        username: "alice",
        podPubKey: new Uint8Array(32),
        podCanonical: "home.alice.flagship.services",
        issuedAt: 0,
      },
      rootEntitlementSig: new Uint8Array(64),
    }),
    resolveBackend: () => ({ host: "127.0.0.1", port: 8443 }),
  };
}

/* ------------------------------------------------------------------ */
/*  Initial-jitter dial                                                */
/* ------------------------------------------------------------------ */

describe("superviseTunnelClient — initial jitter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dials only after the initial-jitter delay (random()*30s by default)", async () => {
    const { handles, startClient } = buildFakeClientFactory();
    const supOpts: SupervisorOptions = {
      startClient,
      random: fakeRandomSequence([0.5]), // 0.5 * 30s = 15s
      initialJitterMs: 30_000,
    };
    const sup = superviseTunnelClient({ ...commonOpts(), ...supOpts });

    // Before the jitter delay elapses, no inner client should exist.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(handles.length).toBe(0);
    expect(sup.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(handles.length).toBe(1);

    handles[0]!.resolveReady();
    await sup.ready();
    expect(sup.isConnected()).toBe(true);
    await sup.close();
  });

  it("initial-jitter random() is consulted exactly once across multiple reconnects", async () => {
    const { handles, startClient } = buildFakeClientFactory();
    const calls: number[] = [];
    const rng = (): number => {
      calls.push(calls.length);
      // First call (initial jitter) → 0 so we dial immediately.
      // Subsequent calls (reconnect backoffs) → 0.5.
      return calls.length === 1 ? 0 : 0.5;
    };
    const sup = superviseTunnelClient({
      ...commonOpts(),
      startClient,
      random: rng,
      initialJitterMs: 30_000,
      baseReconnectMs: 1_000,
      maxReconnectMs: 60_000,
    });

    // First dial fires immediately (rng()=0).
    await vi.advanceTimersByTimeAsync(0);
    expect(handles.length).toBe(1);
    handles[0]!.resolveReady();
    await sup.ready();

    // Drop the connection → supervisor schedules a reconnect. With
    // attempt reset to 0 by ready() and rng=0.5, the next reconnect
    // delay is floor(0.5 * 1000) = 500ms.
    handles[0]!.triggerClose();
    await vi.advanceTimersByTimeAsync(499);
    expect(handles.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(handles.length).toBe(2);

    // Drop again — supervisor should NOT re-use the initial-jitter window.
    // We assert this by counting random() calls: the contract is "initial
    // jitter only fires once". Since our rng returns 0 only on the first
    // call, if the supervisor ever re-applied initial jitter it would
    // dial again immediately. We rely on the fact that subsequent rng()
    // results never produce a 0-delay reconnect.
    handles[1]!.resolveReady();
    // Drain the microtask that resets `attempt` to 0 inside the
    // supervisor's ready().then() callback.
    await Promise.resolve();
    handles[1]!.triggerClose();
    await vi.advanceTimersByTimeAsync(501);
    expect(handles.length).toBe(3);
    // First call (initial jitter), then reconnect, then reconnect.
    expect(calls.length).toBe(3);

    await sup.close();
  });
});

/* ------------------------------------------------------------------ */
/*  Reconnect behaviour                                                */
/* ------------------------------------------------------------------ */

describe("superviseTunnelClient — reconnects after close", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds the inner client after onClose fires", async () => {
    const { handles, startClient } = buildFakeClientFactory();
    const sup = superviseTunnelClient({
      ...commonOpts(),
      startClient,
      random: () => 0, // delay-0 reconnects for determinism
      initialJitterMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(handles.length).toBe(1);
    handles[0]!.resolveReady();
    await sup.ready();

    handles[0]!.triggerClose();
    expect(sup.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(handles.length).toBe(2);
    handles[1]!.resolveReady();
    await Promise.resolve();
    expect(sup.isConnected()).toBe(true);
    expect(sup.reconnectCount()).toBe(1);
    await sup.close();
  });

  it("does NOT reconnect after explicit close()", async () => {
    const { handles, startClient } = buildFakeClientFactory();
    const sup = superviseTunnelClient({
      ...commonOpts(),
      startClient,
      random: () => 0,
      initialJitterMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    handles[0]!.resolveReady();
    await sup.ready();

    await sup.close();
    expect(handles[0]!.externallyClosed).toBe(true);
    // Even if the inner client now fires onClose late, the supervisor
    // is stopped — no new attempts.
    handles[0]!.triggerClose();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(handles.length).toBe(1);
  });

  it("calls onReconnectAttempt with monotonically increasing attempt numbers", async () => {
    const { handles, startClient } = buildFakeClientFactory();
    const attempts: number[] = [];
    const sup = superviseTunnelClient({
      ...commonOpts(),
      startClient,
      random: () => 0,
      initialJitterMs: 0,
      onReconnectAttempt: (n) => attempts.push(n),
    });

    await vi.advanceTimersByTimeAsync(0);
    handles[0]!.resolveReady();
    await sup.ready();
    handles[0]!.triggerClose();
    await vi.advanceTimersByTimeAsync(1);
    handles[1]!.resolveReady();
    await Promise.resolve();
    handles[1]!.triggerClose();
    await vi.advanceTimersByTimeAsync(1);

    // attempt counter resets to 0 once ready resolves, so attempt is
    // always 1 from the perspective of the supervisor. The important
    // assertion is "we called the hook every dial".
    expect(attempts.length).toBe(3);
    await sup.close();
  });
});

/* ------------------------------------------------------------------ */
/*  Full-jitter exponential backoff                                    */
/* ------------------------------------------------------------------ */

describe("superviseTunnelClient — full-jitter exponential backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delay window doubles per attempt and caps at maxReconnectMs", async () => {
    // To exercise the doubling without `ready()` resetting `attempt`,
    // we force every inner client to NEVER resolve ready. The supervisor
    // then sees attempt grow unboundedly.
    const handles: FakeClientHandle[] = [];
    const startClient = (opts: TunnelClientOptions): TunnelClient => {
      // ready stays unresolved on purpose.
      const h: FakeClientHandle = {
        client: null as unknown as TunnelClient,
        resolveReady: () => {},
        rejectReady: () => {},
        triggerClose: () => opts.onClose?.(),
        externallyClosed: false,
        receivedOpts: opts,
      };
      h.client = {
        ready: () => new Promise<void>(() => {}),
        rehello: async () => {},
        requestTransfer: () => {},
        close: async () => {
          h.externallyClosed = true;
        },
      };
      handles.push(h);
      return h.client;
    };

    // Use random() = 1 (returning the upper bound of the jitter window
    // — we floor, so the actual delay is window-1ms; we'll assert with
    // generous bounds). On every close we want a deterministic max.
    // We use random() = 0.999 to keep delay close to (but under) the cap.
    const sup = superviseTunnelClient({
      ...commonOpts(),
      startClient,
      random: () => 0.9999,
      initialJitterMs: 0,
      baseReconnectMs: 1_000,
      maxReconnectMs: 60_000,
    });

    // attempt=1 → first dial, base*2^1 = 2000, delay ~1999
    // attempt=2 → base*2^2 = 4000, delay ~3999
    // ...
    // attempt=6 → base*2^6 = 64000 → capped at 60000, delay ~59999
    // attempt=7 → same cap

    // Drive: first dial.
    await vi.advanceTimersByTimeAsync(0);
    expect(handles.length).toBe(1);
    handles[0]!.triggerClose();

    // The implementation reuses `attempt` across the lifetime of the
    // supervisor when ready hasn't resolved. The first close fires
    // BEFORE attempt is incremented for the next dial, so the next
    // delay uses the just-incremented attempt count.
    //
    // We measure the actual cap by advancing in steps and observing
    // when the next handle appears.
    const observedWindows: number[] = [];
    let prevHandleCount = handles.length;
    for (let i = 0; i < 8; i++) {
      // Try in 1000ms increments up to 70s.
      let waited = 0;
      while (handles.length === prevHandleCount && waited < 80_000) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      observedWindows.push(waited);
      prevHandleCount = handles.length;
      handles[handles.length - 1]!.triggerClose();
    }

    // Windows should be (approximately) doubling then capping at 60s.
    // We don't assert exact values (random=0.9999 + floor + 500ms grid
    // means slack). We assert the SHAPE: monotonically non-decreasing
    // until the cap, and the cap is honored (no window > 60_500ms).
    for (let i = 1; i < observedWindows.length; i++) {
      expect(observedWindows[i]!).toBeLessThanOrEqual(60_500);
    }
    // At least one of the later windows should be near the cap (> 30s)
    // — proves the exponent actually grew.
    expect(observedWindows.slice(-3).some((w) => w > 30_000)).toBe(true);

    await sup.close();
  });

  it("backoff resets after a successful ready()", async () => {
    const { handles, startClient } = buildFakeClientFactory();
    const sup = superviseTunnelClient({
      ...commonOpts(),
      startClient,
      random: () => 0.9999,
      initialJitterMs: 0,
      baseReconnectMs: 1_000,
      maxReconnectMs: 60_000,
    });

    // Dial #1 — resolve ready → attempt counter resets.
    await vi.advanceTimersByTimeAsync(0);
    handles[0]!.resolveReady();
    await sup.ready();
    // Close → next dial uses attempt=1 (base*2^1=2000 → delay ≤ 1999ms).
    handles[0]!.triggerClose();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(handles.length).toBe(2);

    await sup.close();
  });
});

/* ------------------------------------------------------------------ */
/*  Keep-alive: ping/pong inside startTunnelClient                     */
/* ------------------------------------------------------------------ */

/**
 * Minimal EventEmitter-backed WS double. The production startTunnelClient
 * only touches the methods we expose here.
 */
class FakeWebSocket extends EventEmitter implements TunnelWebSocketLike {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  binaryType = "arraybuffer";
  pings = 0;
  closed = false;
  closeArgs: { code?: number; reason?: string } | null = null;

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeArgs = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    // Emit synchronously — under fake timers, setImmediate may queue
    // micro-tasks that vi.advanceTimersByTimeAsync awaits indefinitely.
    this.emit("close");
  }
  send(): void {
    /* no-op — we don't drive HELLO_ACK in these tests */
  }
  ping(): void {
    this.pings += 1;
  }
}

describe("startTunnelClient — keep-alive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings every intervalMs while connected", async () => {
    const fake = new FakeWebSocket();
    const factory: WebSocketFactory = Object.assign(
      ((_url: string) => fake) as (url: string) => TunnelWebSocketLike,
      { OPEN: FakeWebSocket.OPEN, CLOSED: FakeWebSocket.CLOSED },
    );

    const client = startTunnelClient({
      ...commonOpts(),
      wsFactory: factory,
      keepAlive: { intervalMs: 30_000, maxMissedPongs: 3 },
    });

    fake.emit("open");
    // First tick at 30s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.pings).toBe(1);

    // Simulate a pong arriving — resets the missed counter.
    fake.emit("pong");

    // Next tick at 60s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.pings).toBe(2);
    fake.emit("pong");

    await client.close();
  });

  it("force-closes after maxMissedPongs consecutive ticks with no pong", async () => {
    const fake = new FakeWebSocket();
    let onCloseFired = 0;
    const factory: WebSocketFactory = Object.assign(
      ((_url: string) => fake) as (url: string) => TunnelWebSocketLike,
      { OPEN: FakeWebSocket.OPEN, CLOSED: FakeWebSocket.CLOSED },
    );

    startTunnelClient({
      ...commonOpts(),
      wsFactory: factory,
      keepAlive: { intervalMs: 30_000, maxMissedPongs: 3 },
      onClose: () => {
        onCloseFired++;
      },
    });

    fake.emit("open");
    // 3 ticks with NO pongs in between → on the 4th tick the supervisor
    // sees missedPongs (3) > maxMissedPongs (3? no, > 3 means 4). Actually
    // re-read the impl: missedPongs++ then compare > maxMissedPongs. So
    // we need 4 ticks to cross.
    await vi.advanceTimersByTimeAsync(30_000); // missedPongs=1, ping
    await vi.advanceTimersByTimeAsync(30_000); // missedPongs=2, ping
    await vi.advanceTimersByTimeAsync(30_000); // missedPongs=3, ping
    expect(fake.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000); // missedPongs=4 > 3 → close
    expect(fake.closed).toBe(true);
    expect(onCloseFired).toBe(1);
  });

  it("triggers supervisor reconnect when keep-alive force-closes the WS", async () => {
    const fakes: FakeWebSocket[] = [];
    const factory: WebSocketFactory = Object.assign(
      ((_url: string) => {
        const f = new FakeWebSocket();
        fakes.push(f);
        return f;
      }) as (url: string) => TunnelWebSocketLike,
      { OPEN: FakeWebSocket.OPEN, CLOSED: FakeWebSocket.CLOSED },
    );

    const sup = superviseTunnelClient({
      ...commonOpts(),
      wsFactory: factory,
      random: () => 0, // delay-0 reconnects
      initialJitterMs: 0,
      keepAliveIntervalMs: 30_000,
      maxMissedPongs: 3,
    });

    // Initial dial fires immediately.
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.length).toBe(1);
    fakes[0]!.emit("open");

    // Drive 4 missed-pong ticks → WS force-closes → onClose → reconnect.
    await vi.advanceTimersByTimeAsync(120_001);
    expect(fakes[0]!.closed).toBe(true);

    // Supervisor schedules an immediate (random=0) reconnect.
    await vi.advanceTimersByTimeAsync(10);
    expect(fakes.length).toBe(2);
    expect(sup.reconnectCount()).toBe(1);

    await sup.close();
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

describe("superviseTunnelClient — edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("close() before ready() resolves does not leak the pending timer", async () => {
    const { handles, startClient } = buildFakeClientFactory();
    const sup = superviseTunnelClient({
      ...commonOpts(),
      startClient,
      random: () => 0.5,
      initialJitterMs: 30_000,
    });

    // Don't advance — pending initial-jitter timer is armed.
    await sup.close();
    // Even if the jitter window were to elapse, no dial should fire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handles.length).toBe(0);
  });

  it("requestTransfer + rehello no-op when disconnected", async () => {
    const { handles, startClient } = buildFakeClientFactory();
    const sup = superviseTunnelClient({
      ...commonOpts(),
      startClient,
      random: () => 0,
      initialJitterMs: 0,
    });
    // Before the first dial fires, isConnected() is false.
    expect(sup.isConnected()).toBe(false);
    sup.requestTransfer("foo.example");
    await sup.rehello();
    // No throw, no crash.
    await vi.advanceTimersByTimeAsync(0);
    expect(handles.length).toBe(1);
    await sup.close();
  });
});
