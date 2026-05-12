/**
 * Sibling-sync connection — runtime-agnostic state machine for the
 * persistent cert-sync channel (#86).
 *
 * Sits on top of an opaque duplex transport that delivers binary
 * messages. Drives:
 *
 *   1. SYNC_HELLO exchange with mutual auth. Each side presents an
 *      IRK-signed PodIdentityBinding identifying its pod identity, and
 *      a challenge nonce + STK signature over the peer's challenge.
 *      We accept only peers that:
 *      - present a binding whose IRK signature verifies against the
 *        user's known IRK pubkey (looked up via injected callback);
 *      - sign our challenge with the same pod identity key the binding
 *        declares (a captured binding alone can't impersonate);
 *      - are NOT on the revocation list (consulted via injected hook).
 *
 *   2. Continuous CertSyncOffer (inventory) + PullRequest + PushCert
 *      cycle. Either side can offer; either side may pull; pushes are
 *      verified against the user's IRK pubkey and applied to the local
 *      store iff fresher than the current copy (issuedAt strictly
 *      greater wins).
 *
 *   3. Watchdog timers for hello + inventory cadence. The transport's
 *      ping/pong is the wire-level keepalive; this layer schedules
 *      periodic inventory re-broadcasts.
 *
 * The connection does NOT manage the underlying WebSocket. The client
 * + server modules wire `ws` (or an in-memory pair for tests) into the
 * transport interface here.
 */

import {
  appGrantId,
  ed,
  signPodIdentityBinding,
  verifyAppGrant,
  verifyPodIdentityBinding,
  type AppGrant,
  type Bytes,
  type Keypair,
  type PodIdentityBinding,
} from "@flagship/protocol";
import {
  decodeSyncFrame,
  encodeSyncFrame,
  syncHelloChallenge,
  SYNC_FRAME_HELLO,
  SYNC_FRAME_OFFER,
  SYNC_FRAME_PULL,
  SYNC_FRAME_PUSH,
  SYNC_FRAME_NOOP,
  type CertInventoryEntry,
  type PushCertPayload,
  type SyncFrame,
  type SyncHelloPayload,
} from "./syncFrames.js";

export interface SyncTransport {
  send(data: Uint8Array): void;
  close(): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  readonly isOpen: boolean;
}

/** What the connection reads + writes against the local pod's grant store. */
export interface AppGrantStore {
  /** Return every active (or expired-but-known) grant + signature. */
  list(): Array<{ grant: AppGrant; signature: Bytes }>;
  /** Lookup a grant by its grantId; null if unknown. */
  byGrantId(grantId: string): { grant: AppGrant; signature: Bytes } | null;
  /**
   * Apply a fresher grant. Implementations MUST drop the incoming
   * grant when an existing one with the same grantId has a higher
   * issuedAt, OR when the grant has an appCanonical (+ optional
   * appInstanceId) where the existing entry is fresher. This is the
   * fresher-cert-wins primitive.
   */
  applyIfFresher(args: { grant: AppGrant; signature: Bytes }): boolean;
}

/** Per-user IRK lookup (injected; tests supply a static map). */
export type IrkPubKeyLookup = (username: string) => Promise<Bytes | null>;

/**
 * Per-user revocation lookup. Returns the set of revoked grantIds for
 * a username, or `null` when the lookup itself failed (network drop,
 * etc.). The connection FAILS CLOSED on null per the security
 * requirement.
 */
export type SyncRevocationLookup = (
  username: string,
) => Promise<Set<string> | null>;

export interface SyncConnectionOptions {
  socket: SyncTransport;
  /** This pod's canonical FQDN. Used as the binding's serverDomain. */
  myServerDomain: string;
  /** This pod's identity (STK) keypair. */
  myIdentity: Keypair;
  /** Username — present in the binding and used for the IRK lookup. */
  username: string;
  /** My pre-signed binding (or the raw fields + a signer to make one fresh). */
  myBinding: PodIdentityBinding;
  /** IRK signature over canonicalPodIdentityBinding(myBinding). */
  myBindingSignature: Bytes;
  /** Resolve the user's IRK pubkey. */
  lookupIrk: IrkPubKeyLookup;
  /** Pull the user's revocation set (TTL-cached upstream). */
  revocations: SyncRevocationLookup;
  /** Local grant store. */
  store: AppGrantStore;
  /**
   * Cadence for emitting inventory frames after the handshake. Default
   * 5 minutes. Set 0 to disable periodic inventory (tests).
   */
  inventoryIntervalMs?: number;
  /** Test seam — random bytes for the challenge nonce. */
  randomChallenge?: () => Uint8Array;
  /** Test seam — wall clock. */
  now?: () => number;
  /** Test seam — periodic-timer factory. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Fires once the mutual hello + cert verifies. */
  onReady?: (args: { peerIdentityPubKey: Bytes; peerDomain: string }) => void;
  /** Fires when the connection closes for any reason. */
  onClose?: (args: { reason?: string }) => void;
  /**
   * Hook for tests/observability — fires every time a fresh peer push
   * is accepted into the local store.
   */
  onPushApplied?: (args: { grantId: string; appCanonical: string }) => void;
  /**
   * Hook fires every time a peer's hello is REJECTED for any reason.
   * The wire response is always a close — this hook lets tests assert
   * which fence rejected.
   */
  onAuthFailure?: (args: { reason: string }) => void;
}

