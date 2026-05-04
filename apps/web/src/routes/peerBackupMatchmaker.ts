import type { FastifyInstance } from "fastify";
import {
  verifyPbAnnounce,
  verifyPbPeerConfirm,
  verifyPbRequestPeers,
  type PbAnnounce,
  type PbPeerConfirm,
  type PbRequestPeers,
} from "@flagship/protocol";
import { hexToBytes } from "../lib/hex.js";
import type { ServerRegistry } from "./serverRegistry.js";

/**
 * Reciprocity ledger — separate testable class. Enforces:
 *   consumed_backup_bytes * (N/K) ≤ pledged_bytes_total - consumed_pledged_bytes - λ * proof_failure_score
 *
 * Stored per *account* (not per server) so a user with multiple servers
 * shares the same quota. v0 in-memory; v1 persists.
 */
export interface AccountLedgerRow {
  accountId: string;
  pledgedBytesTotal: number;
  consumedPledgedBytes: number;
  consumedBackupBytes: number;
  proofFailureScore: number;
}

export interface ReciprocityLedger {
  ensure(accountId: string): AccountLedgerRow;
  get(accountId: string): AccountLedgerRow | undefined;
  recordPledged(accountId: string, deltaBytes: number): void;
  recordConsumedPledged(accountId: string, deltaBytes: number): void;
  recordConsumedBackup(accountId: string, deltaBytes: number): void;
  recordProofFailure(accountId: string, weight: number): void;
  /** Decay: halve proofFailureScore for accounts older than `windowMs`. */
  decay(now: number, windowMs: number): void;
  permitsRequest(args: {
    accountId: string;
    requestedBytes: number;
    n: number;
    k: number;
    lambda: number;
  }): { ok: true } | { ok: false; reason: string };
}

export class InMemoryReciprocityLedger implements ReciprocityLedger {
  private rows = new Map<string, AccountLedgerRow>();
  private lastDecay = 0;

  ensure(accountId: string): AccountLedgerRow {
    let r = this.rows.get(accountId);
    if (!r) {
      r = {
        accountId,
        pledgedBytesTotal: 0,
        consumedPledgedBytes: 0,
        consumedBackupBytes: 0,
        proofFailureScore: 0,
      };
      this.rows.set(accountId, r);
    }
    return r;
  }

  get(accountId: string): AccountLedgerRow | undefined {
    const r = this.rows.get(accountId);
    return r ? { ...r } : undefined;
  }

  recordPledged(accountId: string, deltaBytes: number): void {
    this.ensure(accountId).pledgedBytesTotal += deltaBytes;
  }
  recordConsumedPledged(accountId: string, deltaBytes: number): void {
    this.ensure(accountId).consumedPledgedBytes += deltaBytes;
  }
  recordConsumedBackup(accountId: string, deltaBytes: number): void {
    this.ensure(accountId).consumedBackupBytes += deltaBytes;
  }
  recordProofFailure(accountId: string, weight: number): void {
    this.ensure(accountId).proofFailureScore += weight;
  }

  decay(now: number, windowMs: number): void {
    if (now - this.lastDecay < windowMs) return;
    this.lastDecay = now;
    for (const r of this.rows.values()) r.proofFailureScore = r.proofFailureScore / 2;
  }

  permitsRequest(args: {
    accountId: string;
    requestedBytes: number;
    n: number;
    k: number;
    lambda: number;
  }): { ok: true } | { ok: false; reason: string } {
    const row = this.ensure(args.accountId);
    if (args.k <= 0 || args.n < args.k) return { ok: false, reason: "invalid n/k" };
    const projected = (row.consumedBackupBytes + args.requestedBytes) * (args.n / args.k);
    const allowance =
      row.pledgedBytesTotal - row.consumedPledgedBytes - args.lambda * row.proofFailureScore;
    if (projected > allowance) {
      return {
        ok: false,
        reason: `would exceed reciprocity allowance: projected=${projected.toFixed(0)} bytes, allowance=${allowance.toFixed(0)} bytes`,
      };
    }
    return { ok: true };
  }
}

export interface PeerCandidate {
  serverId: string;
  pledgedBytes: number;
  shareRatio: number;
  maxShardSize: number;
  region?: string;
  tunnelEndpoint: string;
  freeBytes: number;
  /** Last announce time (ms). Stale entries get pruned. */
  lastAnnounceAt: number;
  /** Account this server belongs to (so we don't co-locate shards on the same account). */
  accountId: string;
}

export interface PeerCandidatePool {
  upsert(c: PeerCandidate): void;
  remove(serverId: string): boolean;
  list(): PeerCandidate[];
  pickN(args: {
    n: number;
    shardSizeBytes: number;
    excludeAccountId: string;
    now: number;
    staleMs: number;
  }): PeerCandidate[];
}

export class InMemoryPeerCandidatePool implements PeerCandidatePool {
  private byServerId = new Map<string, PeerCandidate>();

