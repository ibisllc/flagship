import { sha256 } from "@noble/hashes/sha256";
import {
  FRAME_PB_PUT,
  FRAME_PB_PUT_ACK,
  FRAME_PB_GET,
  FRAME_PB_GET_DATA,
  FRAME_PB_GET_END,
  FRAME_PB_CHALLENGE,
  FRAME_PB_RESPONSE,
  canonicalPbPut,
  canonicalPbResponse,
  decodePbChallenge,
  decodePbGet,
  decodePbGetEnd,
  decodePbPut,
  decodePbPutAck,
  decodePbResponse,
  pbChallengeFrame,
  pbGetDataFrame,
  pbGetEndFrame,
  pbGetFrame,
  pbPutAckFrame,
  pbPutFrame,
  pbResponseFrame,
  type Frame,
} from "@flagship/tunnel-protocol";
import { ed, type Bytes, type Keypair } from "@flagship/protocol";
import type { PeerLink } from "./peerLink.js";
import type { ShardBytesStore } from "./shardStore.js";

const MAX_DATA_CHUNK = 64 * 1024;

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Bytes {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Owner-side client: pushes shards to peers, retrieves them during restore,
 * and issues proof-of-storage challenges.
 */
export interface PutResult {
  ok: boolean;
  reason?: string;
}

export interface GetResult {
  ok: boolean;
  bytes?: Bytes;
  reason?: string;
}

export interface ChallengeResult {
  ok: boolean;
  hash?: string;
  signature?: Bytes;
  reason?: string;
}

export class PeerBackupClient {
  private nextStream = 1;
  private offFrame: () => void;
  private pendingAck = new Map<number, (r: PutResult) => void>();
  private pendingGet = new Map<
    number,
    {
      collected: Uint8Array[];
      done: (r: GetResult) => void;
      expectedSha?: string;
    }
  >();
  private pendingChallenge = new Map<number, (r: ChallengeResult) => void>();

  constructor(
    private readonly link: PeerLink,
    private readonly mySTK: Keypair,
    private readonly myServerId: string,
  ) {
    this.offFrame = link.onFrame((f) => this.handle(f));
  }

  close(): void {
    this.offFrame();
  }

  /** Push a shard to the peer. Resolves with the peer's PUT_ACK. */
  async putShard(opts: {
    encChunkId: Bytes;
    shardIndex: number;
    bytes: Bytes;
    peerServerId: string;
  }): Promise<PutResult> {
    const streamId = this.nextStream++;
    const encHex = bytesToHex(opts.encChunkId);
    const sig = ed.sign(
      canonicalPbPut({
        encChunkId: encHex,
        shardIndex: opts.shardIndex,
        sizeBytes: opts.bytes.length,
        peerServerId: opts.peerServerId,
      }),
      this.mySTK.privateKey,
    );
    const ackPromise = new Promise<PutResult>((resolve) => {
      this.pendingAck.set(streamId, resolve);
    });
    this.link.send(
      pbPutFrame(streamId, {
        encChunkId: encHex,
        shardIndex: opts.shardIndex,
        sizeBytes: opts.bytes.length,
        signature: bytesToHex(sig),
      }),
    );
    // Stream the shard bytes after the PUT control frame.
    for (let off = 0; off < opts.bytes.length; off += MAX_DATA_CHUNK) {
      this.link.send(pbGetDataFrame(streamId, opts.bytes.slice(off, off + MAX_DATA_CHUNK)));
    }
    this.link.send(
      pbGetEndFrame(streamId, {
        encChunkId: encHex,
        shardIndex: opts.shardIndex,
        sha256: bytesToHex(sha256(opts.bytes)),
      }),
    );
    return ackPromise;
  }

  /** Retrieve a shard from the peer. */
  async getShard(opts: {
    encChunkId: Bytes;
    shardIndex: number;
  }): Promise<GetResult> {
    const streamId = this.nextStream++;
    const encHex = bytesToHex(opts.encChunkId);
    const promise = new Promise<GetResult>((resolve) => {
      this.pendingGet.set(streamId, { collected: [], done: resolve });
    });
    this.link.send(pbGetFrame(streamId, { encChunkId: encHex, shardIndex: opts.shardIndex }));
    return promise;
  }

  /** Challenge the peer to prove they still hold the shard. */
  async challenge(opts: {
    encChunkId: Bytes;
    shardIndex: number;
    nonce: Bytes;
    offset: number;
    length: number;
  }): Promise<ChallengeResult> {
    const streamId = this.nextStream++;
    const promise = new Promise<ChallengeResult>((resolve) => {
      this.pendingChallenge.set(streamId, resolve);
    });
    this.link.send(
      pbChallengeFrame(streamId, {
        encChunkId: bytesToHex(opts.encChunkId),
        shardIndex: opts.shardIndex,
        nonce: bytesToHex(opts.nonce),
        offset: opts.offset,
        length: opts.length,
      }),
    );
    return promise;
  }

  private handle(f: Frame): void {
    if (f.type === FRAME_PB_PUT_ACK) {
      const ack = decodePbPutAck(f.payload);
      const r = this.pendingAck.get(f.streamId);
      if (r) {
        this.pendingAck.delete(f.streamId);
        r({ ok: ack.ok, reason: ack.reason });
      }
      return;
    }
    if (f.type === FRAME_PB_GET_DATA) {
      const ctx = this.pendingGet.get(f.streamId);
      if (ctx) ctx.collected.push(f.payload.slice());
      return;
    }
    if (f.type === FRAME_PB_GET_END) {
      const end = decodePbGetEnd(f.payload);
      const ctx = this.pendingGet.get(f.streamId);
      if (!ctx) return;
      this.pendingGet.delete(f.streamId);
      const total = ctx.collected.reduce((n, b) => n + b.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const b of ctx.collected) {
        out.set(b, off);
        off += b.length;
      }
      const actual = bytesToHex(sha256(out));
      if (actual !== end.sha256) {
        ctx.done({ ok: false, reason: "sha256 mismatch" });
      } else {
        ctx.done({ ok: true, bytes: out });
      }
      return;
    }
    if (f.type === FRAME_PB_RESPONSE) {
      const resp = decodePbResponse(f.payload);
      const r = this.pendingChallenge.get(f.streamId);
      if (r) {
        this.pendingChallenge.delete(f.streamId);
        r({ ok: true, hash: resp.hash, signature: hexToBytes(resp.signature) });
      }
      return;
    }
  }
}

/**
 * Peer-side server: serves PUT / GET / CHALLENGE requests against the local
 * shard store. Verifies the requester's STK signature on PUT.
 */
export interface PeerBackupServerOptions {
  /** STK pubkey of the *owner* of incoming PUT requests, looked up by serverId. */
  resolveOwnerStk: (ownerServerId: string) => Bytes | null;
  /** Local STK keypair — used to sign challenge responses. */
  mySTK: Keypair;
  /** Local serverId. */
  myServerId: string;
  /** Where shard bytes are stored. */
  store: ShardBytesStore;
  /** Hook fired when a shard is successfully accepted. */
  onShardAccepted?: (info: {
    encChunkId: Bytes;
    shardIndex: number;
    sizeBytes: number;
    ownerServerId: string;
  }) => void;
  /**
   * The PeerLink only knows the remote serverId; PUT signatures bind the
   * remote serverId in canonical bytes, so we read that from the link.
   */
  link: PeerLink;
}

export class PeerBackupServer {
  private offFrame: () => void;
  private inProgressPuts = new Map<
    number,
    {
      encChunkId: Bytes;
      shardIndex: number;
      sizeBytes: number;
      ownerServerId: string;
      collected: Uint8Array[];
    }
  >();

  constructor(private readonly opts: PeerBackupServerOptions) {
    this.offFrame = opts.link.onFrame((f) => this.handle(f));
  }

  close(): void {
    this.offFrame();
  }

  private handle(f: Frame): void {
    if (f.type === FRAME_PB_PUT) {
      const put = decodePbPut(f.payload);
      const ownerServerId = this.opts.link.remoteServerId;
      const ownerStk = this.opts.resolveOwnerStk(ownerServerId);
      if (!ownerStk) {
        this.sendPutAck(f.streamId, put.encChunkId, put.shardIndex, false, "unknown owner");
        return;
      }
      const ok = ed.verify(
        hexToBytes(put.signature),
        canonicalPbPut({
          encChunkId: put.encChunkId,
          shardIndex: put.shardIndex,
          sizeBytes: put.sizeBytes,
          peerServerId: this.opts.myServerId,
        }),
        ownerStk,
      );
      if (!ok) {
        this.sendPutAck(f.streamId, put.encChunkId, put.shardIndex, false, "invalid signature");
        return;
      }
      this.inProgressPuts.set(f.streamId, {
        encChunkId: hexToBytes(put.encChunkId),
        shardIndex: put.shardIndex,
        sizeBytes: put.sizeBytes,
        ownerServerId,
        collected: [],
      });
      return;
    }
    if (f.type === FRAME_PB_GET_DATA) {
      const ctx = this.inProgressPuts.get(f.streamId);
      if (ctx) ctx.collected.push(f.payload.slice());
      return;
    }
    if (f.type === FRAME_PB_GET_END) {
      const end = decodePbGetEnd(f.payload);
      const ctx = this.inProgressPuts.get(f.streamId);
      if (!ctx) return;
      this.inProgressPuts.delete(f.streamId);
      const total = ctx.collected.reduce((n, b) => n + b.length, 0);
      if (total !== ctx.sizeBytes) {
        this.sendPutAck(f.streamId, bytesToHex(ctx.encChunkId), ctx.shardIndex, false, "size mismatch");
        return;
      }
      const concat = new Uint8Array(total);
      let off = 0;
      for (const b of ctx.collected) {
        concat.set(b, off);
        off += b.length;
      }
      const actual = bytesToHex(sha256(concat));
      if (actual !== end.sha256) {
        this.sendPutAck(f.streamId, bytesToHex(ctx.encChunkId), ctx.shardIndex, false, "sha256 mismatch");
        return;
      }
      this.opts.store.put(ctx.encChunkId, ctx.shardIndex, concat);
      this.opts.onShardAccepted?.({
        encChunkId: ctx.encChunkId,
        shardIndex: ctx.shardIndex,
        sizeBytes: ctx.sizeBytes,
        ownerServerId: ctx.ownerServerId,
      });
      this.sendPutAck(f.streamId, bytesToHex(ctx.encChunkId), ctx.shardIndex, true);
      return;
    }
    if (f.type === FRAME_PB_GET) {
      const get = decodePbGet(f.payload);
      const enc = hexToBytes(get.encChunkId);
      const data = this.opts.store.get(enc, get.shardIndex);
      if (!data) {
        // Empty stream + sha256 of empty bytes signals "no such shard".
        this.opts.link.send(
          pbGetEndFrame(f.streamId, {
            encChunkId: get.encChunkId,
            shardIndex: get.shardIndex,
            sha256: bytesToHex(sha256(new Uint8Array(0))),
          }),
        );
        return;
      }
      for (let off = 0; off < data.length; off += MAX_DATA_CHUNK) {
        this.opts.link.send(pbGetDataFrame(f.streamId, data.slice(off, off + MAX_DATA_CHUNK)));
      }
      this.opts.link.send(
        pbGetEndFrame(f.streamId, {
          encChunkId: get.encChunkId,
          shardIndex: get.shardIndex,
          sha256: bytesToHex(sha256(data)),
        }),
      );
      return;
    }
    if (f.type === FRAME_PB_CHALLENGE) {
      const c = decodePbChallenge(f.payload);
      const enc = hexToBytes(c.encChunkId);
      const slice = this.opts.store.slice(enc, c.shardIndex, c.offset, c.length);
      if (!slice) return; // peer just doesn't reply when they can't honor the challenge
      const nonce = hexToBytes(c.nonce);
      const concat = new Uint8Array(nonce.length + slice.length);
      concat.set(nonce, 0);
      concat.set(slice, nonce.length);
      const hash = sha256(concat);
      const sig = ed.sign(
        canonicalPbResponse({
          encChunkId: c.encChunkId,
          shardIndex: c.shardIndex,
          nonce: c.nonce,
          hash: bytesToHex(hash),
        }),
        this.opts.mySTK.privateKey,
      );
      this.opts.link.send(
        pbResponseFrame(f.streamId, {
          encChunkId: c.encChunkId,
          shardIndex: c.shardIndex,
          hash: bytesToHex(hash),
          signature: bytesToHex(sig),
        }),
      );
      return;
    }
  }

  private sendPutAck(streamId: number, encChunkId: string, shardIndex: number, ok: boolean, reason?: string): void {
    this.opts.link.send(pbPutAckFrame(streamId, { encChunkId, shardIndex, ok, reason }));
  }
}
