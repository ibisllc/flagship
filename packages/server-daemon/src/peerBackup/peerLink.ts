import { type Frame } from "@flagship/tunnel-protocol";

/**
 * Abstraction over a bidirectional, frame-aware channel between two
 * Flagship servers. Real implementations on top of QUIC / TLS-TCP /
 * WebSocket will plug in here; the loopback implementation in tests
 * just shoves frames between two endpoints.
 *
 * The interface is intentionally small: a single send method and a
 * single onFrame callback. Stream-id multiplexing is handled by callers.
 */
export interface PeerLink {
  send(frame: Frame): void;
  onFrame(handler: (f: Frame) => void): () => void;
  /** Identifier for the *remote* server this link is talking to. */
  remoteServerId: string;
  close(): void;
}

/** Pair of in-memory PeerLinks suitable for unit tests. */
export function loopbackPair(
  serverIdA: string,
  serverIdB: string,
): { a: PeerLink; b: PeerLink } {
  const handlersA = new Set<(f: Frame) => void>();
  const handlersB = new Set<(f: Frame) => void>();
  let closed = false;

  const a: PeerLink = {
    remoteServerId: serverIdB,
    send(f) {
      if (closed) return;
      // Schedule on a microtask so the synchronous "send → handler" path
      // doesn't surprise callers expecting async semantics.
      queueMicrotask(() => {
        for (const h of [...handlersB]) h(cloneFrame(f));
      });
    },
    onFrame(h) {
      handlersA.add(h);
      return () => handlersA.delete(h);
    },
    close() {
      closed = true;
      handlersA.clear();
      handlersB.clear();
    },
  };

  const b: PeerLink = {
    remoteServerId: serverIdA,
    send(f) {
      if (closed) return;
      queueMicrotask(() => {
        for (const h of [...handlersA]) h(cloneFrame(f));
      });
    },
    onFrame(h) {
      handlersB.add(h);
      return () => handlersB.delete(h);
    },
    close() {
      closed = true;
      handlersA.clear();
      handlersB.clear();
    },
  };
  return { a, b };
}

function cloneFrame(f: Frame): Frame {
  return { streamId: f.streamId, type: f.type, payload: f.payload.slice() };
}
