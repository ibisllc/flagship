import { sha256 } from "@noble/hashes/sha256";
import { encodeShards, type Bytes } from "@flagship/protocol";
import type { SwkOps } from "./keyCustodian.js";
import type { PeerProvider, ShardPusher } from "./peerBackup/repairDaemon.js";
import type { ShardRegistry } from "./peerBackup/registry.js";
import type { ShardBytesStore } from "./peerBackup/shardStore.js";
import {
  chunkIsRestorable,
  emptyManifest,
  type BackupManifest,
  type ManifestChunk,
  type ManifestPlacement,
  type ManifestStore,
} from "./peerBackup/manifest.js";

export interface BackupConfig {
  swk: SwkOps;
  k: number;
  n: number;
}

/**
 * The live ship path. Absent (legacy construction) runOnce only
 * encrypts+shards in memory and reports — the pre-Layer-0 behavior the
 * status surface was built on.
 */
export interface BackupShipping {
  myServerId: string;
  /** `.com` matchmaker (or a test fake). */
  peerProvider: PeerProvider;
  /** HttpPeerLink pusher (or a test fake). */
  pusher: ShardPusher;
  /** my_shards bookkeeping — feeds proof-of-storage + repair. */
  registry: ShardRegistry;
  /** Local copy of our own shards — what the repair daemon re-pushes from. */
  ownShards: ShardBytesStore;
  /** Local manifest snapshot (the .com copy is the sealed recovery root). */
  manifestStore: ManifestStore;
  /** Seal + deposit the manifest on .com. Failure is non-fatal (retried next run). */
  uploadManifest?: (m: BackupManifest) => Promise<{ ok: boolean; reason?: string }>;
  /** Parallel pushes per chunk. Default 4. */
  maxConcurrent?: number;
  now?: () => number;
  onLog?: (msg: string) => void;
}

export interface FileToBack {
  path: string;
  content: Bytes;
}

export interface BackupReport {
  filesProcessed: number;
  totalShards: number;
  totalShardBytes: number;
  /** Chunks whose shards were (re-)pushed this run. */
  chunksShipped: number;
  /** Chunks skipped because content was unchanged AND already restorable. */
  chunksSkipped: number;
  /** Shards successfully placed on peers this run. */
  shardsPlaced: number;
  /** Chunks that ended the run with < k distinct shard indices on peers. */
  chunksUnderReplicated: number;
  /** Whether the manifest deposit to .com succeeded (false when not attempted). */
  manifestUploaded: boolean;
}

export interface BackupStatus {
  /** Whether the user has toggled backup on for this server. */
  enabled: boolean;
  /** Last time `runOnce` actually executed work (not skipped). */
  lastBackupAt: number | null;
  /** Number of distinct chunks this server has produced shards for. */
  totalChunks: number;
  /** Chunks that currently have ≥ K distinct shard indices placed on peers. */
  healthyChunks: number;
  /** Bytes this server is reciprocally hosting for OTHER users (this is what it costs us to receive backup ourselves). */
  hostingBytes: number;
  /** Last toggle timestamp. */
  lastToggledAt: number | null;
}

const ZERO_REPORT: BackupReport = {
  filesProcessed: 0,
  totalShards: 0,
  totalShardBytes: 0,
  chunksShipped: 0,
  chunksSkipped: 0,
  shardsPlaced: 0,
  chunksUnderReplicated: 0,
  manifestUploaded: false,
};

export class BackupLoop {
  private enabled = false;
  private lastBackupAt: number | null = null;
  private lastToggledAt: number | null = null;
  private totalChunks = 0;
  private hostingBytes = 0;

  constructor(
    private readonly cfg: BackupConfig & { initiallyEnabled?: boolean; shipping?: BackupShipping },
  ) {
    if (cfg.initiallyEnabled) this.enabled = true;
  }

