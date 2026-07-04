import { sha256 } from "@noble/hashes/sha256";
import { ed, type Bytes, type Keypair } from "@flagship/protocol";
import { decodeFrame, encodeFrame, type Frame } from "@flagship/tunnel-protocol";
import type { PeerLink } from "./peerLink.js";
import type { ShardBytesStore } from "./shardStore.js";
import type { ShardRegistry } from "./registry.js";
import { PeerBackupServer } from "./transport.js";

// ──────────────────────────────────────────────────────────────────────
// PeerLink over direct HTTPS box→box (server-migration Layer 0).
//
// WHY HTTPS AND NOT THE TUNNEL HUB: the PB frames live in
// tunnel-protocol, but the hub has NO box↔box relay lane today (the
// gossip fan-out is a hub-side broadcast of opaque blobs, not a
// pairwise pipe) — building one means new hub state + a .services
// deploy. Every box already has a public FQDN with a real LE cert and
// a Fastify API, and the PB protocol is SELF-authenticating (PUT and
// CHALLENGE-RESPONSE are STK-signed end-to-end), so the transport only
// has to carry frames, not create trust. Direct HTTPS works TODAY with
// zero hub changes; if a relay lane ever lands for NAT-ed boxes, it
// plugs in behind the same PeerLink interface.
//
// Shape: one POST per frame burst. PeerBackupClient emits every frame
// of an operation synchronously before awaiting the reply, so the link
// buffers `send()`s and flushes them as ONE request on the next
// microtask; the peer processes the batch through a verbatim
// PeerBackupServer and returns the response frames in the HTTP body.
// Frames ride hex-in-JSON (the daemon API's established body style).
//
// The outer request is STK-signed (`flagship/pb-http/v1`) so the peer
// can authenticate WHO is asking before serving GET/CHALLENGE (which
// carry no inner signature) — and GET/CHALLENGE are additionally
// owner-scoped: a verified caller can only read shards it deposited.
// ──────────────────────────────────────────────────────────────────────

export const PB_FRAMES_PATH = "/api/peer-backup/frames";
const TAG_PB_HTTP = "flagship/pb-http/v1";
const DEFAULT_MAX_SKEW_MS = 5 * 60_000;

export function canonicalPbHttpEnvelope(args: {
  fromServerId: string;
  toServerId: string;
  issuedAt: number;
  framesSha256Hex: string;
}): Bytes {
  return new TextEncoder().encode(
    [TAG_PB_HTTP, args.fromServerId, args.toServerId, args.issuedAt, args.framesSha256Hex].join("|"),
  );
}

export interface PbFramesRequestBody {
  from?: unknown;
  issuedAt?: unknown;
  framesHex?: unknown;
  signatureHex?: unknown;
}

