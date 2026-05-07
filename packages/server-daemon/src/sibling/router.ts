/**
 * SiblingRouter — multiplexes sibling-app-message (frame 0x06) traffic
 * for the calling pod. It is the in-pod backbone of N0i's
 * `/api/live_siblings/{list,send,poll}` API.
 *
 * State this owns:
 *   - The set of known siblings (siblingId, controlled FQDNs, online,
 *     lastSeen). Updated as connections to peers come up + go down,
 *     plus refreshed periodically from .com /api/server/by-domain
 *     (production wires this; tests poke setSibling directly).
 *   - Per-app subscription channels — apps register a listener via
 *     `subscribe(appId, ...)` and receive every inbound app-message
 *     whose embedded `appId` matches their token-bound id.
 *
 * Token isolation: the sibling-WS frame carries an `appId` field; on
 * inbound, we route only to the matching subscription. Two apps on
 * the same pod cannot read each other's inbound traffic. The HTTP
 * layer (handlers.ts) similarly resolves the calling token's appId
 * and uses it as the "fromAppId" on send + the subscribe key — apps
 * cannot impersonate each other on send either.
 *
 * What this MODULE does not do (those land in N0e-2):
 *   - Establish the sibling-WS connections themselves
 *   - Drive the handshake state machine
 *   - Persistence — sibling state is in-memory; rebuilt on restart
 *
 * The router exposes `setSibling` / `removeSibling` / `ingestFromSibling`
 * as the seams the connection layer plugs into.
 */

export interface SiblingInfo {
  siblingId: string;
  fqdns: string[];
  online: boolean;
  lastSeenMs: number;
}

export interface SiblingTransport {
  /** Send a sibling-app-message frame to this peer. Throws on offline. */
  send(args: {
    appId: string;
    fromSiblingId: string;
    toSiblingId: string;
    payloadHex: string;
  }): Promise<void>;
}

export interface InboundAppMessage {
  fromSiblingId: string;
  payloadHex: string;
}

export interface DomainGrantedEvent {
  fqdn: string;
  /** Canonical FQDN of the pod that now holds the route. */
  ownerSiblingId: string;
}

export type InboundEvent =
  | ({ kind: "app-message" } & InboundAppMessage)
  | ({ kind: "domain-granted" } & DomainGrantedEvent);

export type EventListener = (event: InboundEvent) => void;
/** @deprecated alias kept so existing callers still resolve. */
export type AppMessageListener = EventListener;

export type SendResult =
  | { ok: true }
  | { ok: false; reason: "unknown sibling" | "sibling offline" | "transport failed"; message?: string };

/**
 * In-memory implementation. Suitable for production (the daemon
 * keeps state in-process anyway) and trivially testable.
 */
export class InMemorySiblingRouter {
  private siblings = new Map<string, SiblingInfo & { transport: SiblingTransport | null }>();
  /** appId → set of listeners. */
  private subscribers = new Map<string, Set<AppMessageListener>>();
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Replace (or create) the entry for a sibling. */
  setSibling(args: {
    siblingId: string;
    fqdns: string[];
    online: boolean;
    transport: SiblingTransport | null;
  }): void {
    const existing = this.siblings.get(args.siblingId);
    this.siblings.set(args.siblingId, {
      siblingId: args.siblingId,
      fqdns: [...args.fqdns],
      online: args.online,
      lastSeenMs: existing && !args.online ? existing.lastSeenMs : this.now(),
      transport: args.transport,
    });
  }

  removeSibling(siblingId: string): void {
    this.siblings.delete(siblingId);
  }

  list(): SiblingInfo[] {
    const out: SiblingInfo[] = [];
    for (const s of this.siblings.values()) {
      const { transport: _t, ...rest } = s;
      void _t;
      out.push({ ...rest, fqdns: [...rest.fqdns] });
    }
    return out;
  }

  /**
   * Send a sibling-app-message. The caller has already resolved the
   * calling app's appId from FLAGSHIP_APP_TOKEN; the router does not
   * cross-validate it — token resolution + scoping happens in the
   * HTTP handler, then this method is invoked with that scope.
   */
  async send(args: {
    fromAppId: string;
    fromSiblingId: string;
    toSiblingId: string;
    payloadHex: string;
  }): Promise<SendResult> {
    const peer = this.siblings.get(args.toSiblingId);
    if (!peer) return { ok: false, reason: "unknown sibling" };
    if (!peer.online || !peer.transport) {
      return { ok: false, reason: "sibling offline" };
    }
    try {
      await peer.transport.send({
        appId: args.fromAppId,
        fromSiblingId: args.fromSiblingId,
        toSiblingId: args.toSiblingId,
        payloadHex: args.payloadHex,
      });
    } catch (e) {
      return { ok: false, reason: "transport failed", message: (e as Error).message };
    }
    return { ok: true };
  }

  /**
   * Register a listener for a specific appId. Returns an
   * unsubscribe closure. Apps subscribe to their OWN appId (resolved
   * from the token) — there is no cross-app subscribe.
   */
  subscribe(appId: string, listener: AppMessageListener): () => void {
    let set = this.subscribers.get(appId);
    if (!set) {
      set = new Set();
      this.subscribers.set(appId, set);
    }
    set.add(listener);
    return () => {
      const cur = this.subscribers.get(appId);
      if (!cur) return;
      cur.delete(listener);
      if (cur.size === 0) this.subscribers.delete(appId);
    };
  }

  /**
   * Called by the connection layer when a sibling-app-message arrives.
   * Routes to every subscriber for the embedded appId. If no subscribers,
   * the message is dropped silently — apps with no live subscription
   * have implicitly opted out (no buffering is harness territory; apps
   * that need at-least-once delivery handle that themselves).
   */
  ingestFromSibling(args: {
    fromSiblingId: string;
    appId: string;
    payloadHex: string;
  }): void {
    const cur = this.subscribers.get(args.appId);
    if (!cur) return;
    const event: InboundEvent = {
      kind: "app-message",
      fromSiblingId: args.fromSiblingId,
      payloadHex: args.payloadHex,
    };
    this.fanOut(cur, event);
  }

  /**
   * Pod-level event: the .services hub just told us a domain was
   * granted (FRAME 0x12). Broadcast to every subscriber on this pod
   * regardless of appId — every app that cares can compare
   * `ownerSiblingId` against its pod's canonical and react. Granted
   * events for the new owner are included; apps know if they're the
   * recipient.
   */
  broadcastDomainGranted(e: DomainGrantedEvent): void {
    const event: InboundEvent = {
      kind: "domain-granted",
      fqdn: e.fqdn,
      ownerSiblingId: e.ownerSiblingId,
    };
    for (const set of this.subscribers.values()) {
      this.fanOut(set, event);
    }
  }

  private fanOut(listeners: Set<EventListener>, event: InboundEvent): void {
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        /* swallow — router stays healthy */
      }
    }
  }
}
