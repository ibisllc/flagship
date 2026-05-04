import { sha256 } from "@noble/hashes/sha256";
import { ed, type Bytes } from "@flagship/protocol";
import { canonicalPbResponse } from "@flagship/tunnel-protocol";
import type { ShardRegistry, MyShardRow } from "./registry.js";

/**
 * Owner-side ciphertext source. The owner already holds the original
 * ciphertext locally (encrypt-once-distribute-N model), so verifying
 * proof-of-storage is just hashing the same offset+length window with
 * the same nonce and comparing.
 */
export interface OwnerShardSource {
  /** Returns the slice the peer is being asked to hash, or undefined if missing. */
  loadShardSlice(
    encChunkId: Bytes,
    shardIndex: number,
    offset: number,
    length: number,
  ): Bytes | undefined;
  /** Total length of the shard (used to pick a random offset within bounds). */
  shardLength(encChunkId: Bytes, shardIndex: number): number | undefined;
}

export interface ChallengeIssuer {
  challenge(args: {
    encChunkId: Bytes;
    shardIndex: number;
    nonce: Bytes;
    offset: number;
    length: number;
  }): Promise<{
    ok: boolean;
    hash?: string;
    signature?: Bytes;
    reason?: string;
  }>;
}

export interface ProofOfStorageOptions {
  registry: ShardRegistry;
  source: OwnerShardSource;
  /** Look up an issuer (PeerBackupClient or test fake) by peerServerId. */
  issuerFor: (peerServerId: string) => ChallengeIssuer | undefined;
  /** Random source — tests pin to deterministic. */
  randomBytes?: (n: number) => Uint8Array;
  randomInt?: (max: number) => number;
  now?: () => number;
  /** Challenge cadence per shard. Default 24h. */
  intervalMs?: number;
  /** Jitter +/- relative to interval. Default 2h. */
  jitterMs?: number;
  /** Window size hashed in each challenge. Default 1 KiB. */
  challengeWindowBytes?: number;
  /** Failures-in-a-row before declaring the shard lost on that peer. Default 3. */
  lossStreakThreshold?: number;
  /** Hook fired when a shard crosses the loss threshold. */
  onShardLost?: (row: MyShardRow) => void | Promise<void>;
  /** Hook fired on a successful challenge. Drives ledger updates. */
  onSuccess?: (row: MyShardRow) => void | Promise<void>;
}

interface SweepResult {
  challenged: number;
  ok: number;
  failed: number;
  lost: number;
  skipped: number;
}

export class ProofOfStorageScheduler {
  private readonly opts: Required<
    Pick<
      ProofOfStorageOptions,
      "intervalMs" | "jitterMs" | "challengeWindowBytes" | "lossStreakThreshold"
    >
  > &
    ProofOfStorageOptions;

  constructor(opts: ProofOfStorageOptions) {
    this.opts = {
      intervalMs: 24 * 60 * 60_000,
      jitterMs: 2 * 60 * 60_000,
      challengeWindowBytes: 1024,
      lossStreakThreshold: 3,
      ...opts,
    };
  }

  /**
   * Walks `my_shards` and challenges any shard whose lastChallenge is older
   * than (intervalMs +/- jitter). Returns a summary.
   */
  async sweepOnce(): Promise<SweepResult> {
    const t = (this.opts.now ?? (() => Date.now()))();
    const result: SweepResult = { challenged: 0, ok: 0, failed: 0, lost: 0, skipped: 0 };
    const rb = this.opts.randomBytes ?? defaultRandomBytes;
    const ri = this.opts.randomInt ?? defaultRandomInt;

    for (const row of this.opts.registry.myShards()) {
      const elapsed = row.lastChallenge ? t - row.lastChallenge : Number.POSITIVE_INFINITY;
      const jitterRoll = ri(this.opts.jitterMs * 2) - this.opts.jitterMs;
      if (elapsed < this.opts.intervalMs + jitterRoll) {
        result.skipped += 1;
        continue;
      }
      const issuer = this.opts.issuerFor(row.peerServerId);
      if (!issuer) {
        result.skipped += 1;
        continue;
      }
      const len = this.opts.source.shardLength(row.encChunkId, row.shardIndex);
      if (len === undefined || len < this.opts.challengeWindowBytes) {
        result.skipped += 1;
        continue;
      }
      const nonce = rb(32);
      const offset = ri(len - this.opts.challengeWindowBytes);
      result.challenged += 1;
      const resp = await issuer.challenge({
        encChunkId: row.encChunkId,
        shardIndex: row.shardIndex,
        nonce,
        offset,
        length: this.opts.challengeWindowBytes,
      });
      const expected = this.opts.source.loadShardSlice(
        row.encChunkId,
        row.shardIndex,
        offset,
        this.opts.challengeWindowBytes,
      );
      const verifyOk =
        resp.ok &&
        resp.hash !== undefined &&
        resp.signature !== undefined &&
        expected !== undefined &&
        resp.hash === bytesToHex(sha256(concat(nonce, expected))) &&
        verifySig(resp.signature, {
          encChunkId: bytesToHex(row.encChunkId),
          shardIndex: row.shardIndex,
          nonce: bytesToHex(nonce),
          hash: resp.hash,
        }, row.peerStkPub);

      if (verifyOk) {
        this.opts.registry.recordChallengeOk(row.encChunkId, row.shardIndex, row.peerServerId, t);
        result.ok += 1;
        await this.opts.onSuccess?.(row);
      } else {
        const streak = this.opts.registry.recordChallengeFail(
          row.encChunkId,
          row.shardIndex,
          row.peerServerId,
        );
        result.failed += 1;
        if (streak >= this.opts.lossStreakThreshold) {
          result.lost += 1;
          await this.opts.onShardLost?.(row);
        }
      }
    }
    return result;
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function defaultRandomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function defaultRandomInt(max: number): number {
  if (max <= 0) return 0;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}

function verifySig(
  signature: Uint8Array,
  args: { encChunkId: string; shardIndex: number; nonce: string; hash: string },
  peerStkPub: Uint8Array,
): boolean {
  try {
    return ed.verify(signature, canonicalPbResponse(args), peerStkPub);
  } catch {
    return false;
  }
}
