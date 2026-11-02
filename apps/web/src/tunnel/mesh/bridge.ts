/**
 * Bridges between relays (relay-mesh.md §6): a WebSocket on `:8443` `/mesh`, mutually authenticated by relay-key
 * signatures over both nonces and both relay ids (§6.2; TLS ends at Fly's edge, so this is the authentication), JSON
 * control messages (§6.3) and a stream mux of v1 frames with mandatory per-stream credit (§6.4). The relay with the
 * bytewise-smaller relayId dials; the other only accepts. One hop only: a bridged OPEN carries `hop:1` and the holder
 * never forwards it on.
 *
 * Wire: text messages are JSON control (≤ 1 MiB); binary messages are exactly one frame each: OPEN (payload JSON
 * `{sni, kind, hop:1}`), DATA, CLOSE, and STREAM_CREDIT 0x06 (`u32 BE` bytes > 0, `stream-credit-v1`). Dialer-opened
 * streams are odd, acceptor-opened even.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import type { Duplex as NetDuplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  checkBridgeAuth,
  MESH_BACKOFF_MAX_MS,
  MESH_BACKOFF_MIN_MS,
  MESH_CONTROL_MAX_BYTES,
  MESH_DIAL_TIMEOUT_MS,
  MESH_HANDSHAKE_STEP_MS,
  MESH_PEER_CUT_MS,
  MESH_PEER_DOWN_MS,
  MESH_PEER_MAX_QUEUED_BYTES,
  MESH_PEER_MAX_STREAMS,
  MESH_PEER_OPEN_BURST,
  MESH_PEER_OPEN_RATE,
  MESH_PEER_OVER_LIMIT_MS,
  MESH_PING_MS,
  MESH_STREAM_INITIAL_WINDOW,
  signRelayMeshRecord,
  type BridgeRefusal,
  type BridgeRole,
  type MeshAuth,
  type MeshCheckContext,
  type MeshHello,
  type RelayBlessing,
} from "@flagship/protocol";
import { decodeFrame, encodeFrame, FRAME_CLOSE, FRAME_CLOSE_REMOTE, FRAME_DATA, FRAME_OPEN, type Frame } from "@flagship/tunnel-protocol";

export const MESH_PATH = "/mesh";
/** `stream-credit-v1` (relay-transport.md §1): mandatory on bridges. */
export const FRAME_STREAM_CREDIT = 0x06;
/** Largest DATA payload a bridge stream sends in one frame. */
const MAX_DATA_CHUNK = 64 * 1024;

export type BridgeStreamKind = "tls" | "pb-mail";
export type RefuseCode = "not-holder" | "apps-off" | "revoked" | "busy" | "stale" | "hop";

// ── token bucket ──────────────────────────────────────────────────────────

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ── frames on a bridge ────────────────────────────────────────────────────

function creditFrame(streamId: number, bytes: number): Uint8Array {
  const out = new Uint8Array(13);
  const v = new DataView(out.buffer);
  v.setUint32(0, streamId);
  out[4] = FRAME_STREAM_CREDIT;
  v.setUint32(5, 4);
  v.setUint32(9, bytes);
  return out;
}

type BridgeFrame = Frame | { streamId: number; type: typeof FRAME_STREAM_CREDIT; credit: number };

function decodeBridgeFrame(bytes: Uint8Array): BridgeFrame | null {
  if (bytes.byteLength >= 9 && bytes[4] === FRAME_STREAM_CREDIT) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength !== 13 || v.getUint32(5) !== 4) return null;
    const credit = v.getUint32(9);
    return credit > 0 ? { streamId: v.getUint32(0), type: FRAME_STREAM_CREDIT, credit } : null;
  }
  const r = decodeFrame(bytes);
  if (r.kind !== "ok" || r.consumed !== bytes.byteLength) return null;
  return r.frame;
}

// ── one stream ────────────────────────────────────────────────────────────