  upsert(c: PeerCandidate): void {
    this.byServerId.set(c.serverId, { ...c });
  }
  remove(serverId: string): boolean {
    return this.byServerId.delete(serverId);
  }
  list(): PeerCandidate[] {
    return [...this.byServerId.values()].map((c) => ({ ...c }));
  }
  pickN(args: {
    n: number;
    shardSizeBytes: number;
    excludeAccountId: string;
    now: number;
    staleMs: number;
  }): PeerCandidate[] {
    const candidates = [...this.byServerId.values()].filter(
      (c) =>
        c.accountId !== args.excludeAccountId &&
        c.maxShardSize >= args.shardSizeBytes &&
        c.freeBytes >= args.shardSizeBytes &&
        args.now - c.lastAnnounceAt < args.staleMs,
    );
    // Stable sort by region diversity → freeBytes desc.
    const seenRegions = new Set<string>();
    const ordered: PeerCandidate[] = [];
    for (const c of candidates.sort((a, b) => b.freeBytes - a.freeBytes)) {
      const key = c.region ?? "";
      if (!seenRegions.has(key)) {
        seenRegions.add(key);
        ordered.push(c);
      }
    }
    for (const c of candidates) if (!ordered.includes(c)) ordered.push(c);
    return ordered.slice(0, args.n).map((c) => ({ ...c }));
  }
}

export interface MatchmakerOptions {
  serverRegistry: ServerRegistry;
  ledger: ReciprocityLedger;
  pool: PeerCandidatePool;
  /** Lambda penalty per proof-failure-score point. Default 1024 bytes/point. */
  lambda?: number;
  /** Default K for placement (used by request-peers calc). 10 = canonical. */
  defaultK?: number;
  /** Default N for placement. 16 = canonical (10-of-16 = 1.6x overhead). */
  defaultN?: number;
  /** Stale window for /announce entries. Default 6h. */
  poolStaleMs?: number;
  /** Replay window. Default 5 min. */
  maxAgeMs?: number;
  /** Max announces per account-second (sybil resistance). Default 1. */
  maxAnnouncesPerAccountPerSec?: number;
  now?: () => number;
}

interface AnnounceBody {
  request?: {
    serverId?: string;
    pledgedBytes?: number;
    shareRatio?: number;
    maxShardSize?: number;
    region?: string;
    tunnelEndpoint?: string;
    issuedAt?: number;
  };
  signature?: string;
}

interface RequestPeersBody {
  request?: {
    requesterServerId?: string;
    n?: number;
    shardSizeBytes?: number;
    durabilityHint?: "high" | "best-effort";
    issuedAt?: number;
  };
  signature?: string;
}

interface PeerConfirmBody {
  request?: {
    peerServerId?: string;
    requesterServerId?: string;
    shardId?: string;
    issuedAt?: number;
  };
  signature?: string;
}

