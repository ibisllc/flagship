/**
 * SiblingConnection — wraps a single authenticated peer-to-peer WS
 * carrying sibling frames (0x01 hello + 0x06 app-message). Drives the
 * SiblingHandshake state machine on top of a duplex transport, then
 * routes inbound app-messages into the SiblingRouter.
 *
 * Symmetric: server-side acceptors and client-side initiators both
 * use this class. The only difference is who opened the WS; the
 * handshake itself is symmetric.
 */

import type { Keypair } from "@flagship/protocol";
import {
  decodeSiblingFrame,
  encodeSiblingFrame,
  FRAME_SIBLING_APP_MESSAGE,
  FRAME_SIBLING_HELLO,
  type SiblingAppMessagePayload,
  type SiblingFrame,
} from "./frames.js";
import { SiblingHandshake, type SiblingPeerLookup } from "./handshake.js";
import type { InMemorySiblingRouter } from "./router.js";

/**
 * Minimal duplex transport interface. Decouples this code from `ws` so
 * tests can drive an in-memory pair without spinning up a server.
 */
export interface SiblingTransportSocket {
  /** Send one binary message to the peer. */
  send(data: Uint8Array): void;
  /** Close the underlying connection. */
  close(): void;
  /** Register message + close + error listeners. */
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  /** True iff the transport is open AND ready to accept sends. */
  readonly isOpen: boolean;
}

export interface SiblingConnectionOptions {
  socket: SiblingTransportSocket;
  myServerId: string;
  /**
   * Peer serverId. Optional on the responder side — when undefined,
   * the underlying handshake binds it from the first inbound hello.
   * Initiators ALWAYS know this and should pass it.
   */
  peerServerId?: string;
  myStk: Keypair;
  lookupPeerStk: SiblingPeerLookup;
  router: InMemorySiblingRouter;
  /**
   * Snapshot getter for currently-live peers. Piggybacked on hello
   * gossip. The connection asks at hello-send time so the snapshot
   * is fresh.
   */
  liveSiblings?: () => string[];
  /**
   * Hook invoked when the handshake reaches `ready`. Receives the
   * peer's serverId, which is now bound (whether the caller supplied
   * it or the responder learned it from the first hello). Production
   * wires this to register the peer in the router via setSibling.
   */
  onReady?: (args: { peerServerId: string }) => void;
  /**
   * Hook invoked when the connection closes. Receives the peer
   * serverId iff the handshake had progressed far enough to bind one.
   */
  onClose?: (args: { peerServerId: string | null }) => void;
}

export class SiblingConnection {
  private readonly handshake: SiblingHandshake;
  private closed = false;
  private gotReady = false;
  private readyPromise: Promise<void>;

  constructor(private readonly opts: SiblingConnectionOptions) {
    const handshake = new SiblingHandshake({
      myServerId: opts.myServerId,
      peerServerId: opts.peerServerId,
      myStk: opts.myStk,
      lookupPeerStk: opts.lookupPeerStk,
      send: (frame: SiblingFrame) => this.sendFrame(frame),
      liveSiblings: opts.liveSiblings,
    });
    this.handshake = handshake;
    this.readyPromise = (async () => {
      try {
        await handshake.ready();
        if (this.closed) return;
        this.gotReady = true;
        const bound = handshake.getPeerServerId();
        if (bound) opts.onReady?.({ peerServerId: bound });
      } catch (e) {
        this.close();
        throw e;
      }
    })();

    opts.socket.onMessage((data) => void this.onIncoming(data));
    opts.socket.onClose(() => this.handleClose());
    opts.socket.onError(() => this.close());

    handshake.start();
  }