/**
 * A bridged stream as a Node duplex: what the entry relay pipes a visitor into, and what the holder hands its SNI
 * router as the "visitor" socket. Writes wait for credit (so `writableLength` grows and the source is paused, as for a
 * box tunnel); reads return credit as the reader drains them.
 */
export class BridgeStream extends Duplex {
  private sendCredit = MESH_STREAM_INITIAL_WINDOW;
  /** Bytes the peer may still send before it needs more credit. */
  private recvAllowance = MESH_STREAM_INITIAL_WINDOW;
  private pushedSinceCredit = 0;
  private pending: { chunk: Uint8Array; cb: (e?: Error | null) => void } | null = null;
  private remoteClosed = false;
  /** Set when the peer refused the stream (§6.4) before closing it. */
  refused: RefuseCode | null = null;
  /** Bytes received from the peer. */
  received = 0;

  constructor(
    readonly id: number,
    private readonly peer: BridgePeer,
    readonly sni: string,
    readonly kind: BridgeStreamKind,
  ) {
    super({ allowHalfOpen: false, readableHighWaterMark: 64 * 1024 });
  }

  // Socket-like no-ops the SNI router may call.
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.pending = { chunk: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), cb };
    this.flush();
  }

  /** v1 CLOSE ends the whole stream: after sending it, nothing more is read either. */
  override _final(cb: (e?: Error | null) => void): void {
    const wasOpen = !this.remoteClosed;
    if (wasOpen) this.peer.sendBinary(encodeFrame({ streamId: this.id, type: FRAME_CLOSE, payload: new Uint8Array(0) }));
    this.remoteClosed = true;
    this.peer.forget(this.id);
    if (wasOpen) this.push(null);
    cb();
  }

  override _read(): void {
    if (this.pushedSinceCredit >= MESH_STREAM_INITIAL_WINDOW / 4 || (this.pushedSinceCredit > 0 && this.readableLength === 0)) {
      const n = this.pushedSinceCredit;
      this.pushedSinceCredit = 0;
      this.recvAllowance += n;
      if (!this.remoteClosed) this.peer.sendBinary(creditFrame(this.id, n));
    }
  }

  override _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    if (!this.remoteClosed) {
      this.remoteClosed = true;
      this.peer.sendBinary(encodeFrame({ streamId: this.id, type: FRAME_CLOSE, payload: new Uint8Array(0) }));
    }
    this.peer.forget(this.id);
    const p = this.pending;
    this.pending = null;
    p?.cb(err ?? new Error("stream closed"));
    cb(null);
  }

  /** Try to send what waits; called again on credit and when the bridge's socket drains. */
  flush(): void {
    const p = this.pending;
    if (!p || this.remoteClosed) return;
    while (p.chunk.byteLength > 0 && this.sendCredit > 0) {
      if (this.peer.queuedBytes() > MESH_PEER_MAX_QUEUED_BYTES) {
        this.peer.whenDrained(() => this.flush());
        return;
      }
      const n = Math.min(p.chunk.byteLength, this.sendCredit, MAX_DATA_CHUNK);
      this.peer.sendBinary(encodeFrame({ streamId: this.id, type: FRAME_DATA, payload: p.chunk.subarray(0, n) }));
      this.sendCredit -= n;
      p.chunk = p.chunk.subarray(n);
    }
    if (p.chunk.byteLength === 0) {
      this.pending = null;
      p.cb();
    }
  }

  /** @internal */ onCredit(n: number): void {
    this.sendCredit += n;
    this.flush();
  }

  /** @internal */ onData(bytes: Uint8Array): boolean {
    if (bytes.byteLength > this.recvAllowance) return false;
    this.recvAllowance -= bytes.byteLength;
    this.pushedSinceCredit += bytes.byteLength;
    this.received += bytes.byteLength;
    this.push(Buffer.from(bytes));
    return true;
  }

  /** @internal */ onRemoteClose(): void {
    if (this.remoteClosed) return;
    this.remoteClosed = true;
    this.peer.forget(this.id);
    this.push(null);
    // A writer still waiting for credit will never get it.
    const p = this.pending;
    this.pending = null;
    p?.cb(new Error("stream closed by peer"));
    if (!this.writableEnded) this.end();
  }
}