export interface SyncConnection {
  ready(): Promise<void>;
  /** Peer's domain (post-handshake; null pre-hello). */
  peerDomain(): string | null;
  /** Peer's identity pubkey (post-handshake; null pre-hello). */
  peerIdentityPubKey(): Bytes | null;
  /**
   * Re-broadcast our inventory NOW. Called by the runtime on
   * capability change so peers learn immediately rather than at the
   * next 5-min tick.
   */
  pushInventory(): void;
  close(reason?: string): void;
}

export function startSyncConnection(opts: SyncConnectionOptions): SyncConnection {
  const random = opts.randomChallenge ?? defaultRandom;
  const now = opts.now ?? (() => Date.now());
  const setIntervalFn = opts.setIntervalImpl ?? setInterval;
  const clearIntervalFn = opts.clearIntervalImpl ?? clearInterval;
  const inventoryIntervalMs = opts.inventoryIntervalMs ?? 5 * 60_000;

  const myChallenge = random();
  let peerChallenge: Bytes | null = null;
  let peerDomain: string | null = null;
  let peerIdentityPub: Bytes | null = null;
  let sentResponseHello = false;
  let peerVerified = false;
  let helloSent = false;
  let closed = false;
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let inventoryTimer: ReturnType<typeof setInterval> | null = null;

  function send(frame: SyncFrame): void {
    if (!opts.socket.isOpen || closed) return;
    try {
      opts.socket.send(encodeSyncFrame(frame));
    } catch {
      close("send-error");
    }
  }

  function sendHello(): void {
    if (helloSent && !peerChallenge) return; // initial hello already on the wire
    const challengeResponseSignatureHex = peerChallenge
      ? bytesToHex(
          ed.sign(
            syncHelloChallenge({
              peerDomain: opts.myServerDomain,
              myDomain: peerDomain ?? "",
              challengeHex: bytesToHex(peerChallenge),
            }),
            opts.myIdentity.privateKey,
          ),
        )
      : undefined;
    const p: SyncHelloPayload = {
      protocolVersion: 1,
      username: opts.username,
      podIdentityPubKeyHex: bytesToHex(opts.myBinding.podIdentityPubKey),
      serverDomain: opts.myBinding.serverDomain,
      registeredAt: opts.myBinding.registeredAt,
      bindingSignatureHex: bytesToHex(opts.myBindingSignature),
      challengeHex: bytesToHex(myChallenge),
      ...(challengeResponseSignatureHex ? { challengeResponseSignatureHex } : {}),
    };
    send({ type: SYNC_FRAME_HELLO, payload: p });
    helloSent = true;
    if (challengeResponseSignatureHex) sentResponseHello = true;
  }

  function close(reason?: string): void {
    if (closed) return;
    closed = true;
    if (inventoryTimer !== null) {
      clearIntervalFn(inventoryTimer);
      inventoryTimer = null;
    }
    try {
      opts.socket.close();
    } catch {
      /* swallow */
    }
    opts.onClose?.({ reason: reason ?? undefined });
    if (!peerVerified) {
      rejectReady(new Error(reason ?? "closed"));
    }
  }

  function pushInventory(): void {
    if (!peerVerified) return;
    const inv = makeInventory(opts.store);
    send({ type: SYNC_FRAME_OFFER, payload: { inventory: inv } });
  }

  async function onHello(p: SyncHelloPayload): Promise<void> {
    if (peerVerified) {
      // Late hello after we're already up — ignore (the watchdog
      // wouldn't normally send one; treat as protocol noise).
      return;
    }
    // (1) Identity lookup — refuse unknown / different-user peers.
    if (p.username !== opts.username) {
      authFail("peer username mismatches our user");
      return;
    }
    const irkPub = await opts.lookupIrk(p.username);
    if (!irkPub) {
      authFail("user IRK not known");
      return;
    }
    // (2) Reconstruct the binding from the hello and verify the IRK sig.
    let podIdPub: Bytes;
    try {
      podIdPub = hexToBytes(p.podIdentityPubKeyHex);
    } catch {
      authFail("podIdentityPubKey not hex");
      return;
    }
    const binding: PodIdentityBinding = {
      username: p.username,
      podIdentityPubKey: podIdPub,
      serverDomain: p.serverDomain,
      registeredAt: p.registeredAt,
    };
    let bindingSig: Bytes;
    try {
      bindingSig = hexToBytes(p.bindingSignatureHex);
    } catch {
      authFail("binding signature not hex");
      return;
    }
    if (!verifyPodIdentityBinding(binding, bindingSig, irkPub)) {
      authFail("binding signature failed IRK verification");
      return;
    }
    // (3) Revocation list — fail closed on lookup failure.
    const revoked = await opts.revocations(p.username);
    if (revoked === null) {
      authFail("revocation lookup failed");
      return;
    }
    // If the peer's pod-identity has been independently revoked
    // (modeled as the hex of the identity pubkey being in the user's
    // revocation set), refuse.
    if (revoked.has(p.podIdentityPubKeyHex)) {
      authFail("peer pod identity is revoked");
      return;
    }
    // (4) Bind the peer state, then sign their challenge in a return
    //     hello (if we haven't already).
    peerDomain = p.serverDomain;
    peerIdentityPub = podIdPub;
    try {
      peerChallenge = hexToBytes(p.challengeHex);
    } catch {
      authFail("peer challenge not hex");
      return;
    }
    if (!sentResponseHello) sendHello();

    // (5) If THIS hello carries a challenge response, verify it.
    if (p.challengeResponseSignatureHex) {
      let sig: Bytes;
      try {
        sig = hexToBytes(p.challengeResponseSignatureHex);
      } catch {
        authFail("response signature not hex");
        return;
      }
      const expected = syncHelloChallenge({
        peerDomain: p.serverDomain,
        myDomain: opts.myServerDomain,
        challengeHex: bytesToHex(myChallenge),
      });
      let ok = false;
      try {
        ok = ed.verify(sig, expected, podIdPub);
      } catch {
        ok = false;
      }
      if (!ok) {
        authFail("peer signature failed verification");
        return;
      }
      peerVerified = true;
      opts.onReady?.({
        peerIdentityPubKey: podIdPub,
        peerDomain: p.serverDomain,
      });
      resolveReady();
      pushInventory();
      // Schedule periodic re-broadcast.
      if (inventoryIntervalMs > 0) {
        inventoryTimer = setIntervalFn(() => {
          if (closed) return;
          pushInventory();
        }, inventoryIntervalMs);
        (inventoryTimer as { unref?: () => void }).unref?.();
      }
    }
  }

  function authFail(reason: string): void {
    opts.onAuthFailure?.({ reason });
    close(reason);
  }

  async function onOffer(inventory: CertInventoryEntry[]): Promise<void> {
    if (!peerVerified) return;
    // Recipient compares against its local store and replies with a
    // PullRequest for grants it lacks OR whose stored copy is older.
    const want: string[] = [];
    for (const e of inventory) {
      const local = opts.store.byGrantId(e.grantId);
      if (!local) {
        want.push(e.grantId);
        continue;
      }
      if (e.issuedAt > local.grant.issuedAt) {
        want.push(e.grantId);
      }
    }
    if (want.length > 0) {
      send({ type: SYNC_FRAME_PULL, payload: { grantIds: want } });
    }
  }

  async function onPull(grantIds: string[]): Promise<void> {
    if (!peerVerified) return;
    for (const id of grantIds) {
      const e = opts.store.byGrantId(id);
      if (!e) continue;
      const payload: PushCertPayload = {
        grant: {
          grantId: e.grant.grantId,
          username: e.grant.username,
          appCanonical: e.grant.appCanonical,
          serverDomains: e.grant.serverDomains,
          serverIdentitiesHex: e.grant.serverIdentities.map(bytesToHex),
          routes: e.grant.routes.map((r) => ({ url: r.url, scope: r.scope })),
          issuedAt: e.grant.issuedAt,
          expiresAt: e.grant.expiresAt,
          ...(e.grant.appInstanceId !== undefined
            ? { appInstanceId: e.grant.appInstanceId }
            : {}),
        },
        signatureHex: bytesToHex(e.signature),
      };
      send({ type: SYNC_FRAME_PUSH, payload });
    }
  }

  async function onPush(p: PushCertPayload): Promise<void> {
    if (!peerVerified) return;
    if (p.grant.username !== opts.username) return; // ignore cross-user
    // Don't apply expired pushes — they can't ever be useful and they
    // could blank an active local copy via a fresher-but-already-dead
    // issuedAt. The fresher-cert check below would already reject most
    // staleness; this is the explicit guard.
    if (p.grant.expiresAt <= now()) return;
    let irkPub: Bytes | null;
    try {
      irkPub = await opts.lookupIrk(p.grant.username);
    } catch {
      irkPub = null;
    }
    if (!irkPub) return;
    const revoked = await opts.revocations(p.grant.username);
    if (revoked && revoked.has(p.grant.grantId)) return;
    // Inflate wire → AppGrant.
    let grant: AppGrant;
    try {
      grant = {
        grantId: p.grant.grantId,
        username: p.grant.username,
        appCanonical: p.grant.appCanonical,
        serverDomains: p.grant.serverDomains,
        serverIdentities: p.grant.serverIdentitiesHex.map(hexToBytes),
        routes: p.grant.routes,
        issuedAt: p.grant.issuedAt,
        expiresAt: p.grant.expiresAt,
        ...(p.grant.appInstanceId !== undefined
          ? { appInstanceId: p.grant.appInstanceId }
          : {}),
      };
    } catch {
      return;
    }
    let sig: Bytes;
    try {
      sig = hexToBytes(p.signatureHex);
    } catch {
      return;
    }
    if (!verifyAppGrant(grant, sig, irkPub)) return;
    const applied = opts.store.applyIfFresher({ grant, signature: sig });
    if (applied) {
      opts.onPushApplied?.({
        grantId: grant.grantId,
        appCanonical: grant.appCanonical,
      });
    }
  }

  async function onIncoming(buf: Uint8Array): Promise<void> {
    if (closed) return;
    const r = decodeSyncFrame(buf);
    if (r.kind === "error") {
      close("decode-error");
      return;
    }
    const f = r.frame;
    if (f.type === SYNC_FRAME_HELLO) {
      await onHello(f.payload);
      return;
    }
    if (!peerVerified) {
      // Anything else before mutual auth completes is a protocol abuse.
      close("frame-before-hello");
      return;
    }
    if (f.type === SYNC_FRAME_OFFER) {
      await onOffer(f.payload.inventory);
      return;
    }
    if (f.type === SYNC_FRAME_PULL) {
      await onPull(f.payload.grantIds);
      return;
    }
    if (f.type === SYNC_FRAME_PUSH) {
      await onPush(f.payload);
      return;
    }
    if (f.type === SYNC_FRAME_NOOP) {
      return;
    }
  }

  opts.socket.onMessage((d) => void onIncoming(d));
  opts.socket.onClose(() => close("transport-closed"));
  opts.socket.onError(() => close("transport-error"));

  // Kick off — both peers send hello immediately. The state machine is
  // symmetric (initiator vs responder is just who opens the WS).
  sendHello();

  return {
    ready: () => readyPromise,
    peerDomain: () => peerDomain,
    peerIdentityPubKey: () => peerIdentityPub,
    pushInventory,
    close: (reason?: string) => close(reason),
  };
}

