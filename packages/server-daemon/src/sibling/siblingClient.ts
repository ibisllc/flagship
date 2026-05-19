/**
 * Persistent sibling-sync CLIENT (#86).
 *
 * For each peer pod listed in any ServiceGrant the local pod shares, the
 * runtime spins up a PersistentSiblingClient that dials
 * `wss://<peerDomain>/.flagship/sibling-sync` and keeps the connection
 * alive forever (with reconnect-on-close jitter). The actual cert+key
 * routine sync happens through the SyncConnection state machine.
 *
 * The supervisor exposes a `setPeers(domains)` method the runtime
 * calls whenever the grant set changes:
 *
 *   - newly-listed peers: spin up a SiblingClient if none exists
 *   - newly-removed peers: tear down the SiblingClient
 *
 * That single mutation is what makes "sibling-removal does NOT force
 * re-issuance" real. The phone updates the grant; the runtime calls
 * setPeers; the affected connection is closed; both pods just stop
 * exchanging inventory. The certs on each pod stay valid until they
 * expire on their own clock — no re-mint required.
 */

import { WebSocket } from "ws";
import type { Bytes, Keypair, PodIdentityBinding } from "@flagship/protocol";
import {
  startSyncConnection,
  wrapWsAsSyncTransport,
  type AppGrantStore,
  type IrkPubKeyLookup,
  type SyncConnection,
  type SyncRevocationLookup,
} from "./syncConnection.js";

export interface PersistentSiblingClientOptions {
  /** Peer's canonical FQDN (the WS host). */
  peerDomain: string;
  /** Our pod's canonical FQDN. */
  myServerDomain: string;
  /** Our pod identity keypair. */
  myIdentity: Keypair;
  /** Our username. */
  username: string;
  /** Pre-signed binding for our pod. */
  myBinding: PodIdentityBinding;
  myBindingSignature: Bytes;
  /** Resolve a username → IRK pubkey. Cached upstream. */
  lookupIrk: IrkPubKeyLookup;
  /** Revocation lookup. Cached upstream; null on lookup-failure fails closed. */
  revocations: SyncRevocationLookup;
  /** Local grant store. */
  store: AppGrantStore;
  /** Optional override of scheme — `wss` in production, `ws` in tests. */
  scheme?: "ws" | "wss";
  /** Optional override of path — `/.flagship/sibling-sync` by default. */
  path?: string;
  /**
   * Reconnect-after-close backoff base. Default 1s (capped by maxMs).
   * Each attempt sleeps `random(0, min(maxMs, base * 2^attempt))`.
   */
  baseReconnectMs?: number;
  maxReconnectMs?: number;
  /**
   * Keep-alive ping cadence. Default 30s — same value the tunnel
   * client uses. Disabled with 0.
   */
  keepAliveIntervalMs?: number;
  /**
   * Cadence for the inventory frame sent over each established
   * connection. Default 5 minutes.
   */
  inventoryIntervalMs?: number;
  /** Test seam — replace setTimeout for backoff. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Test seam — replace Math.random (jitter). */
  random?: () => number;
  /**
   * Test seam — replace the WebSocket constructor. Receives the URL
   * and returns a `ws`-shaped object. Production uses `new WebSocket(url)`.
   */
  wsFactory?: (url: string) => WsLike;
  /** Fires every time we open a new inner connection (post-ready). */
  onConnected?: (args: { peerDomain: string }) => void;
  /** Fires on every disconnect (clean or otherwise). */
  onDisconnected?: (args: { peerDomain: string; reason?: string }) => void;
  /** Fires when we drop a hello for auth failure. */
  onAuthFailure?: (args: { peerDomain: string; reason: string }) => void;
}

export interface WsLike {
  readonly readyState: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(ev: "open", cb: () => void): unknown;
  on(ev: "message", cb: (data: Buffer) => void): unknown;
  on(ev: "close", cb: () => void): unknown;
  on(ev: "error", cb: (err: unknown) => void): unknown;
  ping?(): void;
  readonly OPEN: number;
}

export interface PersistentSiblingClient {
  /** True when an inner SyncConnection is currently in `ready`. */
  isConnected(): boolean;
  /** Tear everything down. Cancels any pending reconnect. */
  close(): void;
  /** Number of inner-connection attempts (1-indexed) made so far. */
  attempts(): number;
  /**
   * Wait for the first successful handshake. Resolves on the FIRST
   * ready; never rejects (the supervisor retries forever).
   */
  firstReady(): Promise<void>;
}

