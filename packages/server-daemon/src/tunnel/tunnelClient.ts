import { connect as netConnect, type Socket } from "node:net";
import { WebSocket } from "ws";
import type { EventEmitter } from "node:events";
import {
  closeFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_DOMAIN_GRANTED,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_OPEN,
  requestTransferFrame,
  type Frame,
} from "@flagship/tunnel-protocol";
import {
  serviceEntitlementCertId,
  rootEntitlementCertId,
  signTunnelHelloV2,
  type ServiceEntitlement,
  type Bytes,
  type Keypair,
  type RootEntitlement,
  type TunnelHelloV2,
} from "@flagship/protocol";

export interface BackendTarget {
  host: string;
  port: number;
}

export type BackendResolver = (sni: string) => BackendTarget | null;

/**
 * Snapshot of the entitlement certs the daemon currently holds. The
 * daemon caches these on disk (re-loaded on boot) and presents them
 * on every HELLO. The phone re-issues + ships fresh certs whenever
 * apps change OR on rolling refresh before TTL.
 */
export interface EntitlementBundle {
  rootEntitlement: RootEntitlement;
  rootEntitlementSig: Bytes;
  /** Optional. Pods can boot with no apps yet (root-only HELLO). */
  serviceEntitlement?: ServiceEntitlement | null;
  serviceEntitlementSig?: Bytes | null;
}

/**
 * Minimal WebSocket-shaped surface the tunnel client consumes. The `ws`
 * package's `WebSocket` satisfies it; tests supply an `EventEmitter`-
 * based double that exposes the same methods so we can drive open / close
 * / ping / pong synthetically.
 */
export interface TunnelWebSocketLike extends EventEmitter {
  readonly readyState: number;
  binaryType: string;
  close(code?: number, data?: string): void;
  send(data: Uint8Array | string, options?: { binary?: boolean }): void;
  ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
}

/**
 * Factory the tunnel client uses to create its underlying WebSocket.
 * Production passes a thin wrapper over `new WebSocket(url)`; tests pass
 * a factory that returns a controllable double. The factory returns the
 * three numeric ready-state constants alongside the socket so the client
 * doesn't have to import them globally.
 */
export interface WebSocketFactory {
  (url: string): TunnelWebSocketLike;
  readonly OPEN: number;
  readonly CLOSED: number;
}

export const defaultWebSocketFactory: WebSocketFactory = Object.assign(
  ((url: string) => {
    const ws = new WebSocket(url) as unknown as TunnelWebSocketLike;
    ws.binaryType = "arraybuffer";
    return ws;
  }) as (url: string) => TunnelWebSocketLike,
  { OPEN: WebSocket.OPEN as number, CLOSED: WebSocket.CLOSED as number },
);