// ── one authenticated bridge ──────────────────────────────────────────────

export interface BridgeHandler {
  /** A JSON control message from an authenticated peer (anything but stream control). */
  onControl(peer: BridgePeer, msg: Record<string, unknown>): void;
  /** The peer opened a stream (`hop:1` checked, limits applied). Refuse with `stream.peer.refuse`. */
  onOpen(peer: BridgePeer, stream: BridgeStream): void;
  onUp(peer: BridgePeer): void;
  onDown(peer: BridgePeer, why: string): void;
}

export interface BridgePeerStats {
  relayId: string;
  role: BridgeRole;
  upSinceMs: number;
  streams: number;
  opens: number;
  opensIn: number;
  refusals: Record<string, number>;
  rejected: number;
  queuedBytes: number;
  lastHeardMs: number;
}

export class BridgePeer {
  private readonly streams = new Map<number, BridgeStream>();
  private nextId: number;
  private queued = 0;
  private drainWaiters: Array<() => void> = [];
  private readonly opens: TokenBucket;
  private overSince: number | null = null;
  private lastHeard: number;
  private readonly upAt: number;
  private ping: ReturnType<typeof setInterval> | null = null;
  readonly refusals: Record<string, number> = {};
  /** Items or messages from this peer that failed a check (`/api/stats` `mesh.peers[].rejected`). */
  rejected = 0;
  opensOut = 0;
  opensIn = 0;
  /** Set by the node: the last log sequence sent to this peer, and when the last head was sent. */
  lastLogSent = 0;
  lastHeadSentAt = 0;
  /** The peer's last `load` (rebalancing, §10.2). */
  load: { tunnels: number; capacity: number; draining: boolean; at: number } | null = null;
  closed = false;

  constructor(
    readonly relayId: string,
    readonly role: BridgeRole,
    readonly blessing: RelayBlessing,
    private readonly ws: WebSocket,
    private readonly handler: BridgeHandler,
    private readonly now: () => number,
    private readonly onCut: (relayId: string) => void,
    timings: { pingMs?: number; downMs?: number } = {},
  ) {
    this.nextId = role === "client" ? 1 : 2;
    this.opens = new TokenBucket(MESH_PEER_OPEN_RATE, MESH_PEER_OPEN_BURST, now);
    this.lastHeard = now();
    this.upAt = now();
    ws.on("message", (raw: Buffer, isBinary: boolean) => this.onMessage(raw, isBinary));
    ws.on("pong", () => (this.lastHeard = this.now()));
    ws.on("close", (code, reason) => this.onClosed(`${code} ${reason.toString()}`));
    ws.on("error", () => undefined);
    const pingMs = timings.pingMs ?? MESH_PING_MS;
    const downMs = timings.downMs ?? MESH_PEER_DOWN_MS;
    this.ping = setInterval(() => {
      if (this.now() - this.lastHeard >= downMs) {
        this.ws.terminate();
        return;
      }
      if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, pingMs);
    this.ping.unref?.();
  }

  get live(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: Record<string, unknown>): void {
    if (!this.live) return;
    this.ws.send(JSON.stringify(msg));
  }

  sendBinary(bytes: Uint8Array): void {
    if (!this.live) return;
    this.queued += bytes.byteLength;
    this.ws.send(bytes, { binary: true }, () => {
      this.queued -= bytes.byteLength;
      if (this.queued <= MESH_PEER_MAX_QUEUED_BYTES / 2 && this.drainWaiters.length > 0) {
        const w = this.drainWaiters;
        this.drainWaiters = [];
        for (const fn of w) fn();
      }
    });
  }

  queuedBytes(): number {
    return this.queued;
  }

  whenDrained(fn: () => void): void {
    this.drainWaiters.push(fn);
  }

  /** Open a stream to the peer (the entry side). Null: the bridge is down or full. */
  open(sni: string, kind: BridgeStreamKind, extra: Record<string, unknown> = {}): BridgeStream | null {
    if (!this.live || this.streams.size >= MESH_PEER_MAX_STREAMS) return null;
    let id = this.nextId;
    for (let i = 0; this.streams.has(id) && i < MESH_PEER_MAX_STREAMS; i++) id = this.advance(id);
    this.nextId = this.advance(id);
    const s = new BridgeStream(id, this, sni, kind);
    this.streams.set(id, s);
    this.opensOut++;
    this.sendBinary(encodeFrame({ streamId: id, type: FRAME_OPEN, payload: new TextEncoder().encode(JSON.stringify({ sni, kind, hop: 1, ...extra })) }));
    return s;
  }

  /** The holder refuses a stream the peer opened (§6.4): `refuse`, then CLOSE. */
  refuse(stream: BridgeStream | number, code: RefuseCode): void {
    const id = typeof stream === "number" ? stream : stream.id;
    this.refusals[code] = (this.refusals[code] ?? 0) + 1;
    this.send({ type: "refuse", stream: id, code });
    const s = this.streams.get(id);
    if (s) s.destroy();
    else this.sendBinary(encodeFrame({ streamId: id, type: FRAME_CLOSE, payload: new Uint8Array(0) }));
  }

  /** @internal */ forget(id: number): void {
    this.streams.delete(id);
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason);
  }

