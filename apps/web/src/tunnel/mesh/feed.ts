/**
 * The relay log as a mesh relay reads it (docs/architecture-v2/relay-mesh.md §4): the signed head polled from the
 * public feed every 5 s, the pages past the relay's sequence, the derived `RelayLogState`, freshness (§4.6), and the
 * gossip in and out (heads and entries a peer sends are verified exactly like the feed's: nothing is trusted because
 * of where it came from). Every rule is in `@flagship/protocol` (relayMesh.ts); this file fetches and keeps state.
 *
 * The published files may be encrypted (owner decision, chunk B): the reader goes through a `FeedCipher` that turns a
 * fetched file into the plaintext JSON the protocol checks. Signatures are over the plaintext canonical bytes, so the
 * cipher never touches what is verified.
 */
import {
  applyRelayLog,
  emptyRelayLogState,
  FEED_PAGE_ENTRIES,
  FEED_POLL_MS,
  HEAD_CLOSE_ALL_MS,
  HEAD_REFUSE_NEW_MS,
  MESH_LOG_SINCE_MAX,
  newerRelayLogHead,
  relayLogHeadStatus,
  verifyRelayLogHead,
  type RelayLogEntry,
  type RelayLogState,
  type SignedRelayLogEntry,
  type SignedRelayLogHead,
} from "@flagship/protocol";
import { openRelayFeedObject, openRelayMeshKeys } from "@flagship/control-plane";

/** Which published file a body came from. */
export type FeedFileKind = "head" | "page" | "directory";

/**
 * Turns a fetched head or log page into its plaintext JSON (`null`: it cannot be opened, e.g. no key for its epoch
 * yet). `page` is the page asked for (null for the head): a sealed file opens only in the place it was asked for.
 * Production uses `MeshFeedKeys.cipher()` (relay-mesh.md §4.5.1); `plainFeedCipher` reads a clear feed (tests).
 * The directory is published in clear and never goes through it.
 */
export interface FeedCipher {
  open(kind: Exclude<FeedFileKind, "directory">, body: unknown, page: number | null): unknown | null | Promise<unknown | null>;
}

export const plainFeedCipher: FeedCipher = { open: (_kind, body) => body };

/** Where the feed's files come from. Null: not reachable (or not openable) now. */
export interface FeedSource {
  head(): Promise<unknown | null>;
  page(n: number): Promise<unknown | null>;
  directory(): Promise<unknown | null>;
}

/**
 * The public feed over HTTPS (`https://feed.<controlApex>/v1/`, §4.5). Requests carry nothing about the relay: no
 * query string, no credential.
 */