/**
 * Build an inventory snapshot from a store. Exported so tests can
 * assert what the connection would advertise without driving a full
 * handshake.
 */
export function makeInventory(store: AppGrantStore): CertInventoryEntry[] {
  return store
    .list()
    .filter((e) => e.grant.expiresAt > 0)
    .map((e) => {
      const entry: CertInventoryEntry = {
        grantId: e.grant.grantId,
        appCanonical: e.grant.appCanonical,
        issuedAt: e.grant.issuedAt,
        expiresAt: e.grant.expiresAt,
      };
      if (e.grant.appInstanceId !== undefined) entry.appInstanceId = e.grant.appInstanceId;
      return entry;
    });
}

/**
 * Tiny in-memory store for tests + as the default seam. Production
 * wires a file-backed implementation that survives daemon restart.
 */
export class InMemoryAppGrantStore implements AppGrantStore {
  private byId = new Map<string, { grant: AppGrant; signature: Bytes }>();
  private byApp = new Map<string, string>(); // appCanonical[#instance] → grantId

  put(entry: { grant: AppGrant; signature: Bytes }): void {
    this.byId.set(entry.grant.grantId, entry);
    this.byApp.set(appKey(entry.grant), entry.grant.grantId);
  }

  list(): Array<{ grant: AppGrant; signature: Bytes }> {
    return [...this.byId.values()];
  }
  byGrantId(grantId: string): { grant: AppGrant; signature: Bytes } | null {
    return this.byId.get(grantId) ?? null;
  }
  applyIfFresher(args: { grant: AppGrant; signature: Bytes }): boolean {
    const existing = this.byId.get(args.grant.grantId);
    if (existing && existing.grant.issuedAt >= args.grant.issuedAt) return false;
    // Different grantId for same appKey — only adopt when fresher.
    const appKeyStr = appKey(args.grant);
    const competingId = this.byApp.get(appKeyStr);
    if (competingId && competingId !== args.grant.grantId) {
      const competing = this.byId.get(competingId);
      if (competing && competing.grant.issuedAt >= args.grant.issuedAt) return false;
    }
    this.byId.set(args.grant.grantId, args);
    this.byApp.set(appKeyStr, args.grant.grantId);
    return true;
  }
  remove(grantId: string): void {
    const e = this.byId.get(grantId);
    if (!e) return;
    this.byId.delete(grantId);
    if (this.byApp.get(appKey(e.grant)) === grantId) {
      this.byApp.delete(appKey(e.grant));
    }
  }
}

