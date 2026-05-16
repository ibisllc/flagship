/**
 * Persistent sibling-HANDSHAKE client + manager (N0e-2).
 *
 * Brings the app-message / `live_siblings` handshake path
 * (`/.flagship/sibling-handshake`) to parity with the cert-sync
 * path's `PersistentSiblingClient` / `SiblingClientManager` (#86): an
 * auto-dialer that, for each discovered peer, keeps a
 * `SiblingConnection` alive forever (reconnect-on-close, full-jitter
 * exponential backoff) and registers/unregisters the peer in the
 * `SiblingRouter` so `/api/live_siblings/*` populates *proactively* —
 * not only when a peer happens to dial us inbound or an
 * `/api/url/claim` takeover opens a one-shot connection.
 *
 * The inbound `/.flagship/sibling-handshake` accept is already wired
 * in `runtime.ts` (via `wsServer.acceptSiblingUpgrade`); the one-shot
 * outbound dial (`wsClient.openSiblingConnection`) already exists for
 * takeovers. The missing N0e-2 piece was this persistent *supervised*
 * outbound dialer + its `setPeers` manager. Runtime instantiation
 * (feeding `setPeers` from live peer discovery) is the joint
 * follow-on with the cert-sync `SiblingClientManager`: by precedent
 * neither supervisor is constructed in `runtime.ts` today — both are
 * library supervisors the daemon entrypoint wires together against
 * real peers (the live exercise). See router.ts + SESSION-HANDOFF #25.
 */

import type { Keypair } from "@flagship/protocol";
import {
  openSiblingConnection,
  type OpenSiblingArgs,
  type OpenSiblingResult,
} from "./wsClient.js";
import type { SiblingConnection } from "./connection.js";
import type { SiblingPeerLookup } from "./handshake.js";
import type { InMemorySiblingRouter } from "./router.js";

export type SiblingOpenFn = (args: OpenSiblingArgs) => Promise<OpenSiblingResult>;

export interface PersistentSiblingHandshakeClientOptions {
  /** Peer's FQDN (the WS host). */
  peerFqdn: string;
  /** Peer's serverId if known up-front (canonical pod URLs); else the
   *  handshake binds it and the router records it once known. */
  peerServerId?: string;
  myServerId: string;
  myStk: Keypair;
  lookupPeerStk: SiblingPeerLookup;
  router: InMemorySiblingRouter;
  liveSiblings?: () => string[];
  /** `wss` in production, `ws` in tests. */
  scheme?: "ws" | "wss";
  /** Defaults to `/.flagship/sibling-handshake`. */
  path?: string;
  connectTimeoutMs?: number;
  /**
   * Reconnect-after-close backoff base. Each attempt sleeps
   * `random(0, min(maxMs, base * 2^attempt))` — identical full-jitter
   * formula to the cert-sync PersistentSiblingClient.
   */
  baseReconnectMs?: number;
  maxReconnectMs?: number;
  /** Test seams. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  random?: () => number;
  /** Test seam — replace openSiblingConnection. */
  openImpl?: SiblingOpenFn;
  onConnected?: (a: { peerFqdn: string; peerServerId: string }) => void;
  onDisconnected?: (a: { peerFqdn: string }) => void;
}

export interface PersistentSiblingHandshakeClient {
  /** True while an inner SiblingConnection is live (post-ready). */
  isConnected(): boolean;
  /** Number of dial attempts (1-indexed) made so far. */
  attempts(): number;
  /** Resolves on the FIRST successful handshake; never rejects. */
  firstReady(): Promise<void>;
  /** Tear everything down. Cancels any pending reconnect. */
  close(): void;
}

export function startPersistentSiblingHandshakeClient(
  opts: PersistentSiblingHandshakeClientOptions,
): PersistentSiblingHandshakeClient {
  const baseMs = opts.baseReconnectMs ?? 1_000;
  const maxMs = opts.maxReconnectMs ?? 60_000;
  const setTimeoutFn = opts.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutImpl ?? clearTimeout;
  const random = opts.random ?? Math.random;
  const openImpl = opts.openImpl ?? openSiblingConnection;

  let stopped = false;
  let attempt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let live: SiblingConnection | null = null;
  let resolveFirst!: () => void;
  const firstReadyP = new Promise<void>((res) => {
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

  async function dial(): Promise<void> {
    if (stopped) return;
    attempt += 1;
    try {
      const { connection } = await openImpl({
        peerFqdn: opts.peerFqdn,
        peerServerId: opts.peerServerId,
        myServerId: opts.myServerId,
        myStk: opts.myStk,
        lookupPeerStk: opts.lookupPeerStk,
        router: opts.router,
        liveSiblings: opts.liveSiblings,
        scheme: opts.scheme,
        path: opts.path,
        connectTimeoutMs: opts.connectTimeoutMs,
        // Mirror runtime.ts's inbound accept wiring so the outbound
        // path populates the router symmetrically.
        onReady: ({ peerServerId }) => {
          attempt = 0; // backoff resets on a successful handshake
          opts.router.setSibling({
            siblingId: peerServerId,
            fqdns: [],
            online: true,
            transport: null,
          });
          opts.onConnected?.({ peerFqdn: opts.peerFqdn, peerServerId });
          if (!firstResolved) {
            firstResolved = true;
            resolveFirst();
          }
        },
        onClose: ({ peerServerId }) => {
          live = null;
          if (peerServerId) opts.router.removeSibling(peerServerId);
          opts.onDisconnected?.({ peerFqdn: opts.peerFqdn });
          scheduleReconnect();
        },
      });
      if (stopped) {
        connection.close();
        return;
      }
      live = connection;
    } catch {
      // Upgrade or handshake failed → defer to backoff.
      live = null;
      scheduleReconnect();
    }
  }

  void dial();

  return {
    isConnected: () => live !== null,
    attempts: () => attempt,
    firstReady: () => firstReadyP,
    close: () => {
      stopped = true;
      if (pendingTimer !== null) {
        clearTimeoutFn(pendingTimer);
        pendingTimer = null;
      }
      const c = live;
      live = null;
      if (c) c.close();
    },
  };
}

/**
 * Manager — one PersistentSiblingHandshakeClient per peer FQDN.
 * `setPeers` is called whenever the discovered-peer set changes; it
 * spins up new clients and tears down stale ones. Mirrors the
 * cert-sync `SiblingClientManager` exactly.
 */
export interface SiblingHandshakeClientManagerOptions
  extends Omit<PersistentSiblingHandshakeClientOptions, "peerFqdn" | "peerServerId"> {}

export class SiblingHandshakeClientManager {
  private clients = new Map<string, PersistentSiblingHandshakeClient>();

  constructor(private readonly opts: SiblingHandshakeClientManagerOptions) {}

  /** Replace the set of peer FQDNs. Idempotent. */
  setPeers(fqdns: string[]): void {
    const wanted = new Set(fqdns.map((d) => d.toLowerCase()));
    for (const [d, c] of [...this.clients.entries()]) {
      if (!wanted.has(d)) {
        c.close();
        this.clients.delete(d);
      }
    }
    for (const d of wanted) {
      if (this.clients.has(d)) continue;
      this.clients.set(
        d,
        startPersistentSiblingHandshakeClient({ ...this.opts, peerFqdn: d }),
      );
    }
  }

  /** Currently-tracked peer FQDNs. */
  peers(): string[] {
    return [...this.clients.keys()];
  }

  /** Tear down every client. */
  close(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}
