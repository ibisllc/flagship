/**
 * Snapshot builder for the P9 Screens-BFF peer-backup endpoints.
 *
 * Pure projection of the daemon's in-memory peer-backup state into the
 * `PeerBackupStatusResponse` wire shape consumed by the webapp + the
 * upcoming iOS/Android views. Wherever the underlying state doesn't
 * yet carry a field the view expects (per-peer online signal, per-shard
 * byte size on the MY side, repair-tick history) the projector returns
 * an honest empty/zero — never fabricated.
 */

import type { BackupLoop } from "../backupLoop.js";
import type {
  MyShardRow,
  ShardRegistry,
  TheirShardRow,
} from "../peerBackup/registry.js";
import type {
  PeerBackupPeerHostingYou,
  PeerBackupPeerYouHost,
  PeerBackupRepairStatus,
  PeerBackupShardSummary,
  PeerBackupStats,
  PeerBackupStatusResponse,
} from "./types.js";

/**
 * Snapshot of the repair daemon's recent activity. The repair daemon
 * itself is stateless across ticks (RepairDaemon.repairOnce just
 * computes + emits side-effects). To surface "queued / completed24h /
 * lastTickMs" the runtime layer wraps the daemon's tick in a small
 * accumulator and exposes it via this thunk. When unset the BFF
 * reports an idle / zero status.
 */
export interface RepairStatsProvider {
  snapshot(): {
    state: "idle" | "running" | "error";
    lastTickMs: number | null;
    queued: number;
    completed24h: number;
    lastError?: string;
  };
}

export interface PeerBackupSnapshotDeps {
  /** BackupLoop is the authoritative "are we participating" toggle. */
  backupLoop?: BackupLoop | null;
  /** Shard registry — drives the my-shards / their-shards projections. */
  registry?: ShardRegistry | null;
  /** Best-effort repair-tick history; defaults to idle/zero. */
  repairStats?: RepairStatsProvider | null;
  /**
   * Erasure-coding `k`. Production wiring should pass the BackupLoop's
   * cfg.k; default 3 mirrors `apps/web/public/webapp/views/peer-backup.js`
   * which uses `shard.minReplicas ?? 3`.
   */
  k?: number;
  /**
   * "Online" threshold for `peersBackingYouUp` — peer-link activity newer
   * than this many ms is online. Default 5 minutes mirrors the watchdog
   * timing used by other peer subsystems.
   */
  onlineThresholdMs?: number;
  now?: () => number;
}

const DEFAULT_K = 3;
const DEFAULT_ONLINE_THRESHOLD_MS = 5 * 60_000;

export function buildPeerBackupStatus(
  deps: PeerBackupSnapshotDeps,
): PeerBackupStatusResponse {
  const k = deps.k ?? DEFAULT_K;
  const now = deps.now ?? (() => Date.now());
  const onlineThresholdMs = deps.onlineThresholdMs ?? DEFAULT_ONLINE_THRESHOLD_MS;
  const participating = !!deps.backupLoop?.status().enabled;

  if (!deps.registry) {
    return {
      participating,
      peersBackingYouUp: [],
      peersYouBackUp: [],
      shards: [],
      repair: snapshotRepair(deps.repairStats),
      stats: {
        total: 0,
        durable: 0,
        atRisk: 0,
        yourBytesStored: 0,
        peerBytesHosted: deps.backupLoop?.status().hostingBytes ?? 0,
      },
    };
  }

  const myShards = deps.registry.myShards();
  const theirShards = deps.registry.theirShards();

  const shards = projectMyShards(myShards, k);
  const peersBackingYouUp = projectPeersBackingYouUp(
    myShards,
    now(),
    onlineThresholdMs,
  );
  const peersYouBackUp = projectPeersYouBackUp(theirShards);

  // Bytes accounting. `hostingBytes` from the BackupLoop is the
  // authoritative "bytes I host for others" counter; we also derive a
  // sum from `theirShards()` and prefer the larger of the two so an
  // unwired BackupLoop doesn't under-report.
  const summedTheirBytes = theirShards.reduce((acc, r) => acc + r.sizeBytes, 0);
  const peerBytesHosted = Math.max(
    deps.backupLoop?.status().hostingBytes ?? 0,
    summedTheirBytes,
  );

  const stats: PeerBackupStats = {
    total: shards.length,
    durable: shards.filter((s) => s.replicas >= k).length,
    atRisk: shards.filter((s) => s.replicas < k).length,
    // `MyShardRow` doesn't carry a per-shard byte size yet — honest 0.
    yourBytesStored: 0,
    peerBytesHosted,
  };

  return {
    participating,
    peersBackingYouUp,
    peersYouBackUp,
    shards,
    repair: snapshotRepair(deps.repairStats),
    stats,
  };
}