  /** Resolves once mutual auth succeeds; rejects on handshake failure. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Send a sibling-app-message frame to the peer. Throws if the
   * connection isn't ready.
   */
  sendAppMessage(payload: SiblingAppMessagePayload): void {
    if (!this.gotReady) throw new Error("connection not ready");
    if (this.closed || !this.opts.socket.isOpen) {
      throw new Error("connection closed");
    }
    this.sendFrame({ type: FRAME_SIBLING_APP_MESSAGE, payload });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.opts.socket.close();
    } catch {
      /* swallow */
    }
    this.opts.onClose?.({ peerServerId: this.handshake.getPeerServerId() });
  }

  /** Bound peer serverId (post-handshake). Null pre-handshake. */
  getPeerServerId(): string | null {
    return this.handshake.getPeerServerId();
  }

  private sendFrame(frame: SiblingFrame): void {
    if (!this.opts.socket.isOpen) return;
    try {
      this.opts.socket.send(encodeSiblingFrame(frame));
    } catch {
      this.close();
    }
  }

  private async onIncoming(data: Uint8Array): Promise<void> {
    if (this.closed) return;
    if (!this.gotReady) {
      // Pre-ready: feed everything into the handshake. The state
      // machine accepts only hello; anything else fails.
      await this.handshake.ingest(data);
      return;
    }
    // Post-ready: route by frame type.
    const r = decodeSiblingFrame(data);
    if (r.kind === "error") {
      // Malformed frame post-handshake → close. Apps relying on
      // per-frame retries should re-open the connection.
      this.close();
      return;
    }
    if (r.frame.type === FRAME_SIBLING_HELLO) {
      // Late hello (gossip update). Forward into the handshake which
      // ignores it post-ready (the state machine has already settled).
      // Just pull liveSiblings out of the payload and merge if router
      // exposes a hook — we don't here yet; gossip uplift is N0e-3.
      return;
    }
    if (r.frame.type === FRAME_SIBLING_APP_MESSAGE) {
      const p = r.frame.payload;
      // Route into the in-pod router by serviceId.
      this.opts.router.ingestFromSibling({
        fromSiblingId: p.fromSiblingId,
        serviceId: p.serviceId,
        payloadHex: p.payloadHex,
      });
    }
  }

  private handleClose(): void {
    this.close();
  }
}

/**
 * Wrap a `ws` WebSocket as a SiblingTransportSocket so SiblingConnection
 * can drive it. Defined here rather than in a separate `wsSocket.ts` to
 * keep the abstraction one-file.
 */
export function wrapWsAsSiblingTransport(ws: {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(ev: "message", cb: (data: Buffer) => void): unknown;
  on(ev: "close", cb: () => void): unknown;
  on(ev: "error", cb: (err: unknown) => void): unknown;
  readyState: number;
  OPEN: number;
}): SiblingTransportSocket {
  return {
    send(d: Uint8Array) {
      ws.send(d);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* swallow */
      }
    },
    onMessage(cb) {
      ws.on("message", (data: Buffer) => {
        const view = new Uint8Array(data.byteLength);
        view.set(data);
        cb(view);
      });
    },
    onClose(cb) {
      ws.on("close", cb);
    },
    onError(cb) {
      ws.on("error", cb);
    },
    get isOpen() {
      return ws.readyState === ws.OPEN;
    },
  };
}

/**
 * Build a pair of in-memory transports for tests. Each side's `send`
 * is wired to the other's message listener.
 */
export function memoryTransportPair(): [SiblingTransportSocket, SiblingTransportSocket] {
  let aOpen = true;
  let bOpen = true;
  const aListeners: { msg: ((d: Uint8Array) => void)[]; close: (() => void)[]; err: ((e: unknown) => void)[] } = {
    msg: [], close: [], err: [],
  };
  const bListeners: typeof aListeners = { msg: [], close: [], err: [] };

  const a: SiblingTransportSocket = {
    send(d) {
      if (!aOpen) return;
      // deliver to b's message listeners on the next tick
      const copy = new Uint8Array(d);
      queueMicrotask(() => {
        if (!bOpen) return;
        for (const l of bListeners.msg) l(copy);
      });
    },
    close() {
      if (!aOpen) return;
      aOpen = false;
      for (const l of aListeners.close) l();
      bOpen = false;
      queueMicrotask(() => {
        for (const l of bListeners.close) l();
      });
    },
    onMessage(cb) { aListeners.msg.push(cb); },
    onClose(cb) { aListeners.close.push(cb); },
    onError(cb) { aListeners.err.push(cb); },
    get isOpen() { return aOpen; },
  };

  const b: SiblingTransportSocket = {
    send(d) {
      if (!bOpen) return;
      const copy = new Uint8Array(d);
      queueMicrotask(() => {
        if (!aOpen) return;
        for (const l of aListeners.msg) l(copy);
      });
    },
    close() {
      if (!bOpen) return;
      bOpen = false;
      for (const l of bListeners.close) l();
      aOpen = false;
      queueMicrotask(() => {
        for (const l of aListeners.close) l();
      });
    },
    onMessage(cb) { bListeners.msg.push(cb); },
    onClose(cb) { bListeners.close.push(cb); },
    onError(cb) { bListeners.err.push(cb); },
    get isOpen() { return bOpen; },
  };

  return [a, b];
}