  /** Toggle from the phone (caller has already verified the IRK signature). */
  setEnabled(enabled: boolean, at: number = Date.now()): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.lastToggledAt = at;
  }

  /** Tracks a hosted shard (called by the peer-backup server when it accepts a PUT). */
  recordHostedBytes(delta: number): void {
    this.hostingBytes = Math.max(0, this.hostingBytes + delta);
  }

  status(): BackupStatus {
    const manifest = this.cfg.shipping?.manifestStore.load();
    const healthy = manifest
      ? manifest.chunks.filter(chunkIsRestorable).length
      : this.totalChunks;
    return {
      enabled: this.enabled,
      lastBackupAt: this.lastBackupAt,
      totalChunks: manifest ? manifest.chunks.length : this.totalChunks,
      healthyChunks: healthy,
      hostingBytes: this.hostingBytes,
      lastToggledAt: this.lastToggledAt,
    };
  }

  async runOnce(files: ReadonlyArray<FileToBack>, now: number = Date.now()): Promise<BackupReport> {
    if (!this.enabled) return { ...ZERO_REPORT };
    const ship = this.cfg.shipping;
    if (!ship) return this.dryRun(files, now);

    const report: BackupReport = { ...ZERO_REPORT };
    const manifest = ship.manifestStore.load() ?? emptyManifest(ship.myServerId);
    let changed = false;

    for (const f of files) {
      report.filesProcessed += 1;
      const chunkIdHex = toHex(sha256(f.content));
      const existing = manifest.chunks.find((c) => c.path === f.path);
      if (existing && existing.chunkIdHex === chunkIdHex && chunkIsRestorable(existing)) {
        // Unchanged AND already restorable — re-shipping would only churn
        // peers (encryptChunk's fresh nonce makes ciphertext non-deterministic,
        // so a re-encrypt is a brand-new encChunkId, not a dedupe hit).
        report.chunksSkipped += 1;
        continue;
      }

      const enc = this.cfg.swk.encryptChunkWithSwk(f.content);
      const encChunkId = sha256(enc.ciphertext);
      const shards = encodeShards(enc.ciphertext, this.cfg.k, this.cfg.n);
      report.totalShards += shards.shards.length;
      for (const s of shards.shards) report.totalShardBytes += s.length;

      // Keep the local copy first: it's what proof-of-storage verifies
      // against and what the repair daemon re-pushes from.
      for (let i = 0; i < shards.shards.length; i++) {
        ship.ownShards.put(encChunkId, i, shards.shards[i]!);
      }

      // The file changed: the old chunk's registry rows are dead weight
      // (peers keep the old ciphertext until GC — see TODO below).
      if (existing && existing.chunkIdHex !== chunkIdHex) {
        const oldEnc = fromHex(existing.encChunkIdHex);
        for (const row of ship.registry.myShardsForChunk(oldEnc)) {
          ship.registry.removeMyShard(row.encChunkId, row.shardIndex, row.peerServerId);
        }
        for (let i = 0; i < existing.n; i++) ship.ownShards.delete(oldEnc, i);
        // TODO(peer GC): there is no PB_DELETE frame yet, so replaced
        // chunks linger in peers' pools until a quota/GC pass exists.
      }

      const shardSize = shards.shards[0]!.length;
      const peers = await ship.peerProvider.requestPeers({
        shardSizeBytes: shardSize,
        n: this.cfg.n,
        durabilityHint: "high",
        excludeServerIds: [],
      });

      const placements: ManifestPlacement[] = [];
      if (peers.length > 0) {
        // Round-robin when the account has fewer peers than n — fewer
        // distinct failure domains, but strictly more durable than
        // dropping the parity shards on the floor.
        const jobs = shards.shards.map((bytes, shardIndex) => ({
          bytes,
          shardIndex,
          peer: peers[shardIndex % peers.length]!,
        }));
        const concurrency = ship.maxConcurrent ?? 4;
        const queue = [...jobs];
        const workers: Promise<void>[] = [];
        const pushOne = async (job: (typeof jobs)[number]) => {
          const r = await ship.pusher.push({
            encChunkId,
            shardIndex: job.shardIndex,
            bytes: job.bytes,
            peerServerId: job.peer.serverId,
            peerStkPub: job.peer.stkPub,
          });
          if (!r.ok) {
            ship.onLog?.(
              `shard ${job.shardIndex} → ${job.peer.serverId} failed: ${r.reason ?? "unknown"}`,
            );
            return;
          }
          placements.push({
            shardIndex: job.shardIndex,
            peerServerId: job.peer.serverId,
            peerStkPubHex: toHex(job.peer.stkPub),
            shardSha256Hex: toHex(sha256(job.bytes)),
          });
          ship.registry.recordMyShard({
            chunkId: fromHex(chunkIdHex),
            encChunkId,
            shardIndex: job.shardIndex,
            peerServerId: job.peer.serverId,
            peerStkPub: job.peer.stkPub,
            storedAt: (ship.now ?? (() => now))(),
            sizeBytes: job.bytes.length,
            challengeStreak: 0,
          });
          report.shardsPlaced += 1;
        };
        while (queue.length > 0 || workers.length > 0) {
          while (workers.length < concurrency && queue.length > 0) {
            const job = queue.shift()!;
            const p = pushOne(job).finally(() => {
              const i = workers.indexOf(p);
              if (i >= 0) workers.splice(i, 1);
            });
            workers.push(p);
          }
          if (workers.length > 0) await Promise.race(workers);
        }
      }

      const chunk: ManifestChunk = {
        path: f.path,
        chunkIdHex,
        encChunkIdHex: toHex(encChunkId),
        nonceHex: toHex(enc.nonce),
        ciphertextLength: enc.ciphertext.length,
        plainLength: f.content.length,
        k: this.cfg.k,
        n: this.cfg.n,
        placements: placements.sort((a, b) => a.shardIndex - b.shardIndex),
      };
      const idx = manifest.chunks.findIndex((c) => c.path === f.path);
      if (idx >= 0) manifest.chunks[idx] = chunk;
      else manifest.chunks.push(chunk);
      changed = true;
      report.chunksShipped += 1;
      if (!chunkIsRestorable(chunk)) {
        report.chunksUnderReplicated += 1;
        ship.onLog?.(
          `chunk ${f.path}: only ${new Set(placements.map((p) => p.shardIndex)).size} of ${this.cfg.k} required shard indices placed — NOT yet restorable from peers`,
        );
      }
    }

    if (changed) {
      manifest.generation += 1;
      manifest.updatedAt = now;
      ship.manifestStore.save(manifest);
      if (ship.uploadManifest) {
        const up = await ship.uploadManifest(manifest);
        report.manifestUploaded = up.ok;
        if (!up.ok) ship.onLog?.(`manifest upload failed: ${up.reason ?? "unknown"} (kept locally; retried next run)`);
      }
    }

    this.totalChunks = manifest.chunks.length;
    if (files.length > 0) this.lastBackupAt = now;
    return report;
  }

  /** Legacy path (no shipping wired): encrypt+shard in memory, count, discard. */
  private dryRun(files: ReadonlyArray<FileToBack>, now: number): BackupReport {
    const report: BackupReport = { ...ZERO_REPORT };
    for (const f of files) {
      const enc = this.cfg.swk.encryptChunkWithSwk(f.content);
      const shards = encodeShards(enc.ciphertext, this.cfg.k, this.cfg.n);
      report.totalShards += shards.shards.length;
      for (const s of shards.shards) report.totalShardBytes += s.length;
    }
    report.filesProcessed = files.length;
    if (files.length > 0) {
      this.totalChunks += files.length;
      this.lastBackupAt = now;
    }
    return report;
  }
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}
