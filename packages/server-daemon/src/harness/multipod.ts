/**
 * MultipodHarness (#85) — the daemon-side surface that vibe-coded apps
 * and the LLM call into to be multi-pod-aware.
 *
 * Apps don't talk to the .com control plane. They don't talk to the
 * tunnel hub. They don't manage AppGrants. They call this harness:
 *
 *   - `ownUrls(serviceId)`              "which URLs route to THIS copy?"
 *   - `siblings(serviceId)`             "which other pods of mine run this app?"
 *   - `requestUrl(url)`             "point that URL at me" (capability-gated)
 *   - `openSiblingWs(pod, serviceId)`   open an opaque app-message channel
 *   - `sendToSibling(pod, serviceId, msg)`  one-shot send (no channel mgmt)
 *   - `inbound(serviceId)`              async-iter of inbound app messages
 *
 * The harness sits on TWO sources of truth:
 *
 *   1. `AppGrantState` — the current set of grants the user has signed
 *      for THIS pod (one per `serviceCanonical@instance`). Each grant lists
 *      the sibling pods + routes the app is authorized to serve from.
 *      Refreshed by the .com pull loop; the harness just reads.
 *
 *   2. `SiblingFabric` — the persistent sibling-WS layer (#86). The
 *      fabric exposes `siblingsForApp` (which peer pods are CURRENTLY
 *      reachable for an serviceId), `openChannel` (open a control channel
 *      to a specific peer for an serviceId), `send` (one-shot), and an
 *      `inboundFor(serviceId)` async iterator that fans out inbound
 *      sibling-app-message frames.
 *
 * The harness is RUNTIME-AGNOSTIC: production wires it with the real
 * sibling client + an ServiceGrant store fed by the .com poller; tests pass
 * in-memory doubles. The harness itself never touches the network.
 *
 * Important guarantees:
 *   - Capability scoping is enforced HERE, not in the app. `requestUrl`
 *     consults the ServiceGrant for the calling app; only if a route matches
 *     do we ask the URL controller to claim. Otherwise the harness emits
 *     a phone alert ("approval-needed-for-url") and returns
 *     `{ ok: false, reason: "needs-user-approval" }`.
 *   - `sendToSibling` / `openSiblingWs` refuse to talk to a pod that
 *     ISN'T listed in the active ServiceGrant — even if the fabric happens
 *     to have a live WS to it (e.g. for a sibling app). This closes
 *     cross-app data leaks at the harness boundary.
 *
 * Wiring is in runtime.ts (`addHandler` for the HTTP surface) but the
 * harness object is the canonical in-process API; the HTTP routes
 * `/api/multipod/*` are a thin JSON skin over the same methods.
 */

import type {
  ServiceGrant,
  Bytes,
} from "@flagship/protocol";
import {
  serviceGrantActiveAt,
  serviceGrantAuthorizesPod,
  serviceGrantAuthorizesUrl,
} from "@flagship/protocol";

/**
 * Active grants for one (app + optional instance). Keyed by `appKey =
 * serviceCanonical[#instance]`. The harness queries by serviceId (the daemon's
 * internal "<creator>--<slug>" form) → the caller maps to appKey via
 * `AppGrantState.grantForApp(serviceId)`.
 */
export interface AppGrantEntry {
  grant: ServiceGrant;
  /** Signature over the grant, verified by the .com poll before storing. */
  signature: Bytes;
}

export interface AppGrantState {
  /**
   * Return the active grant (if any) for the daemon-internal serviceId.
   * Mapping serviceId → grant is the implementer's responsibility — the
   * daemon's ServicePlatform knows the mapping; tests inject a static map.
   * Returns null when no grant exists OR the grant is expired/inactive.
   */
  grantForApp(serviceId: string, now?: number): AppGrantEntry | null;
}

/**
 * Lookup from a sibling pod's canonical FQDN → its identity pubkey.
 * Sourced from the ServiceGrant itself (`serverIdentities` + `serverDomains`
 * paired by index when the grant is constructed, or from a side-table
 * the ServiceGrant store builds at ingest). The harness needs this to keep
 * its API by-FQDN while the underlying fabric is keyed by pubkey.
 *
 * Implementations should accept lower-case FQDNs.
 */