export function startPersistentSiblingClient(
  opts: PersistentSiblingClientOptions,
): PersistentSiblingClient {
  const scheme = opts.scheme ?? "wss";
  const path = opts.path ?? "/.flagship/sibling-sync";
  const url = `${scheme}://${opts.peerDomain}${path}`;
  const baseMs = opts.baseReconnectMs ?? 1_000;
  const maxMs = opts.maxReconnectMs ?? 60_000;
  const setTimeoutFn = opts.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutImpl ?? clearTimeout;
  const random = opts.random ?? Math.random;
  const wsFactory = opts.wsFactory ?? defaultWsFactory;

  let stopped = false;
  let attempt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let live: SyncConnection | null = null;
  let liveWs: WsLike | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let resolveFirst!: () => void;
  const firstReady = new Promise<void>((res) => {
    resolveFirst = res;
  });
  let firstResolved = false;

  function scheduleReconnect(): void {
    if (stopped) return;
    if (pendingTimer !== null) return;
    const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
    const delay = Math.floor(random() * exp);
    pendingTimer = setTimeoutFn(() => {
      pendingTimer = null;
      void dial();
    }, delay);
    (pendingTimer as { unref?: () => void }).unref?.();
  }

  function stopKeepAlive(): void {
    if (keepAliveTimer !== null) {
      (opts.clearIntervalImpl ?? clearInterval)(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  async function dial(): Promise<void> {
    if (stopped) return;
    attempt += 1;
    let ws: WsLike;
    try {
      ws = wsFactory(url);
      ws.binaryType = "arraybuffer";
    } catch {
      scheduleReconnect();
      return;
    }
    liveWs = ws;
    let openHandled = false;
    ws.on("open", () => {
      openHandled = true;
      try {
        const conn = startSyncConnection({
          socket: wrapWsAsSyncTransport(
            ws as unknown as Parameters<typeof wrapWsAsSyncTransport>[0],
          ),
          myServerDomain: opts.myServerDomain,
          myIdentity: opts.myIdentity,
          username: opts.username,
          myBinding: opts.myBinding,
          myBindingSignature: opts.myBindingSignature,
          lookupIrk: opts.lookupIrk,
          revocations: opts.revocations,
          store: opts.store,
          inventoryIntervalMs: opts.inventoryIntervalMs,
          setIntervalImpl: opts.setIntervalImpl,
          clearIntervalImpl: opts.clearIntervalImpl,
          onReady: ({ peerDomain }) => {
            attempt = 0; // backoff resets on successful handshake
            opts.onConnected?.({ peerDomain });
            if (!firstResolved) {
              firstResolved = true;
              resolveFirst();
            }
          },
          onClose: ({ reason }) => {
            live = null;
            opts.onDisconnected?.({
              peerDomain: opts.peerDomain,
              reason,
            });
            stopKeepAlive();
            scheduleReconnect();
          },
          onAuthFailure: ({ reason }) => {
            opts.onAuthFailure?.({ peerDomain: opts.peerDomain, reason });
          },
        });
        live = conn;
        if (opts.keepAliveIntervalMs && opts.keepAliveIntervalMs > 0 && ws.ping) {
          const setIntervalFn = opts.setIntervalImpl ?? setInterval;
          keepAliveTimer = setIntervalFn(() => {
            try {
              ws.ping?.();
            } catch {
              /* swallow */
            }
          }, opts.keepAliveIntervalMs);
          (keepAliveTimer as { unref?: () => void }).unref?.();
        }
      } catch {
        try {
          ws.close();
        } catch {
          /* swallow */
        }
      }
    });
    ws.on("close", () => {
      if (!openHandled) {
        // close BEFORE open → upgrade failed; defer to backoff.
        live = null;
        liveWs = null;
        scheduleReconnect();
      }
    });
    ws.on("error", () => {
      if (!openHandled) {
        try {
          ws.close();
        } catch {
          /* swallow */
        }
      }
    });
  }

  // Kick off.
  void dial();

  return {
    isConnected: () => live !== null,
    attempts: () => attempt,
    firstReady: () => firstReady,
    close: () => {
      stopped = true;
      if (pendingTimer !== null) {
        clearTimeoutFn(pendingTimer);
        pendingTimer = null;
      }
      stopKeepAlive();
      const c = live;
      live = null;
      if (c) c.close("client-shutdown");
      const w = liveWs;
      liveWs = null;
      if (w) {
        try {
          w.close();
        } catch {
          /* swallow */
        }
      }
    },
  };
}

function defaultWsFactory(url: string): WsLike {
  const ws = new WebSocket(url);
  return ws as unknown as WsLike;
}

/**
 * Manager — keeps a PersistentSiblingClient per peer domain. The
 * runtime calls `setPeers(domains)` whenever the ServiceGrant population
 * changes; the manager spins up new clients and tears down stale ones.
 *
 * This is the layer #91's renewer + #6's HELLO gate eventually feed
 * into — every grant change funnels through here.
 */
export interface SiblingClientManagerOptions
  extends Omit<PersistentSiblingClientOptions, "peerDomain"> {}

export class SiblingClientManager {
  private clients = new Map<string, PersistentSiblingClient>();

  constructor(private readonly opts: SiblingClientManagerOptions) {}

  /** Replace the set of peer domains. Idempotent. */
  setPeers(domains: string[]): void {
    const wanted = new Set(domains.map((d) => d.toLowerCase()));
    // Tear down clients no longer wanted.
    for (const [d, c] of [...this.clients.entries()]) {
      if (!wanted.has(d)) {
        c.close();
        this.clients.delete(d);
      }
    }
    // Spin up clients newly wanted.
    for (const d of wanted) {
      if (this.clients.has(d)) continue;
      const c = startPersistentSiblingClient({ ...this.opts, peerDomain: d });
      this.clients.set(d, c);
    }
  }

  /** Currently-tracked peer domains. */
  peers(): string[] {
    return [...this.clients.keys()];
  }

  /** Tear down every client. */
  close(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}