export function httpFeedSource(o: {
  baseUrl: string;
  cipher?: () => FeedCipher;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): FeedSource {
  const base = o.baseUrl.replace(/\/+$/, "");
  const get = async (path: string, kind: FeedFileKind, page: number | null): Promise<unknown | null> => {
    try {
      const res = await (o.fetchImpl ?? fetch)(`${base}/${path}`, { signal: AbortSignal.timeout(o.timeoutMs ?? 5_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (kind === "directory") return body;
      return await (o.cipher?.() ?? plainFeedCipher).open(kind, body, page);
    } catch {
      return null;
    }
  };
  return {
    head: () => get("head.json", "head", null),
    page: (n) => get(`log/${n}.json`, "page", n),
    directory: () => get("directory.json", "directory", null),
  };
}

/**
 * The mesh keys this relay holds (relay-mesh.md §4.5.1): every epoch key `.com` sealed to its relay key, from the
 * blessing answer's `meshKeys` or `v1/keys/<relayId>.json`, kept in memory only. Its `cipher()` opens the sealed head
 * and pages (`openRelayFeedObject`): only as the object and page asked for, only under a key it holds. On an epoch it
 * lacks it fetches its key file once, then treats the file as missing (the relay then catches up from its peers).
 */
export class MeshFeedKeys {
  private readonly keys = new Map<number, Uint8Array>();
  private readonly fetchedFor = new Set<number>();
  current = 0;
  readonly failures: Record<string, number> = {};

  constructor(
    private readonly o: {
      servicesApex: string;
      relayId: string;
      /** The relay key seed (32 bytes): the Ed25519 seed, converted to X25519 to open the sealed lines. */
      seed: Uint8Array;
      /** `v1/keys/<relayId>.json`, or null. */
      fetchKeyFile?: () => Promise<unknown | null>;
      log?: (m: string) => void;
    },
  ) {}

  /** A `RelayMeshKeys` document: keep every epoch key that opens and names this apex, relay and epoch. */
  adopt(doc: unknown): boolean {
    if (doc === null || doc === undefined) return false;
    const r = openRelayMeshKeys(doc, this.o.seed, { servicesApex: this.o.servicesApex, relayId: this.o.relayId });
    if (!r.ok) {
      this.failures[r.reason] = (this.failures[r.reason] ?? 0) + 1;
      return false;
    }
    for (const [e, k] of r.keys) this.keys.set(e, k);
    this.current = Math.max(this.current, r.current);
    return true;
  }

  epochs(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }

  cipher(): FeedCipher {
    return {
      open: async (kind, body, page) => {
        const expect = { servicesApex: this.o.servicesApex, object: kind === "head" ? ("head" as const) : ("log" as const), page: kind === "head" ? null : page };
        let r = await openRelayFeedObject(body, expect, (e) => this.keys.get(e));
        const epoch = (body as { epoch?: unknown } | null)?.epoch;
        if (!r.ok && r.reason === "no-key" && typeof epoch === "number" && !this.fetchedFor.has(epoch) && this.o.fetchKeyFile) {
          this.fetchedFor.add(epoch);
          this.adopt(await this.o.fetchKeyFile());
          r = await openRelayFeedObject(body, expect, (e) => this.keys.get(e));
        }
        if (!r.ok) {
          this.failures[r.reason] = (this.failures[r.reason] ?? 0) + 1;
          return null;
        }
        try {
          return JSON.parse(r.plaintext) as unknown;
        } catch {
          this.failures.malformed = (this.failures.malformed ?? 0) + 1;
          return null;
        }
      },
    };
  }
}

export type ContactState = "ok" | "refuse-new" | "lost";

export interface MeshFeedOptions {
  servicesApex: string;
  /** The log key (`FLAGSHIP_RELAY_LOG_PUB`), hex. */
  logKey: string;
  source: FeedSource;
  now?: () => number;
  pollMs?: number;
  /** Not fresh for this long (since the newest applied head was minted): refuse new tunnels. Default 60 s. */
  refuseNewMs?: number;
  /** …and for this long: close every tunnel. Default 10 min. */
  closeAllMs?: number;
  /** Ask the peers for entries past `since` (when the feed cannot give them). */
  askPeers?: (since: number) => void;
  /** Entries were applied (in order). */
  onEntries?: (entries: SignedRelayLogEntry[], prev: RelayLogState, next: RelayLogState) => void;
  /** A newer head was adopted (gossip it on). */
  onHead?: (head: SignedRelayLogHead) => void;
  log?: (m: string) => void;
}

export interface MeshFeedStats {
  sequence: number;
  headSequence: number;
  headAgeMs: number | null;
  status: "applied" | "behind" | "fork" | "unknown" | "none";
  contact: ContactState;
  quietMs: number;
  rejected: Record<string, number>;
}

/** Entries kept to answer peers' `log-since` and to gossip. */
const RETAINED_ENTRIES = 4 * MESH_LOG_SINCE_MAX;

export class MeshFeed {
  state: RelayLogState;
  /** The newest verified head (from the feed or any peer). */
  head: SignedRelayLogHead | null = null;
  /** True once any head has been applied (a relay with no applied state has no exempt boxes, §4.6). */
  hasAppliedState(): boolean {
    return this.appliedHeadAt !== null;
  }

  /** `issuedAt` of the newest head the state has applied: freshness is measured from it. */
  private appliedHeadAt: number | null = null;
  private readonly startedAt: number;
  private readonly recent: SignedRelayLogEntry[] = [];
  private readonly rejected: Record<string, number> = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private catching: Promise<void> | null = null;
  private readonly now: () => number;
  readonly refuseNewMs: number;
  readonly closeAllMs: number;

  constructor(private readonly opts: MeshFeedOptions) {
    this.state = emptyRelayLogState(opts.servicesApex);
    this.now = opts.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.refuseNewMs = opts.refuseNewMs ?? HEAD_REFUSE_NEW_MS;
    this.closeAllMs = opts.closeAllMs ?? HEAD_CLOSE_ALL_MS;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? FEED_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One head poll (the timer's work; tests call it). */
  async poll(): Promise<void> {
    const h = await this.opts.source.head();
    if (h !== null) this.offerHead(h, "feed");
    await this.catchUp();
  }

  /** A head from the feed or a peer. True when it was newer than the one held (gossip it on). */
  offerHead(raw: unknown, from: string): boolean {
    const h = parseSignedHead(raw);
    if (!h) return this.reject(from, "malformed-head");
    const v = verifyRelayLogHead(h, this.opts.logKey, this.opts.servicesApex);
    if (!v.ok) return this.reject(from, `head-${v.reason}`);
    const newer = newerRelayLogHead(this.head?.head ?? null, h.head);
    if (newer) this.head = h;
    this.noteApplied();
    if (newer) {
      this.opts.onHead?.(h);
      if (relayLogHeadStatus(this.state, h.head) !== "applied") void this.catchUp();
    }
    return newer;
  }

  /** Entries from a page or a peer's `log` message. Returns the ones applied. */
  offerEntries(raw: unknown, from: string): SignedRelayLogEntry[] {
    if (!Array.isArray(raw)) {
      this.reject(from, "malformed-entries");
      return [];
    }
    const entries = raw.filter((e): e is SignedRelayLogEntry => typeof e === "object" && e !== null && typeof (e as SignedRelayLogEntry).signature === "string");
    if (entries.length === 0) return [];
    const prev = this.state;
    const r = applyRelayLog(prev, entries, this.opts.logKey);
    if (!r.ok && r.reason !== "gap") this.reject(from, `entry-${r.reason}`);
    this.state = r.state;
    if (r.applied === 0) return [];
    const applied = entries
      .filter((e) => e.entry.sequence > prev.sequence && e.entry.sequence <= r.state.sequence)
      .sort((a, b) => a.entry.sequence - b.entry.sequence);
    const seen = new Set<number>();
    const unique = applied.filter((e) => (seen.has(e.entry.sequence) ? false : (seen.add(e.entry.sequence), true)));
    this.retain(unique);
    this.noteApplied();
    this.opts.onEntries?.(unique, prev, r.state);
    return unique;
  }

  /** Fetch pages until the state reaches the newest head; ask the peers when the feed cannot help. */
  catchUp(): Promise<void> {
    if (!this.catching) this.catching = this.catchUpOnce().finally(() => (this.catching = null));
    return this.catching;
  }

  private async catchUpOnce(): Promise<void> {
    {
      for (let rounds = 0; rounds < 64; rounds++) {
        const h = this.head;
        if (!h) return;
        const status = relayLogHeadStatus(this.state, h.head);
        if (status === "applied" || status === "unknown") return;
        const before = this.state.sequence;
        const pageNo = Math.floor((before + 1) / FEED_PAGE_ENTRIES);
        const page = await this.opts.source.page(pageNo);
        const entries = page && typeof page === "object" ? (page as { entries?: unknown }).entries : null;
        if (entries) this.offerEntries(entries, "feed");
        if (this.state.sequence === before) {
          this.opts.askPeers?.(before);
          return;
        }
      }
    }
  }

  /** Signed entries with sequence > `since` (≤ `max`) from the retained tail, for a peer's `log-since` / gossip. */
  entriesSince(since: number, max = MESH_LOG_SINCE_MAX): SignedRelayLogEntry[] {
    const out: SignedRelayLogEntry[] = [];
    for (const e of this.recent) {
      if (e.entry.sequence > since) out.push(e);
      if (out.length >= max) break;
    }
    return out;
  }

  /** §4.6: fresh while the newest applied head is younger than the refuse-new threshold. */
  fresh(): boolean {
    return this.contact() === "ok";
  }

  /**
   * How long the relay has not been fresh for, measured from the newest applied head's `issuedAt`. Before its first
   * applied head a relay is not fresh at all (it takes no new tunnels and is 503), and its close-all clock runs from
   * its start.
   */
  quietMs(): number {
    if (this.appliedHeadAt === null) return Math.max(this.now() - this.startedAt, this.refuseNewMs);
    return this.now() - this.appliedHeadAt;
  }

  contact(): ContactState {
    const q = this.quietMs();
    if (q >= this.closeAllMs) return "lost";
    if (q >= this.refuseNewMs) return "refuse-new";
    return "ok";
  }

  stats(): MeshFeedStats {
    const h = this.head?.head ?? null;
    return {
      sequence: this.state.sequence,
      headSequence: h?.sequence ?? 0,
      headAgeMs: h ? this.now() - h.issuedAt : null,
      status: h ? relayLogHeadStatus(this.state, h) : "none",
      contact: this.contact(),
      quietMs: this.quietMs(),
      rejected: { ...this.rejected },
    };
  }

  private noteApplied(): void {
    const h = this.head?.head;
    if (h && relayLogHeadStatus(this.state, h) === "applied" && (this.appliedHeadAt === null || h.issuedAt > this.appliedHeadAt)) {
      // A head minted in the future (a skewed clock at `.com`) counts from now, never later.
      this.appliedHeadAt = Math.min(h.issuedAt, this.now());
    }
  }

  private retain(entries: SignedRelayLogEntry[]): void {
    for (const e of entries) this.recent.push(e);
    if (this.recent.length > RETAINED_ENTRIES) this.recent.splice(0, this.recent.length - RETAINED_ENTRIES);
  }

  private reject(from: string, why: string): false {
    const k = `${from}:${why}`;
    this.rejected[k] = (this.rejected[k] ?? 0) + 1;
    this.opts.log?.(`[mesh-feed] rejected ${why} from ${from}`);
    return false;
  }
}

function parseSignedHead(raw: unknown): SignedRelayLogHead | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.head !== "object" || o.head === null || typeof o.signature !== "string") return null;
  return { head: o.head as SignedRelayLogHead["head"], signature: o.signature };
}

/** The account hash-keyed authority entry kinds that make a relay re-decide boxes or phones. */
export function entryKinds(entries: SignedRelayLogEntry[]): Set<RelayLogEntry["kind"]> {
  return new Set(entries.map((e) => e.entry.kind));
}