  terminate(): void {
    this.ws.terminate();
  }

  streamCount(): number {
    return this.streams.size;
  }

  stats(): BridgePeerStats {
    return {
      relayId: this.relayId,
      role: this.role,
      upSinceMs: this.now() - this.upAt,
      streams: this.streams.size,
      opens: this.opensOut,
      opensIn: this.opensIn,
      refusals: { ...this.refusals },
      rejected: this.rejected,
      queuedBytes: this.queued,
      lastHeardMs: this.now() - this.lastHeard,
    };
  }

  /** Count a rate-limited request; a peer over its limit for 60 s straight is cut for 10 min (§11). */
  noteOverLimit(over: boolean): void {
    if (!over) {
      this.overSince = null;
      return;
    }
    const t = this.now();
    if (this.overSince === null) this.overSince = t;
    else if (t - this.overSince >= MESH_PEER_OVER_LIMIT_MS) {
      this.onCut(this.relayId);
      this.close(4429, "over-limit");
    }
  }

  /** A message that arrived before the bridge took the socket over. */
  replay(raw: Buffer, isBinary: boolean): void {
    this.onMessage(raw, isBinary);
  }

  private advance(id: number): number {
    const n = id + 2;
    return n > 0x7fffffff ? (this.role === "client" ? 1 : 2) : n;
  }