export type PodPubKeyLookup = (podCanonical: string) => Bytes | null;

/**
 * The subset of the sibling-WS fabric the harness depends on. Commit #86
 * lands the concrete implementation (`PersistentSiblingClient`). The
 * tests in this module use an in-memory double.
 */
export interface SiblingFabric {
  /**
   * Currently-reachable peer pods for `serviceId`. The fabric filters its
   * own connection set by which grants entitle which peers — but the
   * harness ALSO filters by the grant on every call (defense in depth).
   */
  reachablePeers(serviceId: string): Array<{ podCanonical: string }>;
  /**
   * Open a duplex channel-like object to the named peer for the given
   * serviceId. Returns a `MultipodChannel`. Multiple calls for the same
   * (peer, serviceId) MAY return the same underlying channel — the harness
   * doesn't guarantee identity.
   */
  openChannel(args: {
    podCanonical: string;
    serviceId: string;
  }): Promise<MultipodChannel>;
  /**
   * One-shot send. Doesn't keep a channel open. Useful for fire-and-
   * forget pings.
   */
  sendOnce(args: {
    podCanonical: string;
    serviceId: string;
    message: Uint8Array;
  }): Promise<void>;
  /**
   * Subscribe to inbound app-messages for an serviceId. The fabric calls
   * `cb` once per inbound message until the returned closure runs.
   */
  subscribe(
    serviceId: string,
    cb: (msg: { fromPod: string; message: Uint8Array }) => void,
  ): () => void;
}

/**
 * Bidirectional message channel returned by `openSiblingWs`. The shape
 * is intentionally minimal — apps treat it like a WebSocket without
 * caring about the wire framing.
 */
export interface MultipodChannel {
  send(message: Uint8Array): void;
  close(): void;
  readonly isOpen: boolean;
  /** Listen for incoming messages on THIS channel only. */
  onMessage(cb: (message: Uint8Array) => void): () => void;
  onClose(cb: () => void): () => void;
}

/**
 * Pushes a phone alert when the app requests a URL the grant doesn't
 * cover. The runtime wires this to AlertInbox; tests use a spy.
 */
export type ApprovalAlerter = (alert: {
  kind: "needs-url-approval";
  serviceId: string;
  requestedUrl: string;
}) => void;

/**
 * Local primitive — the harness DOESN'T call the hub directly; it goes
 * through the daemon's existing UrlController, which knows how to mint
 * the hub-side FRAME_REQUEST_TRANSFER.
 */
export interface UrlClaimer {
  claim(fqdn: string): Promise<void>;
}

export interface MultipodHarnessOptions {
  /** This pod's canonical FQDN. Used as the source of own-URL filtering. */
  myPodCanonical: string;
  /** This pod's identity pubkey. Used to validate own-pod-in-grant. */
  myPodPubKey: Bytes;
  /** Current AppGrants this pod holds. */
  grants: AppGrantState;
  /** Sibling-WS fabric (commit #86). */
  fabric: SiblingFabric;
  /** Hub-driven URL claim primitive. */
  urlClaimer: UrlClaimer;
  /** Phone-alert sink for needs-approval events. */
  alerter: ApprovalAlerter;
  /** Test seam — clock. */
  now?: () => number;
}

/**
 * Inbound message handed out by `inbound()`.
 */
export interface MultipodInboundMessage {
  fromPod: string;
  message: Uint8Array;
}

export interface MultipodHarness {
  ownUrls(serviceId: string): Promise<string[]>;
  siblings(serviceId: string): Promise<Array<{ podId: string; canonicalUrl: string }>>;
  openSiblingWs(podCanonical: string, serviceId: string): Promise<MultipodChannel>;
  requestUrl(
    url: string,
    serviceId: string,
  ): Promise<{ ok: true } | { ok: false; reason: "needs-user-approval" }>;
  sendToSibling(podCanonical: string, serviceId: string, message: Uint8Array): Promise<void>;
  inbound(serviceId: string): AsyncIterableIterator<MultipodInboundMessage>;
}

