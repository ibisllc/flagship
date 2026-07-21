import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { decodeShards, decryptChunk, type Bytes, type Keypair } from "@flagship/protocol";
import { fetchBackupManifest, type BackupManifest, type ManifestChunk } from "./manifest.js";
import { buildHttpShardFetcher, type ShardFetcher } from "./shipper.js";

// ──────────────────────────────────────────────────────────────────────
// Restore driver (server-migration Layer 0, phase-3 "pre-seed data").
//
// Runs on a FRESH box before it starts serving: fetch the sealed
// manifest from .com, open it with the re-derived SWK (deriveSWK(umk,
// serverId) — deterministic, so a replacement box needs no escrow),
// pull >= k shards per chunk from peers, decode, decrypt, verify, and
// write files. Properties the migration orchestrator (built later)
// relies on:
//
//   IDEMPOTENT + RESUMABLE — a chunk whose target file already matches
//   the manifest's plaintext hash is skipped, so re-running after a
//   crash (or after the final-delta manifest lands) only fetches what's
//   missing/changed.
//
//   NO PARTIAL GARBAGE — every write is verify-then-rename: bytes only
//   reach the target path after GCM auth + plaintext-hash verification,
//   and a wrong SWK fails BEFORE any file is touched (the manifest
//   itself won't open).
//
//   HONEST PROGRESS — per-chunk progress callbacks + a report that
//   distinguishes restored / skipped / failed (with reasons), so the
//   phone's timeline can show real state, not a spinner.
//
// Entry points:
//   restoreFromManifest(...)  — pure, injectable; the migration
//                               consumer calls this directly.
//   buildRestorePoller(...)   — the consumer-shaped wrapper (pollOnce/
//                               start/stop, mirrors buildSwkDepositPoller)
//                               that polls .com until a manifest exists,
//                               restores, and stops when complete.
// ──────────────────────────────────────────────────────────────────────

export interface RestoreSink {
  /** Atomic write (tmp+rename or equivalent). `path` is manifest-relative. */
  writeFile(path: string, bytes: Bytes): Promise<void>;
  /** sha256-hex of the current file at `path`, or null when absent. */
  fileHashHex(path: string): Promise<string | null>;
}

export interface RestoreProgress {
  chunksTotal: number;
  chunksDone: number;
  currentPath: string | null;
  bytesWritten: number;
}

export interface RestoreFailure {
  path: string;
  reason: string;
}

export interface RestoreReport {
  chunksTotal: number;
  restored: number;
  skipped: number;
  failed: RestoreFailure[];
  bytesWritten: number;
  /** True iff every chunk is now present (restored or already there). */
  complete: boolean;
}

export interface RestoreFromManifestOptions {
  manifest: BackupManifest;
  swk: Bytes;
  source: ShardFetcher;
  sink: RestoreSink;
  onProgress?: (p: RestoreProgress) => void;
  onLog?: (msg: string) => void;
}

export async function restoreFromManifest(opts: RestoreFromManifestOptions): Promise<RestoreReport> {
  const report: RestoreReport = {
    chunksTotal: opts.manifest.chunks.length,
    restored: 0,
    skipped: 0,
    failed: [],
    bytesWritten: 0,
    complete: false,
  };
  const progress = (currentPath: string | null) =>
    opts.onProgress?.({
      chunksTotal: report.chunksTotal,
      chunksDone: report.restored + report.skipped + report.failed.length,
      currentPath,
      bytesWritten: report.bytesWritten,
    });

  for (const chunk of opts.manifest.chunks) {
    progress(chunk.path);
    // Resume: already byte-identical on disk → skip (no fetch at all).
    const existingHash = await opts.sink.fileHashHex(chunk.path);
    if (existingHash !== null && existingHash === chunk.chunkIdHex) {
      report.skipped += 1;
      continue;
    }
    const outcome = await restoreChunk(chunk, opts);
    if (!outcome.ok) {
      report.failed.push({ path: chunk.path, reason: outcome.reason });
      opts.onLog?.(`restore ${chunk.path}: ${outcome.reason}`);
      continue;
    }
    await opts.sink.writeFile(chunk.path, outcome.plaintext);
    report.bytesWritten += outcome.plaintext.length;
    report.restored += 1;
  }
  progress(null);
  report.complete = report.failed.length === 0;
  return report;
}