function appKey(g: AppGrant): string {
  return g.appInstanceId ? `${g.appCanonical}#${g.appInstanceId}` : g.appCanonical;
}

/**
 * Convenience helper: build a self-signed PodIdentityBinding + IRK
 * signature for tests. Production callers load the binding from disk
 * (it was created at registration).
 */
export function mintTestBinding(args: {
  irk: Keypair;
  username: string;
  podIdentityPubKey: Bytes;
  serverDomain: string;
  registeredAt?: number;
}): { binding: PodIdentityBinding; signature: Bytes } {
  const binding: PodIdentityBinding = {
    username: args.username,
    podIdentityPubKey: args.podIdentityPubKey,
    serverDomain: args.serverDomain,
    registeredAt: args.registeredAt ?? Date.now(),
  };
  const signature = signPodIdentityBinding(binding, args.irk);
  return { binding, signature };
}

function defaultRandom(): Bytes {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Bytes {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

/** Wire a `ws` WebSocket as a SyncTransport. */
export function wrapWsAsSyncTransport(ws: {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(ev: "message", cb: (data: Buffer) => void): unknown;
  on(ev: "close", cb: () => void): unknown;
  on(ev: "error", cb: (err: unknown) => void): unknown;
  readyState: number;
  OPEN: number;
}): SyncTransport {
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
 * Build a pair of in-memory transports for tests.
 */
export function memorySyncTransportPair(): [SyncTransport, SyncTransport] {
  let aOpen = true;
  let bOpen = true;
  const aL = {
    msg: [] as Array<(d: Uint8Array) => void>,
    close: [] as Array<() => void>,
    err: [] as Array<(e: unknown) => void>,
  };
  const bL = {
    msg: [] as Array<(d: Uint8Array) => void>,
    close: [] as Array<() => void>,
    err: [] as Array<(e: unknown) => void>,
  };
  const a: SyncTransport = {
    send(d) {
      if (!aOpen) return;
      const copy = new Uint8Array(d);
      queueMicrotask(() => {
        if (!bOpen) return;
        for (const l of bL.msg) l(copy);
      });
    },
    close() {
      if (!aOpen) return;
      aOpen = false;
      for (const l of aL.close) l();
      bOpen = false;
      queueMicrotask(() => {
        for (const l of bL.close) l();
      });
    },
    onMessage(cb) {
      aL.msg.push(cb);
    },
    onClose(cb) {
      aL.close.push(cb);
    },
    onError(cb) {
      aL.err.push(cb);
    },
    get isOpen() {
      return aOpen;
    },
  };
  const b: SyncTransport = {
    send(d) {
      if (!bOpen) return;
      const copy = new Uint8Array(d);
      queueMicrotask(() => {
        if (!aOpen) return;
        for (const l of aL.msg) l(copy);
      });
    },
    close() {
      if (!bOpen) return;
      bOpen = false;
      for (const l of bL.close) l();
      aOpen = false;
      queueMicrotask(() => {
        for (const l of aL.close) l();
      });
    },
    onMessage(cb) {
      bL.msg.push(cb);
    },
    onClose(cb) {
      bL.close.push(cb);
    },
    onError(cb) {
      bL.err.push(cb);
    },
    get isOpen() {
      return bOpen;
    },
  };
  return [a, b];
}

void appGrantId; // referenced for future grantId verification at apply time
