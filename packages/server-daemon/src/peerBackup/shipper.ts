import {
  signPbRequestPeers,
  type Bytes,
  type Keypair,
  type PbRequestPeers,
} from "@flagship/protocol";
import { createHttpPeerLink } from "./httpPeerLink.js";
import { PeerBackupClient } from "./transport.js";
import type { PeerProvider, ReplacementPeer, ShardPusher } from "./repairDaemon.js";

// ──────────────────────────────────────────────────────────────────────
// Live wiring of the peer-backup interfaces:
//   PeerProvider  → .com POST /api/peer-backup/request-peers (STK-signed)
//   ShardPusher   → HttpPeerLink + PeerBackupClient.putShard
//   ShardFetcher  → HttpPeerLink + PeerBackupClient.getShard (restore)
//   StkResolver   → .com GET /api/peer-backup/stk/:serverDomain (cached)
//
// Every network call is bounded: an unreachable peer must cost one
// timeout, not a hung backup run (the daemon has no uncaughtException
// handler — see the 2026-06-30 heartbeat lesson).
// ──────────────────────────────────────────────────────────────────────

const DEFAULT_OP_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as unknown as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface LivePeerProviderOptions {
  controlPlaneBaseUrl: string;
  myServerId: string;
  mySTK: Keypair;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (msg: string) => void;
}

export function buildLivePeerProvider(opts: LivePeerProviderOptions): PeerProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async requestPeers(args) {
      const request: PbRequestPeers = {
        requesterServerId: opts.myServerId,
        n: args.n,
        shardSizeBytes: args.shardSizeBytes,
        durabilityHint: args.durabilityHint,
        issuedAt: (opts.now ?? Date.now)(),
      };
      const signature = toHex(signPbRequestPeers(request, opts.mySTK));
      try {
        const res = await withTimeout(
          fetchImpl(`${opts.controlPlaneBaseUrl}/api/peer-backup/request-peers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              request,
              signature,
              excludeServerIds: args.excludeServerIds,
            }),
            signal: AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS),
          }),
          DEFAULT_OP_TIMEOUT_MS + 1000,
          "request-peers",
        );
        if (!res.ok) {
          opts.onLog?.(`request-peers rejected: status ${res.status}`);
          return [];
        }
        const json = (await res.json()) as {
          peers?: { serverId?: string; stkPubHex?: string }[];
        };
        const peers: ReplacementPeer[] = [];
        for (const p of json.peers ?? []) {
          if (typeof p.serverId !== "string" || typeof p.stkPubHex !== "string") continue;
          try {
            peers.push({ serverId: p.serverId, stkPub: fromHex(p.stkPubHex) });
          } catch {
            /* skip malformed entry */
          }
        }
        return peers;
      } catch (e) {
        opts.onLog?.(`request-peers failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    },
  };
}

export interface HttpShardTransportOptions {
  myServerId: string;
  mySTK: Keypair;
  fetchImpl?: typeof fetch;
  /** serverId IS the box FQDN, so the default dials `https://<serverId>`. */
  baseUrlFor?: (peerServerId: string) => string;
  timeoutMs?: number;
}

function defaultBaseUrl(peerServerId: string): string {
  return `https://${peerServerId}`;
}

export function buildHttpShardPusher(opts: HttpShardTransportOptions): ShardPusher {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
  const baseUrlFor = opts.baseUrlFor ?? defaultBaseUrl;
  return {
    async push(args) {
      const link = createHttpPeerLink({
        peerBaseUrl: baseUrlFor(args.peerServerId),
        remoteServerId: args.peerServerId,
        myServerId: opts.myServerId,
        mySTK: opts.mySTK,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      const client = new PeerBackupClient(link, opts.mySTK, opts.myServerId);
      try {
        return await withTimeout(
          client.putShard({
            encChunkId: args.encChunkId,
            shardIndex: args.shardIndex,
            bytes: args.bytes,
            peerServerId: args.peerServerId,
          }),
          timeoutMs,
          `putShard→${args.peerServerId}`,
        );
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      } finally {
        client.close();
        link.close();
      }
    },
  };
}

export interface ShardFetcher {
  fetchShard(
    peerServerId: string,
    encChunkId: Bytes,
    shardIndex: number,
  ): Promise<Bytes | null>;
}

export function buildHttpShardFetcher(opts: HttpShardTransportOptions): ShardFetcher {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
  const baseUrlFor = opts.baseUrlFor ?? defaultBaseUrl;
  return {
    async fetchShard(peerServerId, encChunkId, shardIndex) {
      const link = createHttpPeerLink({
        peerBaseUrl: baseUrlFor(peerServerId),
        remoteServerId: peerServerId,
        myServerId: opts.myServerId,
        mySTK: opts.mySTK,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      const client = new PeerBackupClient(link, opts.mySTK, opts.myServerId);
      try {
        const r = await withTimeout(
          client.getShard({ encChunkId, shardIndex }),
          timeoutMs,
          `getShard←${peerServerId}`,
        );
        // The empty-stream reply is the peer's "not held" signal.
        if (!r.ok || !r.bytes || r.bytes.length === 0) return null;
        return r.bytes;
      } catch {
        return null;
      } finally {
        client.close();
        link.close();
      }
    },
  };
}

/**
 * Caller-STK resolver for the frames endpoint — `.com` exact-match
 * directory lookup with a small positive/negative cache so a shard
 * burst doesn't hammer the directory.
 */
export function buildComStkResolver(opts: {
  controlPlaneBaseUrl: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  now?: () => number;
}): (serverId: string) => Promise<Bytes | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttl = opts.cacheTtlMs ?? 10 * 60_000;
  const cache = new Map<string, { at: number; stk: Bytes | null }>();
  return async (serverId: string) => {
    const now = (opts.now ?? Date.now)();
    const hit = cache.get(serverId);
    if (hit && now - hit.at < ttl) return hit.stk ? hit.stk.slice() : null;
    let stk: Bytes | null = null;
    try {
      const res = await fetchImpl(
        `${opts.controlPlaneBaseUrl}/api/peer-backup/stk/${encodeURIComponent(serverId)}`,
        { signal: AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS) },
      );
      if (res.ok) {
        const json = (await res.json()) as { stkPubHex?: string };
        if (typeof json.stkPubHex === "string" && json.stkPubHex.length === 64) {
          stk = fromHex(json.stkPubHex);
        }
      } else if (res.status !== 404 && res.status !== 403) {
        // Transient .com failure: don't negative-cache an outage.
        return null;
      }
    } catch {
      return null;
    }
    cache.set(serverId, { at: now, stk });
    return stk ? stk.slice() : null;
  };
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hexStr: string): Bytes {
  if (!/^[0-9a-f]*$/i.test(hexStr) || hexStr.length % 2 !== 0) throw new Error("bad hex");
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}
