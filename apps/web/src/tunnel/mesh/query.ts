/**
 * The mesh query (relay-mesh.md §7.2 step 4): when the store holds no live winner for a name the log says exists, ask
 * every peer with a live bridge, single-flight per (name, excluded relays), for 1.5 s; the first answer item that is
 * valid and beats what the store holds is added to it. A miss is remembered for 10 s (≤ 50,000 names, LRU); a miss that
 * excluded a refusing relay for 2 s per (name, excluded). Inbound queries are limited to 500 a second per peer (burst
 * 1,000); past that the answer is `{busy:true}` with no lookup.
 */
import { MESH_NEG_CACHE_EXCLUDE_MS, MESH_NEG_CACHE_MAX, MESH_NEG_CACHE_MS, MESH_PEER_QUERY_BURST, MESH_PEER_QUERY_RATE, MESH_QUERY_TIMEOUT_MS } from "@flagship/protocol";
import { TokenBucket, type BridgePeer } from "./bridge.js";

export interface QueryTransport {
  /** Peers with a live bridge. */
  peers(): BridgePeer[];
}

export interface MeshQueryOptions {
  transport: QueryTransport;
  /**
   * Offer an answer item to the store; returns true when it is now the winner for `name` (valid and better than
   * what was held). `from` is the answering peer.
   */
  accept(name: string, item: unknown, from: string): boolean;
  now?: () => number;
  timeoutMs?: number;
}

interface Flight {
  promise: Promise<string | null>;
  resolve: (relayId: string | null) => void;
  waiting: number;
  timer: ReturnType<typeof setTimeout>;
  exclude: ReadonlySet<string>;
}

export class MeshQuery {
  private readonly flights = new Map<string, Flight>();
  private readonly qids = new Map<string, string>();
  private readonly negative = new Map<string, number>();
  /** name → excluded-set key → until (§7.2 step 4: a re-query past a refusing relay). */
  private readonly negativeExcluded = new Map<string, Map<string, number>>();
  private readonly inbound = new Map<string, TokenBucket>();
  private nextQid = 1;
  private readonly now: () => number;
  readonly stats = { sent: 0, hits: 0, misses: 0, negativeHits: 0, busy: 0, inbound: 0 };