export interface TunnelClientOptions {
  /** ws:// or wss:// URL of the control-plane tunnel hub. */
  hubUrl: string;
  /** Pod's STK keypair (signs the HELLO envelope). */
  signingKey: Keypair;
  /**
   * Source of fresh entitlement bundles. Called every HELLO so the
   * pod can pick up rotated certs on the fly. The serverId for HELLO
   * is taken from `bundle.rootEntitlement.podCanonical`.
   */
  getEntitlements: () => EntitlementBundle | Promise<EntitlementBundle>;
  /** Given an SNI hostname, return the local backend to forward to. */
  resolveBackend: BackendResolver;
  /**
   * Called when the hub broadcasts a domain-granted event (FRAME 0x12).
   * Daemon plumbs into the in-pod live-siblings router so apps observe
   * the grant via /api/live_siblings/poll. Optional.
   */
  onDomainGranted?: (e: { fqdn: string; ownerServerId: string }) => void;
  /**
   * Fires when the underlying WS closes (clean shutdown, network drop,
   * keep-alive timeout). The supervisor listens to this to schedule a
   * reconnect. Single-shot.
   */
  onClose?: () => void;
  /**
   * If set (>0), send a WS ping every `keepAlive.intervalMs`. If
   * `keepAlive.maxMissedPongs` ticks pass without a pong, the socket
   * is force-closed (which fires onClose so the supervisor reconnects).
   * Default: disabled (single-attempt callers don't need it).
   */
  keepAlive?: {
    intervalMs: number;
    maxMissedPongs: number;
  };
  /** Test seam — replace WebSocket constructor + ready-state constants. */
  wsFactory?: WebSocketFactory;
  /** Test seam — replace setInterval/clearInterval (keep-alive cadence). */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export interface TunnelClient {
  /** Resolves once HELLO_ACK is received and registration is confirmed. */
  ready(): Promise<void>;
  /**
   * Re-send a HELLO with the latest entitlement bundle. Used after
   * the phone delivers fresh certs (new app installed, rotation).
   * Idempotent.
   */
  rehello(): Promise<void>;
  /**
   * Ask the hub to transfer ownership of `fqdn` to this pod. The hub
   * validates the pod has a derivable claim (via the cert it
   * presented at HELLO) and atomically reassigns. Result surfaces via
   * the next FRAME_DOMAIN_GRANTED broadcast.
   */
  requestTransfer(fqdn: string): void;
  close(): Promise<void>;
}

export function startTunnelClient(opts: TunnelClientOptions): TunnelClient {
  const factory = opts.wsFactory ?? defaultWebSocketFactory;
  const ws = factory(opts.hubUrl);
  ws.binaryType = "arraybuffer";
  const setIntervalFn = opts.setIntervalImpl ?? setInterval;
  const clearIntervalFn = opts.clearIntervalImpl ?? clearInterval;

  const streams = new Map<number, Socket>();
  let buffered: Uint8Array = new Uint8Array(0);
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let lastIssuedAt = 0;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let missedPongs = 0;
  let onCloseFired = false;

  function send(frame: Frame): void {
    if (ws.readyState === factory.OPEN) ws.send(encodeFrame(frame), { binary: true });
  }

  function stopKeepAlive(): void {
    if (keepAliveTimer !== null) {
      clearIntervalFn(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function fireOnClose(): void {
    if (onCloseFired) return;
    onCloseFired = true;
    stopKeepAlive();
    try {
      opts.onClose?.();
    } catch {
      /* swallow — the supervisor's onClose is best-effort */
    }
  }

  async function sendHello(): Promise<void> {
    const bundle = await opts.getEntitlements();
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    let issuedAt = Date.now();
    if (issuedAt <= lastIssuedAt) issuedAt = lastIssuedAt + 1;
    lastIssuedAt = issuedAt;
    const rootCertId = await rootEntitlementCertId(bundle.rootEntitlement);
    const appCertId = bundle.serviceEntitlement
      ? await serviceEntitlementCertId(bundle.serviceEntitlement)
      : "";
    const envelope: TunnelHelloV2 = {
      serverId: bundle.rootEntitlement.podCanonical,
      rootEntitlementCertId: rootCertId,
      serviceEntitlementCertId: appCertId,
      nonce,
      issuedAt,
    };
    const signature = signTunnelHelloV2(envelope, opts.signingKey);
    const payload = JSON.stringify({
      version: 2,
      serverId: bundle.rootEntitlement.podCanonical,
      rootEntitlement: {
        username: bundle.rootEntitlement.username,
        podPubKey: bytesToHex(bundle.rootEntitlement.podPubKey),
        podCanonical: bundle.rootEntitlement.podCanonical,
        issuedAt: bundle.rootEntitlement.issuedAt,
      },
      rootEntitlementSig: bytesToHex(bundle.rootEntitlementSig),
      rootEntitlementCertId: rootCertId,
      serviceEntitlement: bundle.serviceEntitlement
        ? {
            username: bundle.serviceEntitlement.username,
            podPubKey: bytesToHex(bundle.serviceEntitlement.podPubKey),
            canonicals: bundle.serviceEntitlement.canonicals,
            issuedAt: bundle.serviceEntitlement.issuedAt,
            expiresAt: bundle.serviceEntitlement.expiresAt,
          }
        : null,
      serviceEntitlementSig: bundle.serviceEntitlementSig ? bytesToHex(bundle.serviceEntitlementSig) : null,
      serviceEntitlementCertId: appCertId,
      nonce: bytesToHex(nonce),
      issuedAt,
      signature: bytesToHex(signature),
    });
    send({
      streamId: 0,
      type: FRAME_HELLO,
      payload: new TextEncoder().encode(payload),
    });
  }

  ws.on("open", () => {
    void sendHello();
    if (opts.keepAlive && opts.keepAlive.intervalMs > 0) {
      // Reset on every (re)connection. We start counting missed pongs
      // immediately: each tick increments the counter then issues a
      // ping; the 'pong' handler resets the counter. Once the counter
      // reaches maxMissedPongs we force-close the socket, which fires
      // the 'close' handler → onClose → supervisor reconnect.
      missedPongs = 0;
      keepAliveTimer = setIntervalFn(() => {
        missedPongs += 1;
        if (missedPongs > opts.keepAlive!.maxMissedPongs) {
          // Stop the timer before close() so a delayed close event
          // can't re-enter this branch.
          stopKeepAlive();
          try {
            ws.close();
          } catch {
            /* if close throws the supervisor still picks up via onClose */
          }
          // Some test doubles never emit "close" after close(); fire
          // onClose directly so the supervisor isn't wedged.
          fireOnClose();
          return;
        }
        try {
          ws.ping();
        } catch {
          /* ignore — the next tick will keep counting and force-close */
        }
      }, opts.keepAlive.intervalMs);
      // Don't keep Node alive on a tunnel client that's otherwise idle.
      (keepAliveTimer as { unref?: () => void }).unref?.();
    }
  });

  ws.on("pong", () => {
    missedPongs = 0;
  });

  ws.on("message", (raw: ArrayBuffer | Buffer | Buffer[]) => {
    const incoming = toUint8(raw);
    buffered = concat(buffered, incoming);
    while (true) {
      const r = decodeFrame(buffered);
      if (r.kind === "incomplete") return;
      if (r.kind === "error") {
        rejectReady(new Error(r.reason));
        ws.close();
        return;
      }
      buffered = buffered.subarray(r.consumed);
      handleFrame(r.frame);
    }
  });

  ws.on("close", () => {
    for (const sock of streams.values()) sock.destroy();
    streams.clear();
    fireOnClose();
  });

  ws.on("error", (e) => {
    rejectReady(e instanceof Error ? e : new Error(String(e)));
    // An error before open typically means the WS will close immediately
    // after. The close handler will fire onClose; we don't double-fire here.
  });

  function handleFrame(f: Frame): void {
    if (f.type === FRAME_DOMAIN_GRANTED) {
      if (!opts.onDomainGranted) return;
      try {
        const body = JSON.parse(new TextDecoder().decode(f.payload)) as {
          fqdn?: unknown;
          ownerServerId?: unknown;
        };
        if (typeof body.fqdn === "string" && typeof body.ownerServerId === "string") {
          opts.onDomainGranted({ fqdn: body.fqdn, ownerServerId: body.ownerServerId });
        }
      } catch {
        /* malformed; drop */
      }
      return;
    }
    if (f.type === FRAME_HELLO_ACK) {
      let body: { ok?: boolean; reason?: string };
      try {
        body = JSON.parse(new TextDecoder().decode(f.payload));
      } catch {
        rejectReady(new Error("HELLO_ACK payload not JSON"));
        return;
      }
      if (body.ok) resolveReady();
      else rejectReady(new Error(body.reason ?? "HELLO_ACK rejected"));
      return;
    }
    if (f.type === FRAME_OPEN) {
      const sni = new TextDecoder().decode(f.payload);
      const target = opts.resolveBackend(sni);
      if (!target) {
        send(closeFrame(f.streamId, true));
        return;
      }
      const sock = netConnect(target.port, target.host);
      streams.set(f.streamId, sock);
      sock.on("data", (chunk: Buffer) => {
        send(
          dataFrame(
            f.streamId,
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          ),
        );
      });
      sock.on("end", () => send(closeFrame(f.streamId, true)));
      sock.on("close", () => streams.delete(f.streamId));
      sock.on("error", () => {
        send(closeFrame(f.streamId, true));
        sock.destroy();
        streams.delete(f.streamId);
      });
      return;
    }
    if (f.type === FRAME_DATA) {
      const sock = streams.get(f.streamId);
      if (sock) sock.write(Buffer.from(f.payload));
      return;
    }
    if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
      const sock = streams.get(f.streamId);
      if (sock) sock.end();
      streams.delete(f.streamId);
      return;
    }
  }

  return {
    ready: () => ready,
    rehello: () => sendHello(),
    requestTransfer: (fqdn: string) => {
      send(requestTransferFrame({ fqdn: fqdn.toLowerCase() }));
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Mark close as expected so the supervisor's onClose hook (if
        // any) treats the disconnect as terminal, not a candidate for
        // reconnect. Easiest signal is to fire it ourselves now so
        // when the WS close event later arrives the second fire is a
        // no-op.
        fireOnClose();
        if (ws.readyState === factory.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

function toUint8(raw: ArrayBuffer | Buffer | Buffer[]): Uint8Array {
  if (Array.isArray(raw)) {
    let total = 0;
    for (const b of raw) total += b.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const b of raw) {
      out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), p);
      p += b.length;
    }
    return out;
  }
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/* ------------------------------------------------------------------ */
/*  Supervisor: reconnects on any WS close with jittered backoff.     */
/* ------------------------------------------------------------------ */

export interface SupervisedTunnelClient {
  /**
   * Resolves once the FIRST connection's HELLO_ACK lands. Reconnects
   * after this point are silent; observers should listen to onReconnect
   * if they care.
   */
  ready(): Promise<void>;
  /**
   * The number of full-reconnect attempts the supervisor has issued
   * since startup (does not include the initial dial). Tests and ops
   * dashboards consume this.
   */
  reconnectCount(): number;
  /**
   * Whether the supervisor currently has a live (HELLO_ACKed) inner client.
   */
  isConnected(): boolean;
  /**
   * Re-send the HELLO on the live client (if any). No-op if disconnected.
   * The next reconnect picks up the new entitlements via getEntitlements.
   */
  rehello(): Promise<void>;
  /** Ask the live client (if any) to transfer ownership of an FQDN. */
  requestTransfer(fqdn: string): void;
  /** Stop supervising. Cancels any pending reconnect timer + closes the live WS. */
  close(): Promise<void>;
}

export interface SupervisorOptions {
  /**
   * Max jitter applied to the daemon's INITIAL dial (not reconnects).
   * Default 30s; matches the `random()*30s` smear the design calls for
   * so a fleet of daemons coming up at the same time doesn't thundering-
   * herd the hub. Set to 0 in tests for deterministic startup.
   */
  initialJitterMs?: number;
  /** Default 1s. Reconnect delay grows as random(0, min(maxMs, base * 2^n)). */
  baseReconnectMs?: number;
  /** Cap on the reconnect delay. Default 60s. */
  maxReconnectMs?: number;
  /** Keep-alive cadence injected into every reconnect's inner client. Default 30s. */
  keepAliveIntervalMs?: number;
  /** Pongs missed before the supervisor force-closes + reconnects. Default 3. */
  maxMissedPongs?: number;
  /** Test seam — replace Math.random. */
  random?: () => number;
  /** Test seam — replace setTimeout/clearTimeout (reconnect delay + initial jitter). */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  /** Test seam — replace setInterval/clearInterval (keep-alive). */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Test seam — replace the WebSocket constructor used by every inner client. */
  wsFactory?: WebSocketFactory;
  /**
   * Test seam — replace the inner-client builder. Production uses
   * startTunnelClient; tests can pass a synchronous double.
   */
  startClient?: (opts: TunnelClientOptions) => TunnelClient;
  /**
   * Fires every time the supervisor begins a reconnect attempt (after
   * the backoff delay). Receives the 1-indexed attempt number. Useful
   * for tests + observability.
   */
  onReconnectAttempt?: (attempt: number) => void;
  /** Fires whenever an inner client is closed (clean or not). */
  onDisconnect?: () => void;
}

export type SuperviseTunnelClientOptions = TunnelClientOptions & SupervisorOptions;

/**
 * Wrap `startTunnelClient` in a reconnect supervisor. The supervisor:
 *
 *   1. Smears the FIRST dial across `initialJitterMs` (default 30s) so a
 *      fleet of daemons coming up at the same time doesn't synchronize.
 *   2. On any WS close, schedules a reconnect with full-jitter exponential
 *      backoff: `delay = random(0, min(maxReconnectMs, base * 2^attempt))`.
 *   3. Never gives up. A long-lived daemon whose hub is down for a week
 *      will keep retrying once a minute (the cap) forever.
 *   4. Drives a 30s keep-alive ping on every connected inner client; 3
 *      missed pongs (≈90s) declare the connection dead.
 *
 * `ready()` resolves on the FIRST successful HELLO_ACK. Subsequent
 * reconnects don't reject ready — the daemon has its TLS server up and
 * apps continue serving local traffic; only the hub-fronted requests
 * pause until reconnect.
 */
export function superviseTunnelClient(
  opts: SuperviseTunnelClientOptions,
): SupervisedTunnelClient {
  const initialJitterMs = opts.initialJitterMs ?? 30_000;
  const baseReconnectMs = opts.baseReconnectMs ?? 1_000;
  const maxReconnectMs = opts.maxReconnectMs ?? 60_000;
  const keepAliveIntervalMs = opts.keepAliveIntervalMs ?? 30_000;
  const maxMissedPongs = opts.maxMissedPongs ?? 3;
  const random = opts.random ?? Math.random;
  const setTimeoutFn = opts.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutImpl ?? clearTimeout;
  const startClient = opts.startClient ?? startTunnelClient;

  let stopped = false;
  let attempt = 0;
  let totalDials = 0;
  let reconnectCount = 0;
  let live: TunnelClient | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let readyResolved = false;

  function fullJitterDelay(): number {
    // RFC: random(0, min(max, base * 2^attempt))
    const exp = Math.min(maxReconnectMs, baseReconnectMs * Math.pow(2, attempt));
    return Math.floor(random() * exp);
  }

  function startOne(): void {
    if (stopped) return;
    attempt += 1;
    totalDials += 1;
    if (totalDials > 1) reconnectCount += 1;
    opts.onReconnectAttempt?.(attempt);
    let client: TunnelClient;
    try {
      client = startClient({
        hubUrl: opts.hubUrl,
        signingKey: opts.signingKey,
        getEntitlements: opts.getEntitlements,
        resolveBackend: opts.resolveBackend,
        onDomainGranted: opts.onDomainGranted,
        keepAlive: { intervalMs: keepAliveIntervalMs, maxMissedPongs },
        wsFactory: opts.wsFactory,
        setIntervalImpl: opts.setIntervalImpl,
        clearIntervalImpl: opts.clearIntervalImpl,
        onClose: () => {
          // Forget the live ref + schedule the next reconnect. We don't
          // distinguish "graceful close" from "network drop" here —
          // either way the supervisor reconnects until close() is called.
          live = null;
          opts.onDisconnect?.();
          if (stopped) return;
          scheduleReconnect();
        },
      });
    } catch (e) {
      // Synchronous startClient failures (test seam) — treat as a failed
      // attempt and schedule the next try. Don't reject ready; the
      // supervisor by design retries forever.
      live = null;
      if (!readyResolved && attempt === 1) {
        // First attempt failed synchronously. We still schedule reconnect
        // (per the no-retry-cap contract). Tests that want to assert a
        // hard failure can override onReconnectAttempt.
      }
      void e;
      scheduleReconnect();
      return;
    }
    live = client;
    client.ready().then(
      () => {
        if (!readyResolved) {
          readyResolved = true;
          // Reset the backoff counter once we're authenticated.
          attempt = 0;
          resolveReady();
        } else {
          // Successful reconnect — reset backoff so the NEXT drop starts
          // from base again.
          attempt = 0;
        }
      },
      (e) => {
        // The inner client's ready() rejected (bad HELLO_ACK, bad frame).
        // The WS close handler will fire and trigger reconnect; we don't
        // reject the supervisor's ready on first attempt either — keep
        // retrying.
        if (!readyResolved && attempt >= Number.MAX_SAFE_INTEGER) {
          // unreachable; here to keep rejectReady referenced
          rejectReady(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (pendingTimer !== null) return; // already armed
    const delay = fullJitterDelay();
    pendingTimer = setTimeoutFn(() => {
      pendingTimer = null;
      startOne();
    }, delay);
    (pendingTimer as { unref?: () => void }).unref?.();
  }

  // Initial dial: smear across `initialJitterMs`. We treat the first
  // dial as a regular `attempt=1` so backoff after its close uses
  // attempt=2's window. Importantly the initial jitter fires ONLY ONCE.
  const initialDelay = initialJitterMs > 0 ? Math.floor(random() * initialJitterMs) : 0;
  pendingTimer = setTimeoutFn(() => {
    pendingTimer = null;
    startOne();
  }, initialDelay);
  (pendingTimer as { unref?: () => void }).unref?.();

  return {
    ready: () => ready,
    reconnectCount: () => reconnectCount,
    isConnected: () => live !== null,
    rehello: async () => {
      if (live) await live.rehello();
    },
    requestTransfer: (fqdn: string) => {
      live?.requestTransfer(fqdn);
    },
    close: async () => {
      stopped = true;
      if (pendingTimer !== null) {
        clearTimeoutFn(pendingTimer);
        pendingTimer = null;
      }
      const c = live;
      live = null;
      if (c) await c.close();
    },
  };
}