/**
 * Implementation. Apps' calls all flow through here so capability
 * scoping has exactly one enforcement point. The harness:
 *
 *   1. Looks up the active grant for `serviceId`. No grant → every method
 *      returns empty / errors / needs-user-approval.
 *   2. Filters siblings to grant.serverDomains MINUS this pod (so we
 *      don't list ourselves as a peer).
 *   3. Refuses any send / open whose target isn't in the grant.
 *   4. Routes requestUrl through grant.routes → URL controller OR phone
 *      alert.
 */
export class MultipodHarnessImpl implements MultipodHarness {
  private readonly now: () => number;

  constructor(private readonly opts: MultipodHarnessOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async ownUrls(serviceId: string): Promise<string[]> {
    const entry = this.opts.grants.grantForApp(serviceId, this.now());
    if (!entry) return [];
    const grant = entry.grant;
    if (!serviceGrantAuthorizesPod(grant, this.opts.myPodPubKey)) return [];
    // "Own URLs" = routes whose serverDomain list includes us. The
    // grant doesn't currently store route→pod mapping at fine grain —
    // any pod in serverIdentities can serve any route. For the
    // ownUrls() API we return ALL routes the grant covers and let the
    // app distinguish "I'm the current URL holder" via /api/url/owned.
    const out = new Set<string>();
    for (const r of grant.routes) out.add(r.url.toLowerCase());
    return [...out].sort();
  }

  async siblings(
    serviceId: string,
  ): Promise<Array<{ podId: string; canonicalUrl: string }>> {
    const entry = this.opts.grants.grantForApp(serviceId, this.now());
    if (!entry) return [];
    const grant = entry.grant;
    if (!serviceGrantAuthorizesPod(grant, this.opts.myPodPubKey)) return [];
    const me = this.opts.myPodCanonical.toLowerCase();
    const out: Array<{ podId: string; canonicalUrl: string }> = [];
    const seen = new Set<string>();
    for (const d of grant.serverDomains) {
      const lower = d.toLowerCase();
      if (lower === me) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push({ podId: lower, canonicalUrl: `https://${lower}` });
    }
    return out;
  }

  async openSiblingWs(
    podCanonical: string,
    serviceId: string,
  ): Promise<MultipodChannel> {
    this.assertPeerEntitled(podCanonical, serviceId);
    return this.opts.fabric.openChannel({
      podCanonical: podCanonical.toLowerCase(),
      serviceId,
    });
  }

  async requestUrl(
    url: string,
    serviceId: string,
  ): Promise<{ ok: true } | { ok: false; reason: "needs-user-approval" }> {
    const entry = this.opts.grants.grantForApp(serviceId, this.now());
    if (entry && serviceGrantAuthorizesUrl(entry.grant, url)) {
      const fqdn = parseFqdn(url);
      if (!fqdn) return { ok: false, reason: "needs-user-approval" };
      await this.opts.urlClaimer.claim(fqdn);
      return { ok: true };
    }
    this.opts.alerter({
      kind: "needs-url-approval",
      serviceId,
      requestedUrl: url,
    });
    return { ok: false, reason: "needs-user-approval" };
  }

  async sendToSibling(
    podCanonical: string,
    serviceId: string,
    message: Uint8Array,
  ): Promise<void> {
    this.assertPeerEntitled(podCanonical, serviceId);
    await this.opts.fabric.sendOnce({
      podCanonical: podCanonical.toLowerCase(),
      serviceId,
      message,
    });
  }

  inbound(serviceId: string): AsyncIterableIterator<MultipodInboundMessage> {
    // Bridge the fabric's callback subscription into an async iterator.
    // Buffer inbound messages between pulls so apps with bursty inputs
    // don't lose data; cap at 1024 to avoid runaway memory.
    const buffer: MultipodInboundMessage[] = [];
    const waiters: Array<
      (r: IteratorResult<MultipodInboundMessage>) => void
    > = [];
    let closed = false;
    const unsub = this.opts.fabric.subscribe(serviceId, (msg) => {
      // Defense in depth: only deliver messages from peers entitled by
      // the CURRENT grant. (The fabric should already filter, but a
      // grant rotation between fabric-deliver and harness-receive can
      // leave a stale message in flight.)
      const entry = this.opts.grants.grantForApp(serviceId, this.now());
      if (!entry) return;
      const peerPub = null; // we don't know peer pubkey from the fabric callback;
      // but we DO know the peer FQDN, and the grant lists FQDNs.
      void peerPub;
      const lower = msg.fromPod.toLowerCase();
      const inDomains = entry.grant.serverDomains.some(
        (d) => d.toLowerCase() === lower,
      );
      if (!inDomains) return;
      const wrapped: MultipodInboundMessage = {
        fromPod: lower,
        message: msg.message,
      };
      const w = waiters.shift();
      if (w) {
        w({ value: wrapped, done: false });
        return;
      }
      if (buffer.length < 1024) buffer.push(wrapped);
    });

    const iter: AsyncIterableIterator<MultipodInboundMessage> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      next(): Promise<IteratorResult<MultipodInboundMessage>> {
        if (buffer.length > 0) {
          const v = buffer.shift()!;
          return Promise.resolve({ value: v, done: false });
        }
        if (closed) {
          return Promise.resolve({
            value: undefined as unknown as MultipodInboundMessage,
            done: true,
          });
        }
        return new Promise((res) => waiters.push(res));
      },
      async return(): Promise<IteratorResult<MultipodInboundMessage>> {
        closed = true;
        unsub();
        while (waiters.length > 0) {
          waiters.shift()!({
            value: undefined as unknown as MultipodInboundMessage,
            done: true,
          });
        }
        return {
          value: undefined as unknown as MultipodInboundMessage,
          done: true,
        };
      },
    };
    return iter;
  }