  constructor(private readonly opts: MeshQueryOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Ask the peers about `name` (lowercase FQDN). Resolves with the relay id of the answer item that became the winner,
   * or null (nothing within the timeout: remembered as a miss for 10 s).
   */
  ask(name: string, exclude: ReadonlySet<string> = new Set()): Promise<string | null> {
    const neg = this.negative.get(name);
    if (neg !== undefined && exclude.size === 0) {
      if (neg > this.now()) {
        this.stats.negativeHits++;
        return Promise.resolve(null);
      }
      this.negative.delete(name);
    }
    const exKey = [...exclude].sort().join(",");
    const key = exclude.size === 0 ? name : `${name}|${exKey}`;
    if (exclude.size > 0) {
      const until = this.negativeExcluded.get(name)?.get(exKey);
      if (until !== undefined) {
        if (until > this.now()) {
          this.stats.negativeHits++;
          return Promise.resolve(null);
        }
        this.dropExcluded(name, exKey);
      }
    }
    const had = this.flights.get(key);
    if (had) return had.promise;
    const peers = this.opts.transport.peers().filter((p) => !exclude.has(p.relayId));
    if (peers.length === 0) return Promise.resolve(this.miss(name, exclude));
    let resolve!: (v: string | null) => void;
    const promise = new Promise<string | null>((r) => (resolve = r));
    const qid = `q${this.nextQid++}`;
    const f: Flight = {
      promise,
      resolve,
      waiting: peers.length,
      exclude,
      timer: setTimeout(() => this.finish(key, qid, name, null), this.opts.timeoutMs ?? MESH_QUERY_TIMEOUT_MS),
    };
    f.timer.unref?.();
    this.flights.set(key, f);
    this.qids.set(qid, key);
    for (const p of peers) {
      p.send({ type: "query", qid, name });
      this.stats.sent++;
    }
    return promise;
  }

  /** A peer's `answer`. */
  onAnswer(from: BridgePeer, msg: Record<string, unknown>): void {
    const qid = typeof msg.qid === "string" ? msg.qid : null;
    const key = qid ? this.qids.get(qid) : undefined;
    const f = key ? this.flights.get(key) : undefined;
    if (!qid || !key || !f) return;
    const name = key.split("|")[0]!;
    if (msg.busy === true) this.stats.busy++;
    for (const item of Array.isArray(msg.items) ? msg.items : []) {
      if (this.opts.accept(name, item, from.relayId)) {
        const relayId = holderOf(item);
        if (relayId && !f.exclude.has(relayId)) return this.finish(key, qid, name, relayId);
      }
    }
    if (--f.waiting <= 0) this.finish(key, qid, name, null);
  }

  /** An inbound `query`: the rate limit, then `lookup` (the items this relay holds or knows for the name). */
  onQuery(from: BridgePeer, msg: Record<string, unknown>, lookup: (name: string) => unknown[]): void {
    this.stats.inbound++;
    let b = this.inbound.get(from.relayId);
    if (!b) this.inbound.set(from.relayId, (b = new TokenBucket(MESH_PEER_QUERY_RATE, MESH_PEER_QUERY_BURST, this.now)));
    const qid = msg.qid;
    if (typeof qid !== "string" || qid.length > 64) return;
    const allowed = b.take();
    from.noteOverLimit(!allowed);
    if (!allowed) {
      from.send({ type: "answer", qid, items: [], busy: true });
      return;
    }
    const name = typeof msg.name === "string" && msg.name.length <= 253 ? msg.name.toLowerCase() : null;
    from.send({ type: "answer", qid, items: name ? lookup(name) : [] });
  }

  /** Forget a remembered miss (an announcement for the name arrived). */
  clearMiss(name: string): void {
    this.negative.delete(name);
    this.negativeExcluded.delete(name);
  }

  private dropExcluded(name: string, exKey: string): void {
    const m = this.negativeExcluded.get(name);
    if (!m) return;
    m.delete(exKey);
    if (m.size === 0) this.negativeExcluded.delete(name);
  }

  private finish(key: string, qid: string, name: string, relayId: string | null): void {
    const f = this.flights.get(key);
    if (!f) return;
    clearTimeout(f.timer);
    this.flights.delete(key);
    this.qids.delete(qid);
    if (relayId) {
      this.stats.hits++;
      f.resolve(relayId);
    } else f.resolve(this.miss(name, f.exclude));
  }

  private miss(name: string, exclude: ReadonlySet<string>): null {
    this.stats.misses++;
    if (exclude.size === 0) {
      this.negative.delete(name);
      this.negative.set(name, this.now() + MESH_NEG_CACHE_MS);
      while (this.negative.size > MESH_NEG_CACHE_MAX) {
        const oldest = this.negative.keys().next().value as string;
        this.negative.delete(oldest);
      }
    } else {
      const exKey = [...exclude].sort().join(",");
      const m = this.negativeExcluded.get(name) ?? new Map<string, number>();
      this.negativeExcluded.delete(name);
      m.set(exKey, this.now() + MESH_NEG_CACHE_EXCLUDE_MS);
      this.negativeExcluded.set(name, m);
      while (this.negativeExcluded.size > MESH_NEG_CACHE_MAX) this.negativeExcluded.delete(this.negativeExcluded.keys().next().value as string);
    }
    return null;
  }
}

function holderOf(item: unknown): string | null {
  const o = item as { kind?: unknown; attachment?: { relayId?: unknown }; grant?: { holderRelayId?: unknown } } | null;
  if (o?.kind === "phone") return typeof o.grant?.holderRelayId === "string" ? o.grant.holderRelayId : null;
  return typeof o?.attachment?.relayId === "string" ? o.attachment.relayId : null;
}