function encodeFrames(frames: Frame[]): Uint8Array {
  const parts = frames.map(encodeFrame);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function decodeFrames(buf: Uint8Array): Frame[] | null {
  const frames: Frame[] = [];
  let rest = buf;
  while (rest.length > 0) {
    const r = decodeFrame(rest);
    if (r.kind !== "ok") return null;
    frames.push(r.frame);
    rest = rest.subarray(r.consumed);
  }
  return frames;
}

export interface HttpPeerLinkOptions {
  /** e.g. `https://attic.alice.flagship.services` */
  peerBaseUrl: string;
  remoteServerId: string;
  myServerId: string;
  mySTK: Keypair;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Fired when a flush fails — callers' pending ops resolve via their own timeouts. */
  onError?: (err: unknown) => void;
}

/**
 * Client-side PeerLink. `send()` buffers; the burst flushes as one
 * signed POST on the next microtask; response frames are dispatched to
 * `onFrame` handlers when the reply lands.
 */
export function createHttpPeerLink(opts: HttpPeerLinkOptions): PeerLink {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const handlers = new Set<(f: Frame) => void>();
  let buffer: Frame[] = [];
  let flushScheduled = false;
  let closed = false;

  async function flush(): Promise<void> {
    flushScheduled = false;
    if (closed || buffer.length === 0) return;
    const frames = buffer;
    buffer = [];
    try {
      const bytes = encodeFrames(frames);
      const issuedAt = (opts.now ?? Date.now)();
      const sig = ed.sign(
        canonicalPbHttpEnvelope({
          fromServerId: opts.myServerId,
          toServerId: opts.remoteServerId,
          issuedAt,
          framesSha256Hex: toHex(sha256(bytes)),
        }),
        opts.mySTK.privateKey,
      );
      const res = await fetchImpl(`${opts.peerBaseUrl}${PB_FRAMES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: opts.myServerId,
          issuedAt,
          framesHex: toHex(bytes),
          signatureHex: toHex(sig),
        }),
      });
      if (!res.ok) throw new Error(`peer responded ${res.status}`);
      const json = (await res.json()) as { framesHex?: string };
      if (typeof json.framesHex !== "string") throw new Error("malformed peer response");
      const replies = decodeFrames(fromHex(json.framesHex));
      if (!replies) throw new Error("undecodable peer frames");
      for (const f of replies) {
        if (closed) return;
        for (const h of [...handlers]) h(f);
      }
    } catch (err) {
      opts.onError?.(err);
    }
  }

  return {
    remoteServerId: opts.remoteServerId,
    send(f: Frame): void {
      if (closed) return;
      buffer.push({ streamId: f.streamId, type: f.type, payload: f.payload.slice() });
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => void flush());
      }
    },
    onFrame(h: (f: Frame) => void): () => void {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    close(): void {
      closed = true;
      handlers.clear();
      buffer = [];
    },
  };
}

export interface PbFramesHandlerOptions {
  myServerId: string;
  mySTK: Keypair;
  /** Where accepted shards land (their-shards pool). */
  store: ShardBytesStore;
  /** Records their_shards rows + backs the owner-scoping of GET/CHALLENGE. */
  registry: ShardRegistry;
  /**
   * Resolve a caller serverId → its directory-bound STK pub (`.com`
   * GET /api/peer-backup/stk/:serverDomain, cached). null = unknown/revoked.
   */
  resolveCallerStk: (serverId: string) => Promise<Bytes | null> | Bytes | null;
  /** Accounting hook (hostingBytes). The registry row is recorded here regardless. */
  onShardAccepted?: (info: {
    encChunkId: Bytes;
    shardIndex: number;
    sizeBytes: number;
    ownerServerId: string;
  }) => void;
  now?: () => number;
  maxSkewMs?: number;
}

export interface PbFramesResult {
  status: number;
  body: { framesHex: string } | { error: string };
}

/**
 * Server side of the HTTP PeerLink — verify the outer STK envelope,
 * then run the batch through a verbatim PeerBackupServer over a
 * collecting link and return its reply frames.
 */
export async function handlePbFramesRequest(
  opts: PbFramesHandlerOptions,
  body: PbFramesRequestBody,
): Promise<PbFramesResult> {
  if (
    typeof body?.from !== "string" ||
    body.from.length === 0 ||
    typeof body.issuedAt !== "number" ||
    typeof body.framesHex !== "string" ||
    body.framesHex.length % 2 !== 0 ||
    typeof body.signatureHex !== "string" ||
    body.signatureHex.length !== 128
  ) {
    return { status: 400, body: { error: "malformed frames request" } };
  }
  let frameBytes: Uint8Array;
  let sig: Uint8Array;
  try {
    frameBytes = fromHex(body.framesHex);
    sig = fromHex(body.signatureHex);
  } catch {
    return { status: 400, body: { error: "bad hex" } };
  }
  const callerStk = await opts.resolveCallerStk(body.from);
  if (!callerStk) return { status: 403, body: { error: "unknown caller" } };
  const okSig = (() => {
    try {
      return ed.verify(
        sig,
        canonicalPbHttpEnvelope({
          fromServerId: body.from,
          toServerId: opts.myServerId,
          issuedAt: body.issuedAt,
          framesSha256Hex: toHex(sha256(frameBytes)),
        }),
        callerStk,
      );
    } catch {
      return false;
    }
  })();
  if (!okSig) return { status: 403, body: { error: "invalid signature" } };
  const now = (opts.now ?? Date.now)();
  if (Math.abs(now - body.issuedAt) > (opts.maxSkewMs ?? DEFAULT_MAX_SKEW_MS)) {
    return { status: 403, body: { error: "stale request" } };
  }
  const frames = decodeFrames(frameBytes);
  if (!frames) return { status: 400, body: { error: "undecodable frames" } };

  const from = body.from;
  // GET / CHALLENGE carry no inner signature — scope reads to shards
  // this caller deposited, so a verified-but-foreign box can't pull
  // another owner's ciphertext out of our pool.
  const scopedStore = ownerScopedStore(opts.store, opts.registry, from);

  const out: Frame[] = [];
  const sink: { deliver: ((f: Frame) => void) | null } = { deliver: null };
  const collectingLink: PeerLink = {
    remoteServerId: from,
    send(f) {
      out.push({ streamId: f.streamId, type: f.type, payload: f.payload.slice() });
    },
    onFrame(h) {
      sink.deliver = h;
      return () => {
        if (sink.deliver === h) sink.deliver = null;
      };
    },
    close() {
      sink.deliver = null;
    },
  };
  const server = new PeerBackupServer({
    link: collectingLink,
    mySTK: opts.mySTK,
    myServerId: opts.myServerId,
    store: scopedStore,
    resolveOwnerStk: (sid) => (sid === from ? callerStk : null),
    onShardAccepted: (info) => {
      opts.registry.recordTheirShard({
        encChunkId: info.encChunkId,
        shardIndex: info.shardIndex,
        ownerServerId: info.ownerServerId,
        ownerStkPub: callerStk.slice(),
        storedAt: now,
        sizeBytes: info.sizeBytes,
      });
      opts.onShardAccepted?.(info);
    },
  });
  try {
    for (const f of frames) sink.deliver?.(f);
  } finally {
    server.close();
  }
  return { status: 200, body: { framesHex: toHex(encodeFrames(out)) } };
}

/**
 * A read-scoped view of the pool: `get`/`slice` answer only for shards
 * whose their_shards row names `ownerServerId` as the depositor. Writes
 * pass through (PUT is separately STK-verified by PeerBackupServer).
 */
function ownerScopedStore(
  store: ShardBytesStore,
  registry: ShardRegistry,
  ownerServerId: string,
): ShardBytesStore {
  const owns = (encChunkId: Bytes, shardIndex: number): boolean =>
    registry.theirShard(encChunkId, shardIndex)?.ownerServerId === ownerServerId;
  return {
    put: (e, i, b) => store.put(e, i, b),
    get: (e, i) => (owns(e, i) ? store.get(e, i) : undefined),
    delete: (e, i) => (owns(e, i) ? store.delete(e, i) : false),
    slice: (e, i, o, l) => (owns(e, i) ? store.slice(e, i, o, l) : undefined),
  };
}

/**
 * Adapter for the runtime's first-non-null handler chain (the box's
 * PUBLIC pipe — the Fastify API is 127.0.0.1-only, and peers dial
 * `https://<fqdn>/api/peer-backup/frames`). Falls through (null) for
 * every other path/method, like buildLeadsHttpHandler. `opts` is a
 * thunk so the frames surface can be registered the moment the runtime
 * is up and light up when peer-backup wiring lands (503 until then).
 */
export function buildPbFramesRuntimeHandler(
  opts: () => PbFramesHandlerOptions | null,
): (req: {
  method: string;
  path: string;
  body: Buffer | Uint8Array;
}) => Promise<{ status: number; headers?: Record<string, string>; body: string } | null> {
  return async (req) => {
    const path = req.path.split("?")[0] ?? req.path;
    if (path !== PB_FRAMES_PATH) return null;
    if (req.method.toUpperCase() !== "POST") return null;
    const json = (b: unknown, status: number) => ({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    });
    const o = opts();
    if (!o) return json({ error: "peer backup not configured" }, 503);
    let body: PbFramesRequestBody;
    try {
      body = JSON.parse(new TextDecoder().decode(req.body)) as PbFramesRequestBody;
    } catch {
      return json({ error: "malformed JSON" }, 400);
    }
    const r = await handlePbFramesRequest(o, body);
    return json(r.body, r.status);
  };
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hexStr: string): Bytes {
  if (!/^[0-9a-f]*$/i.test(hexStr)) throw new Error("bad hex");
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}