  /**
   * Throws when the peer isn't authorized under the serviceId's current
   * grant. The thrown error is intentionally bland so apps don't get
   * a side-channel into other apps' grants ("does grant X cover pod
   * Y?" → if yes, no error; if no, "peer not entitled" — the message
   * itself is the same shape regardless).
   */
  private assertPeerEntitled(podCanonical: string, serviceId: string): void {
    const lower = podCanonical.toLowerCase();
    if (lower === this.opts.myPodCanonical.toLowerCase()) {
      throw new Error("peer not entitled");
    }
    const entry = this.opts.grants.grantForApp(serviceId, this.now());
    if (!entry) throw new Error("peer not entitled");
    const grant = entry.grant;
    if (!serviceGrantAuthorizesPod(grant, this.opts.myPodPubKey)) {
      throw new Error("peer not entitled");
    }
    const inDomains = grant.serverDomains.some(
      (d) => d.toLowerCase() === lower,
    );
    if (!inDomains) throw new Error("peer not entitled");
    if (!serviceGrantActiveAt(grant, this.now())) {
      throw new Error("peer not entitled");
    }
  }
}

/**
 * Convenience helper: an in-memory `AppGrantState` for tests + as the
 * default seam in early production wiring. Production should swap in a
 * file-backed implementation once the .com poll lands.
 */
export class InMemoryAppGrantState implements AppGrantState {
  private byApp = new Map<string, AppGrantEntry>();

  set(serviceId: string, entry: AppGrantEntry): void {
    this.byApp.set(serviceId, entry);
  }

  remove(serviceId: string): void {
    this.byApp.delete(serviceId);
  }

  grantForApp(serviceId: string, now?: number): AppGrantEntry | null {
    const e = this.byApp.get(serviceId);
    if (!e) return null;
    const t = now ?? Date.now();
    if (!serviceGrantActiveAt(e.grant, t)) return null;
    return e;
  }
}

/**
 * Pull a bare FQDN out of a URL. Accepts `host`, `host/path`, and full
 * `https://host[:port]/path`. Returns null on anything pathological.
 */
function parseFqdn(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  let rest = s;
  const proto = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (proto) rest = rest.slice(proto[0].length);
  const slash = rest.indexOf("/");
  let host = slash === -1 ? rest : rest.slice(0, slash);
  const at = host.indexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  host = host.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}