  private onMessage(raw: Buffer, isBinary: boolean): void {
    this.lastHeard = this.now();
    if (!isBinary) {
      if (raw.byteLength > MESH_CONTROL_MAX_BYTES) return this.close(1009, "control message too large");
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        this.rejected++;
        return;
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
        this.rejected++;
        return;
      }
      const m = msg as Record<string, unknown>;
      if (m.type === "refuse") {
        const s = typeof m.stream === "number" ? this.streams.get(m.stream) : undefined;
        if (s && typeof m.code === "string") s.refused = m.code as RefuseCode;
        return;
      }
      try {
        this.handler.onControl(this, m);
      } catch (e) {
        this.rejected++;
        console.warn(`[mesh-bridge] control handler failed for ${this.relayId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    const f = decodeBridgeFrame(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    if (!f) return this.close(1002, "one whole frame per binary message");
    if (f.type === FRAME_STREAM_CREDIT) {
      this.streams.get(f.streamId)?.onCredit((f as { credit: number }).credit);
      return;
    }
    const fr = f as Frame;
    if (fr.type === FRAME_OPEN) return this.onOpenFrame(fr);
    if (fr.type === FRAME_DATA) {
      const s = this.streams.get(fr.streamId);
      if (s && !s.onData(fr.payload)) {
        // Credit overrun: the peer broke stream-credit-v1 on this stream.
        this.rejected++;
        s.destroy();
      }
      return;
    }
    if (fr.type === FRAME_CLOSE || fr.type === FRAME_CLOSE_REMOTE) {
      this.streams.get(fr.streamId)?.onRemoteClose();
      return;
    }
    this.close(1002, "unexpected frame");
  }

  private onOpenFrame(f: Frame): void {
    const theirs = this.role === "client" ? f.streamId % 2 === 0 : f.streamId % 2 === 1;
    if (!theirs || f.streamId === 0 || this.streams.has(f.streamId)) return this.close(1002, "bad stream id");
    let o: { sni?: unknown; kind?: unknown; hop?: unknown; [k: string]: unknown };
    try {
      o = JSON.parse(new TextDecoder().decode(f.payload)) as typeof o;
    } catch {
      this.rejected++;
      return this.refuse(f.streamId, "hop");
    }
    if (o.hop !== 1) return this.refuse(f.streamId, "hop");
    const kind = o.kind === "pb-mail" ? "pb-mail" : o.kind === "tls" ? "tls" : null;
    if (typeof o.sni !== "string" || o.sni.length === 0 || o.sni.length > 253 || !kind) {
      this.rejected++;
      return this.refuse(f.streamId, "hop");
    }
    const allowed = this.opens.take() && this.streams.size < MESH_PEER_MAX_STREAMS;
    this.noteOverLimit(!allowed);
    if (!allowed) return this.refuse(f.streamId, "busy");
    const s = new BridgeStream(f.streamId, this, o.sni.toLowerCase(), kind);
    (s as BridgeStream & { openExtra?: Record<string, unknown> }).openExtra = o;
    this.streams.set(f.streamId, s);
    this.opensIn++;
    this.handler.onOpen(this, s);
  }

  private onClosed(why: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    for (const s of [...this.streams.values()]) s.onRemoteClose();
    this.streams.clear();
    const w = this.drainWaiters;
    this.drainWaiters = [];
    for (const fn of w) fn();
    this.handler.onDown(this, why);
  }
}

// ── handshake (§6.2) ──────────────────────────────────────────────────────

export interface HandshakeContext {
  selfRelayId: string;
  /** Sign with the relay key. */
  sign(msg: Uint8Array): Uint8Array;
  /** This relay's current blessing (null after a restart while `.com` is down). */
  blessing(): RelayBlessing | null;
  heldBlessing(relayId: string): RelayBlessing | null;
  caKeys(): readonly string[];
  checkContext(): MeshCheckContext;
  now(): number;
}

const nonce = (): string => randomBytes(32).toString("hex");

function myAuth(ctx: HandshakeContext, role: BridgeRole, peer: string, serverNonce: string, clientNonce: string): MeshAuth {
  const at = ctx.now();
  const sig = signRelayMeshRecord("relay-bridge-auth", { role, signerRelayId: ctx.selfRelayId, peerRelayId: peer, serverNonce, clientNonce, at }, ctx.sign);
  return { type: "mesh-auth", v: 1, relayId: ctx.selfRelayId, peer, nonce: role === "server" ? serverNonce : clientNonce, at, blessing: ctx.blessing(), sig };
}

/**
 * Messages that arrive while the handshake runs, attached the moment the socket exists: the acceptor's `mesh-hello`
 * can arrive in the same tick as the dialer's `open`, and the peer's first `sync` right behind its last auth message.
 * After the handshake the bridge takes over the socket with whatever is still queued.
 */
export class HandshakeQueue {
  private readonly queue: Array<{ raw: Buffer; isBinary: boolean }> = [];
  private waiter: ((m: { raw: Buffer; isBinary: boolean } | null) => void) | null = null;
  private closed = false;
  private readonly onMsg = (raw: Buffer, isBinary: boolean) => {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ raw, isBinary });
    } else this.queue.push({ raw, isBinary });
  };
  private readonly onClose = () => {
    this.closed = true;
    const w = this.waiter;
    this.waiter = null;
    w?.(null);
  };

  constructor(private readonly ws: WebSocket) {
    ws.on("message", this.onMsg);
    ws.on("close", this.onClose);
  }

  /** The next message as a JSON object, or null (closed, timed out, binary or not an object). */
  next(ms: number): Promise<Record<string, unknown> | null> {
    const parse = (m: { raw: Buffer; isBinary: boolean } | null): Record<string, unknown> | null => {
      if (!m || m.isBinary || m.raw.byteLength > MESH_CONTROL_MAX_BYTES) return null;
      try {
        const v = JSON.parse(m.raw.toString("utf8")) as unknown;
        return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const had = this.queue.shift();
    if (had) return Promise.resolve(parse(had));
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, ms);
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(parse(m));
      };
    });
  }

  /** Stop queueing; returns what is still queued, in order. */
  detach(): Array<{ raw: Buffer; isBinary: boolean }> {
    this.ws.off("message", this.onMsg);
    this.ws.off("close", this.onClose);
    return this.queue.splice(0);
  }
}

export type HandshakeResult = { ok: true; relayId: string; blessing: RelayBlessing; returnBlessing: boolean } | { ok: false; reason: BridgeRefusal | "timeout" };

/** The acceptor's side: `mesh-hello`, check the dialer's `mesh-auth`, answer with its own. */
export async function acceptorHandshake(ws: WebSocket, ctx: HandshakeContext, stepMs = MESH_HANDSHAKE_STEP_MS, q = new HandshakeQueue(ws)): Promise<HandshakeResult> {
  const ns = nonce();
  const hello: MeshHello = { type: "mesh-hello", v: 1, relayId: ctx.selfRelayId, nonce: ns, at: ctx.now() };
  ws.send(JSON.stringify(hello));
  const auth = (await q.next(stepMs)) as MeshAuth | null;
  if (!auth) return fail(ws, "timeout");
  const c = checkBridgeAuth({ auth, role: "client", selfRelayId: ctx.selfRelayId, selfNonce: ns, heldBlessing: auth.blessing === null ? ctx.heldBlessing(String(auth.relayId)) : null, caKeys: ctx.caKeys(), ctx: ctx.checkContext() });
  if (!c.ok) return fail(ws, c.reason);
  if (typeof auth.nonce !== "string" || !/^[0-9a-f]{64}$/.test(auth.nonce)) return fail(ws, "bad-signature");
  ws.send(JSON.stringify(myAuth(ctx, "server", auth.relayId, ns, auth.nonce)));
  return { ok: true, relayId: auth.relayId, blessing: c.blessing, returnBlessing: auth.blessing === null };
}

/** The dialer's side: wait for `mesh-hello` from the expected peer, send `mesh-auth`, check the acceptor's. */
export async function dialerHandshake(ws: WebSocket, expectPeer: string, ctx: HandshakeContext, stepMs = MESH_HANDSHAKE_STEP_MS, q = new HandshakeQueue(ws)): Promise<HandshakeResult> {
  const hello = (await q.next(stepMs)) as MeshHello | null;
  if (!hello || hello.type !== "mesh-hello" || hello.v !== 1) return fail(ws, "timeout");
  if (hello.relayId !== expectPeer) return fail(ws, "wrong-peer");
  if (typeof hello.nonce !== "string" || !/^[0-9a-f]{64}$/.test(hello.nonce)) return fail(ws, "wrong-peer");
  if (typeof hello.at !== "number" || Math.abs(hello.at - ctx.now()) > 60_000) return fail(ws, "stale");
  const nc = nonce();
  ws.send(JSON.stringify(myAuth(ctx, "client", expectPeer, hello.nonce, nc)));
  const auth = (await q.next(stepMs)) as MeshAuth | null;
  if (!auth) return fail(ws, "timeout");
  if (auth.nonce !== hello.nonce) return fail(ws, "bad-signature");
  const c = checkBridgeAuth({ auth, role: "server", selfRelayId: ctx.selfRelayId, selfNonce: nc, heldBlessing: auth.blessing === null ? ctx.heldBlessing(expectPeer) : null, caKeys: ctx.caKeys(), ctx: ctx.checkContext() });
  if (!c.ok) return fail(ws, c.reason);
  if (auth.relayId !== expectPeer) return fail(ws, "wrong-peer");
  return { ok: true, relayId: auth.relayId, blessing: c.blessing, returnBlessing: auth.blessing === null };
}

function fail(ws: WebSocket, reason: BridgeRefusal | "timeout"): HandshakeResult {
  if (ws.readyState === WebSocket.OPEN) ws.close(4401, reason);
  else ws.terminate();
  return { ok: false, reason };
}

// ── the manager: accept, dial, keep one bridge per peer ───────────────────

export interface BridgeManagerOptions extends HandshakeContext {
  handler: BridgeHandler;
  /** The peers to keep a bridge to (the directory's other relays, not revoked). */
  peers(): Array<{ relayId: string; tunnelHost: string }>;
  /** `wss://<tunnelHost>:8443/mesh` unless overridden (tests dial loopback). */
  peerUrl?(peer: { relayId: string; tunnelHost: string }): string;
  pingMs?: number;
  downMs?: number;
  log?: (m: string) => void;
}

export class BridgeManager {
  private readonly bridges = new Map<string, BridgePeer>();
  private readonly dialing = new Map<string, { timer: ReturnType<typeof setTimeout> | null; attempt: number; busy: boolean }>();
  private readonly cutUntil = new Map<string, number>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 2 * MESH_CONTROL_MAX_BYTES });
  private tick: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  readonly handshakeFailures: Record<string, number> = {};

  constructor(private readonly opts: BridgeManagerOptions) {}

  /** Mount `/mesh` on the HTTP server; returns the detach function. */
  attach(httpServer: HttpServer): () => void {
    const onUpgrade = (req: IncomingMessage, socket: NetDuplex, head: Buffer): void => {
      if (req.url !== MESH_PATH) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => void this.accept(ws));
    };
    httpServer.on("upgrade", onUpgrade);
    return () => httpServer.off("upgrade", onUpgrade);
  }

