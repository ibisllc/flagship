/**
 * Peer-liveness signal for the P9 peer-backup BFF.
 *
 * Today the BFF derives `peersBackingYouUp[i].online` from
 * `MyShardRow.lastChallenge ?? storedAt`, which is a stale proxy — it only
 * advances when the proof-of-storage challenge loop runs. This watchdog
 * gives the projector a real "have I exchanged ANY frame with this peer
 * lately?" signal.
 *
 * Wiring: `wrapPeerLink(link, watchdog)` returns a drop-in PeerLink that
 * bumps the activity timestamp on every `send` + every received frame.
 * The BFF projector pulls the timestamp via `lastSeenMs(peerFqdn)` and
 * falls back to the existing proxy when no watchdog is wired.
 */

import type { Frame } from "@flagship/tunnel-protocol";
import type { PeerLink } from "./peerLink.js";

export interface PeerActivitySnapshot {
  /** Most-recent activity timestamp for the peer, or undefined when unseen. */
  lastSeenMs(peerFqdn: string): number | undefined;
}

export class PeerActivityWatchdog implements PeerActivitySnapshot {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Stamp activity for a peer at the given (or current) time. */
  bump(peerFqdn: string, at?: number): void {
    const t = at ?? this.now();
    const prev = this.seen.get(peerFqdn) ?? 0;
    if (t > prev) this.seen.set(peerFqdn, t);
  }

  lastSeenMs(peerFqdn: string): number | undefined {
    return this.seen.get(peerFqdn);
  }

  /** Test/debug introspection. */
  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.seen);
  }
}

/**
 * Returns a PeerLink whose `send` + received frames bump the watchdog
 * against `link.remoteServerId`. The original link is otherwise
 * unmodified — callers retain the underlying object identity for
 * shutdown semantics (the wrapper's `close()` delegates).
 */
export function wrapPeerLink(
  link: PeerLink,
  watchdog: PeerActivityWatchdog,
): PeerLink {
  return {
    remoteServerId: link.remoteServerId,
    send(f: Frame) {
      watchdog.bump(link.remoteServerId);
      link.send(f);
    },
    onFrame(handler: (f: Frame) => void): () => void {
      return link.onFrame((f) => {
        watchdog.bump(link.remoteServerId);
        handler(f);
      });
    },
    close() {
      link.close();
    },
  };
}