function projectMyShards(
  rows: MyShardRow[],
  k: number,
): PeerBackupShardSummary[] {
  // Group by encChunkId. Each unique encChunkId becomes one shard entry;
  // `replicas` is the count of rows whose challengeStreak < 3
  // (the same survivor definition used by RepairDaemon).
  const byChunk = new Map<string, MyShardRow[]>();
  for (const r of rows) {
    const key = bytesToHex(r.encChunkId);
    const arr = byChunk.get(key) ?? [];
    arr.push(r);
    byChunk.set(key, arr);
  }
  const out: PeerBackupShardSummary[] = [];
  for (const [shardId, group] of byChunk) {
    const survivors = group.filter((r) => r.challengeStreak < 3).length;
    out.push({
      shardId,
      replicas: survivors,
      minReplicas: k,
      // MyShardRow doesn't yet carry the byte size — honest 0 until
      // it's added. The webapp renders "0 B" rather than "—" in that case.
      bytes: 0,
    });
  }
  // Stable order — newest chunks first based on the earliest storedAt.
  out.sort((a, b) => a.shardId.localeCompare(b.shardId));
  return out;
}

function projectPeersBackingYouUp(
  rows: MyShardRow[],
  nowMs: number,
  onlineThresholdMs: number,
): PeerBackupPeerHostingYou[] {
  // One entry per unique peerServerId; `shardsHosted` counts that
  // peer's distinct (encChunkId, shardIndex) pairs; `lastSeenMs` is the
  // most recent successful challenge OR storedAt fallback.
  const byPeer = new Map<
    string,
    { shards: number; lastSeenMs: number }
  >();
  for (const r of rows) {
    const entry = byPeer.get(r.peerServerId) ?? { shards: 0, lastSeenMs: 0 };
    entry.shards += 1;
    const seen = r.lastChallenge ?? r.storedAt;
    if (seen > entry.lastSeenMs) entry.lastSeenMs = seen;
    byPeer.set(r.peerServerId, entry);
  }
  return [...byPeer.entries()]
    .map(([peerFqdn, v]) => ({
      peerFqdn,
      shardsHosted: v.shards,
      lastSeenMs: v.lastSeenMs,
      online: nowMs - v.lastSeenMs <= onlineThresholdMs,
    }))
    .sort((a, b) => a.peerFqdn.localeCompare(b.peerFqdn));
}

function projectPeersYouBackUp(
  rows: TheirShardRow[],
): PeerBackupPeerYouHost[] {
  // One entry per unique ownerServerId; aggregates shards + bytes.
  const byOwner = new Map<
    string,
    { shards: number; bytes: number; lastFetchedMs: number }
  >();
  for (const r of rows) {
    const entry = byOwner.get(r.ownerServerId) ?? {
      shards: 0,
      bytes: 0,
      lastFetchedMs: 0,
    };
    entry.shards += 1;
    entry.bytes += r.sizeBytes;
    if (r.storedAt > entry.lastFetchedMs) entry.lastFetchedMs = r.storedAt;
    byOwner.set(r.ownerServerId, entry);
  }
  return [...byOwner.entries()]
    .map(([peerFqdn, v]) => ({
      peerFqdn,
      shardsHosted: v.shards,
      bytesHosted: v.bytes,
      lastFetchedMs: v.lastFetchedMs,
    }))
    .sort((a, b) => a.peerFqdn.localeCompare(b.peerFqdn));
}

function snapshotRepair(
  provider: RepairStatsProvider | null | undefined,
): PeerBackupRepairStatus {
  if (!provider) {
    return { state: "idle", lastTickMs: null, queued: 0, completed24h: 0 };
  }
  const s = provider.snapshot();
  const out: PeerBackupRepairStatus = {
    state: s.state,
    lastTickMs: s.lastTickMs,
    queued: s.queued,
    completed24h: s.completed24h,
  };
  if (typeof s.lastError === "string" && s.lastError.length > 0) {
    out.lastError = s.lastError;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