  start(everyMs = 2_000): void {
    this.reconcile();
    this.tick = setInterval(() => this.reconcile(), everyMs);
    this.tick.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    for (const d of this.dialing.values()) if (d.timer) clearTimeout(d.timer);
    for (const b of this.bridges.values()) b.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  peer(relayId: string): BridgePeer | null {
    const b = this.bridges.get(relayId);
    return b && b.live ? b : null;
  }

  live(): BridgePeer[] {
    return [...this.bridges.values()].filter((b) => b.live);
  }

  broadcast(msg: Record<string, unknown>, except?: string): void {
    for (const b of this.live()) if (b.relayId !== except) b.send(msg);
  }

  /** Close a peer's bridge (it was revoked: 4403). */
  drop(relayId: string, code: number, reason: string): void {
    this.bridges.get(relayId)?.close(code, reason);
  }

  /** Dial the peers this relay should dial and do not have a bridge to. */
  reconcile(): void {
    if (this.stopped) return;
    const want = this.opts.peers();
    const ids = new Set(want.map((p) => p.relayId));
    for (const [id, b] of this.bridges) if (!ids.has(id)) b.close(4403, "not-in-directory");
    for (const p of want) {
      if (this.opts.selfRelayId >= p.relayId) continue; // the smaller id dials
      if (this.peer(p.relayId)) continue;
      if ((this.cutUntil.get(p.relayId) ?? 0) > this.opts.now()) continue;
      const d = this.dialing.get(p.relayId) ?? { timer: null, attempt: 0, busy: false };
      this.dialing.set(p.relayId, d);
      if (d.busy || d.timer) continue;
      void this.dial(p, d);
    }
  }

  private async dial(p: { relayId: string; tunnelHost: string }, d: { timer: ReturnType<typeof setTimeout> | null; attempt: number; busy: boolean }): Promise<void> {
    d.busy = true;
    const url = this.opts.peerUrl ? this.opts.peerUrl(p) : `wss://${p.tunnelHost}:8443${MESH_PATH}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: MESH_DIAL_TIMEOUT_MS, maxPayload: 2 * MESH_CONTROL_MAX_BYTES });
    } catch {
      ws = null as unknown as WebSocket;
    }
    if (!ws) {
      d.busy = false;
      d.attempt++;
      d.timer = setTimeout(() => {
        d.timer = null;
        this.reconcile();
      }, MESH_BACKOFF_MAX_MS);
      d.timer.unref?.();
      return;
    }
    ws.on("error", () => undefined);
    const q = new HandshakeQueue(ws);
    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("close", () => resolve(false));
      ws.once("error", () => resolve(false));
    });
    let ok = false;
    if (opened && !this.stopped) {
      const r = await dialerHandshake(ws, p.relayId, this.opts, MESH_HANDSHAKE_STEP_MS, q);
      if (r.ok) {
        ok = true;
        this.up(ws, r.relayId, "client", r.blessing, r.returnBlessing, q.detach());
      } else {
        this.handshakeFailures[r.reason] = (this.handshakeFailures[r.reason] ?? 0) + 1;
        this.opts.log?.(`[mesh-bridge] dial ${p.relayId} refused: ${r.reason}`);
      }
    } else {
      ws.terminate();
    }
    d.busy = false;
    if (ok) {
      d.attempt = 0;
      return;
    }
    if (this.stopped) return;
    // Full-jitter backoff 1 s → 60 s.
    d.attempt++;
    const cap = Math.min(MESH_BACKOFF_MAX_MS, MESH_BACKOFF_MIN_MS * 2 ** Math.min(d.attempt, 10));
    d.timer = setTimeout(() => {
      d.timer = null;
      this.reconcile();
    }, MESH_BACKOFF_MIN_MS + Math.random() * (cap - MESH_BACKOFF_MIN_MS));
    d.timer.unref?.();
  }

  private async accept(ws: WebSocket): Promise<void> {
    ws.on("error", () => undefined);
    const q = new HandshakeQueue(ws);
    const r = await acceptorHandshake(ws, this.opts, MESH_HANDSHAKE_STEP_MS, q);
    if (!r.ok) {
      this.handshakeFailures[r.reason] = (this.handshakeFailures[r.reason] ?? 0) + 1;
      this.opts.log?.(`[mesh-bridge] refused an incoming bridge: ${r.reason}`);
      return;
    }
    if ((this.cutUntil.get(r.relayId) ?? 0) > this.opts.now()) {
      ws.close(4429, "cut");
      return;
    }
    this.up(ws, r.relayId, "server", r.blessing, r.returnBlessing, q.detach());
  }

  private up(ws: WebSocket, relayId: string, role: BridgeRole, blessing: RelayBlessing, returnBlessing: boolean, queued: Array<{ raw: Buffer; isBinary: boolean }>): void {
    const old = this.bridges.get(relayId);
    const peer = new BridgePeer(relayId, role, blessing, ws, {
      onControl: (p, m) => this.opts.handler.onControl(p, m),
      onOpen: (p, s) => this.opts.handler.onOpen(p, s),
      onUp: (p) => this.opts.handler.onUp(p),
      onDown: (p, why) => {
        if (this.bridges.get(p.relayId) === p) this.bridges.delete(p.relayId);
        this.opts.handler.onDown(p, why);
        if (!this.stopped) setTimeout(() => this.reconcile(), 50).unref?.();
      },
    }, () => this.opts.now(), (id) => this.cutUntil.set(id, this.opts.now() + MESH_PEER_CUT_MS), { pingMs: this.opts.pingMs, downMs: this.opts.downMs });
    this.bridges.set(relayId, peer);
    // A newer connection to the same peer replaces the older one (both were dialled by the smaller id).
    if (old && old !== peer) old.close(1000, "replaced");
    if (returnBlessing) peer.send({ type: "blessing", blessing });
    this.opts.handler.onUp(peer);
    for (const m of queued) peer.replay(m.raw, m.isBinary);
  }
}