export function registerPeerBackupMatchmaker(
  app: FastifyInstance,
  opts: MatchmakerOptions,
): void {
  const lambda = opts.lambda ?? 1024;
  const defaultK = opts.defaultK ?? 10;
  const defaultN = opts.defaultN ?? 16;
  const poolStaleMs = opts.poolStaleMs ?? 6 * 60 * 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const maxAnnouncesPerAccountPerSec = opts.maxAnnouncesPerAccountPerSec ?? 1;
  const now = opts.now ?? (() => Date.now());

  const announceWindow = new Map<string, number[]>();

  app.post<{ Body: AnnounceBody }>("/api/peer-backup/announce", async (req, reply) => {
    const r = (req.body ?? {}).request;
    if (
      !r ||
      typeof r.serverId !== "string" ||
      typeof r.pledgedBytes !== "number" ||
      typeof r.shareRatio !== "number" ||
      typeof r.maxShardSize !== "number" ||
      typeof r.tunnelEndpoint !== "string" ||
      typeof r.issuedAt !== "number" ||
      typeof (req.body ?? {}).signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    if (r.pledgedBytes <= 0 || r.maxShardSize <= 0) {
      return reply.status(400).send({ error: "pledgedBytes and maxShardSize must be > 0" });
    }
    const reg = opts.serverRegistry.get(r.serverId);
    if (!reg) return reply.status(404).send({ error: "unknown server" });
    if (reg.revokedAt) return reply.status(403).send({ error: "server is revoked" });

    let sig: Uint8Array;
    try {
      sig = hexToBytes((req.body ?? {}).signature as string);
    } catch {
      return reply.status(400).send({ error: "invalid hex signature" });
    }
    const claim: PbAnnounce = {
      serverId: r.serverId,
      pledgedBytes: r.pledgedBytes,
      shareRatio: r.shareRatio,
      maxShardSize: r.maxShardSize,
      region: typeof r.region === "string" ? r.region : undefined,
      tunnelEndpoint: r.tunnelEndpoint,
      issuedAt: r.issuedAt,
    };
    if (!verifyPbAnnounce(claim, sig, reg.stkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    const age = now() - r.issuedAt;
    if (age > maxAgeMs || age < -60_000) {
      return reply.status(403).send({ error: "stale request" });
    }

    // Sybil rate-limit per account.
    const accountId = reg.userId;
    const t = now();
    const arr = announceWindow.get(accountId) ?? [];
    const fresh = arr.filter((ts) => t - ts < 1000);
    if (fresh.length >= maxAnnouncesPerAccountPerSec) {
      return reply.status(429).send({ error: "announce rate limited" });
    }
    fresh.push(t);
    announceWindow.set(accountId, fresh);

    opts.ledger.ensure(accountId).pledgedBytesTotal = Math.max(
      opts.ledger.ensure(accountId).pledgedBytesTotal,
      r.pledgedBytes,
    );

    opts.pool.upsert({
      serverId: r.serverId,
      pledgedBytes: r.pledgedBytes,
      shareRatio: r.shareRatio,
      maxShardSize: r.maxShardSize,
      region: claim.region,
      tunnelEndpoint: r.tunnelEndpoint,
      freeBytes: r.pledgedBytes, // v0 approximation; v1 will subtract consumed
      lastAnnounceAt: t,
      accountId,
    });
    return { ok: true };
  });

  app.post<{ Body: RequestPeersBody }>("/api/peer-backup/request-peers", async (req, reply) => {
    const r = (req.body ?? {}).request;
    if (
      !r ||
      typeof r.requesterServerId !== "string" ||
      typeof r.n !== "number" ||
      typeof r.shardSizeBytes !== "number" ||
      (r.durabilityHint !== "high" && r.durabilityHint !== "best-effort") ||
      typeof r.issuedAt !== "number" ||
      typeof (req.body ?? {}).signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    if (r.n <= 0 || r.n > 64 || r.shardSizeBytes <= 0) {
      return reply.status(400).send({ error: "n and shardSizeBytes out of range" });
    }
    const reg = opts.serverRegistry.get(r.requesterServerId);
    if (!reg || reg.revokedAt) return reply.status(404).send({ error: "unknown or revoked server" });
    let sig: Uint8Array;
    try {
      sig = hexToBytes((req.body ?? {}).signature as string);
    } catch {
      return reply.status(400).send({ error: "invalid hex signature" });
    }
    const claim: PbRequestPeers = {
      requesterServerId: r.requesterServerId,
      n: r.n,
      shardSizeBytes: r.shardSizeBytes,
      durabilityHint: r.durabilityHint,
      issuedAt: r.issuedAt,
    };
    if (!verifyPbRequestPeers(claim, sig, reg.stkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    if (now() - r.issuedAt > maxAgeMs || now() - r.issuedAt < -60_000) {
      return reply.status(403).send({ error: "stale request" });
    }

    // The reciprocity formula uses the system-wide encoding (K, N) — not the
    // request's `n` peers. A user requesting one peer to replace a single
    // lost shard is still consuming proportionally to the chunk's full N.
    const requestedBytes = r.n * r.shardSizeBytes;
    const permit = opts.ledger.permitsRequest({
      accountId: reg.userId,
      requestedBytes,
      n: defaultN,
      k: defaultK,
      lambda,
    });
    if (!permit.ok) return reply.status(402).send({ error: permit.reason });

    const peers = opts.pool.pickN({
      n: r.n,
      shardSizeBytes: r.shardSizeBytes,
      excludeAccountId: reg.userId,
      now: now(),
      staleMs: poolStaleMs,
    });
    return {
      peers: peers.map((p) => ({
        serverId: p.serverId,
        stkPubKey: bytesToHex(opts.serverRegistry.get(p.serverId)?.stkPub ?? new Uint8Array(0)),
        directEndpoint: parseEndpoint(p.tunnelEndpoint),
        capacity: { freeBytes: p.freeBytes, region: p.region },
      })),
    };
  });

  app.post<{ Body: PeerConfirmBody }>("/api/peer-backup/peer-confirm", async (req, reply) => {
    const c = (req.body ?? {}).request;
    if (
      !c ||
      typeof c.peerServerId !== "string" ||
      typeof c.requesterServerId !== "string" ||
      typeof c.shardId !== "string" ||
      typeof c.issuedAt !== "number" ||
      typeof (req.body ?? {}).signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    const reg = opts.serverRegistry.get(c.peerServerId);
    if (!reg || reg.revokedAt) return reply.status(404).send({ error: "unknown peer" });
    let sig: Uint8Array;
    try {
      sig = hexToBytes((req.body ?? {}).signature as string);
    } catch {
      return reply.status(400).send({ error: "invalid hex signature" });
    }
    const claim: PbPeerConfirm = {
      peerServerId: c.peerServerId,
      requesterServerId: c.requesterServerId,
      shardId: c.shardId,
      issuedAt: c.issuedAt,
    };
    if (!verifyPbPeerConfirm(claim, sig, reg.stkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    if (now() - c.issuedAt > maxAgeMs || now() - c.issuedAt < -60_000) {
      return reply.status(403).send({ error: "stale request" });
    }
    return { ok: true };
  });
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function parseEndpoint(ep: string): { host: string; port: number } {
  const idx = ep.lastIndexOf(":");
  if (idx < 0) return { host: ep, port: 0 };
  const host = ep.slice(0, idx);
  const port = Number(ep.slice(idx + 1));
  return { host, port: Number.isFinite(port) ? port : 0 };
}