async function restoreChunk(
  chunk: ManifestChunk,
  opts: RestoreFromManifestOptions,
): Promise<{ ok: true; plaintext: Bytes } | { ok: false; reason: string }> {
  const encChunkId = fromHex(chunk.encChunkIdHex);

  // Group placements by shard index — after a repair, one index may have
  // newer + stale placements; any peer holding matching bytes will do.
  const byIndex = new Map<number, typeof chunk.placements>();
  for (const p of chunk.placements) {
    const arr = byIndex.get(p.shardIndex) ?? [];
    arr.push(p);
    byIndex.set(p.shardIndex, arr);
  }

  const recovered: Array<Bytes | null> = new Array<Bytes | null>(chunk.n).fill(null);
  let have = 0;
  for (const [shardIndex, placements] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (have >= chunk.k) break;
    for (const p of placements) {
      const bytes = await opts.source.fetchShard(p.peerServerId, encChunkId, shardIndex);
      if (!bytes) {
        opts.onLog?.(`shard ${shardIndex} of ${chunk.path}: ${p.peerServerId} unreachable/empty`);
        continue;
      }
      // A corrupt (or maliciously substituted) shard is rejected HERE,
      // before it can poison the decode — try the next holder.
      if (toHex(sha256(bytes)) !== p.shardSha256Hex) {
        opts.onLog?.(`shard ${shardIndex} of ${chunk.path}: ${p.peerServerId} returned corrupt bytes`);
        continue;
      }
      recovered[shardIndex] = bytes;
      have += 1;
      break;
    }
  }
  if (have < chunk.k) {
    return { ok: false, reason: `only ${have} of ${chunk.k} required shards retrievable` };
  }

  let ciphertext: Bytes;
  try {
    ciphertext = decodeShards(recovered, chunk.k, chunk.n, chunk.ciphertextLength);
  } catch (e) {
    return { ok: false, reason: `decode failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  let plaintext: Bytes;
  try {
    plaintext = decryptChunk(
      { ciphertext, nonce: fromHex(chunk.nonceHex), contentHash: fromHex(chunk.chunkIdHex) },
      opts.swk,
    );
  } catch {
    // GCM auth failure — wrong SWK or a manifest/data mismatch. Nothing
    // was written; the caller decides whether to retry.
    return { ok: false, reason: "decrypt failed (wrong SWK or corrupt chunk)" };
  }
  if (plaintext.length !== chunk.plainLength || toHex(sha256(plaintext)) !== chunk.chunkIdHex) {
    return { ok: false, reason: "plaintext hash mismatch" };
  }
  return { ok: true, plaintext };
}

/**
 * Filesystem sink rooted at `rootDir` — atomic tmp+rename writes, and a
 * traversal guard so a hostile manifest path can never escape the root.
 * (The manifest is SWK-sealed and box-authored, but the guard costs
 * nothing and the sink is the last line.)
 */
export function fsRestoreSink(rootDir: string): RestoreSink {
  const resolvePath = (rel: string): string => {
    const full = normalize(join(rootDir, rel));
    const root = normalize(rootDir + sep);
    if (!full.startsWith(root)) throw new Error(`path escapes restore root: ${rel}`);
    return full;
  };
  return {
    async writeFile(path: string, bytes: Bytes): Promise<void> {
      const full = resolvePath(path);
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
      const tmp = `${full}.restore-tmp`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, full);
    },
    async fileHashHex(path: string): Promise<string | null> {
      const full = resolvePath(path);
      if (!existsSync(full)) return null;
      try {
        return toHex(sha256(new Uint8Array(readFileSync(full))));
      } catch {
        return null;
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Consumer-shaped poller (mirrors buildSwkDepositPoller)
// ──────────────────────────────────────────────────────────────────────

export type RestoreOutcome =
  | { status: "no-manifest" }
  | { status: "complete"; report: RestoreReport }
  | { status: "partial"; report: RestoreReport }
  | { status: "error"; reason: string };

export interface RestorePollerOptions {
  serverId: string;
  /** Re-derived deterministically on the fresh box: deriveSWK(umk, serverId). */
  swk: Bytes;
  /** The box identity keypair — signs the shard-GET envelopes to peers. */
  mySTK: Keypair;
  controlPlaneBaseUrl: string;
  sink: RestoreSink;
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to the live HTTPS shard fetcher. */
  source?: ShardFetcher;
  baseUrlFor?: (peerServerId: string) => string;
  onProgress?: (p: RestoreProgress) => void;
  onLog?: (msg: string) => void;
  /** Fired once, when a poll finishes with every chunk present. */
  onComplete?: (report: RestoreReport) => void | Promise<void>;
}

export interface RestorePoller {
  pollOnce(): Promise<RestoreOutcome>;
  start(): void;
  stop(): void;
}

export async function runRestoreOnce(opts: RestorePollerOptions): Promise<RestoreOutcome> {
  let manifest: BackupManifest | null;
  try {
    manifest = await fetchBackupManifest({
      controlPlaneBaseUrl: opts.controlPlaneBaseUrl,
      serverId: opts.serverId,
      swk: opts.swk,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : String(e) };
  }
  if (!manifest) return { status: "no-manifest" };

  const source =
    opts.source ??
    buildHttpShardFetcher({
      myServerId: opts.serverId,
      mySTK: opts.mySTK,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.baseUrlFor ? { baseUrlFor: opts.baseUrlFor } : {}),
    });
  try {
    const report = await restoreFromManifest({
      manifest,
      swk: opts.swk,
      source,
      sink: opts.sink,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.onLog ? { onLog: opts.onLog } : {}),
    });
    if (report.complete) {
      await opts.onComplete?.(report);
      return { status: "complete", report };
    }
    return { status: "partial", report };
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}

export function buildRestorePoller(
  opts: RestorePollerOptions & { intervalMs?: number },
): RestorePoller {
  const intervalMs = opts.intervalMs ?? 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const poller: RestorePoller = {
    async pollOnce() {
      const outcome = await runRestoreOnce(opts);
      if (outcome.status === "complete") poller.stop();
      return outcome;
    },
    start() {
      if (timer) return;
      const tick = () => {
        if (inFlight) return;
        inFlight = true;
        void poller
          .pollOnce()
          .catch((e) => opts.onLog?.(`restore poll failed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => {
            inFlight = false;
          });
      };
      tick();
      timer = setInterval(tick, intervalMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
  return poller;
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hexStr: string): Bytes {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}
