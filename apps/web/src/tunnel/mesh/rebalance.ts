/**
 * Rebalancing (relay-mesh.md §10): the home relay counts, per account, visitor sessions by entry relay in one-minute
 * buckets over the last hour (phone traffic is not counted), and every hour (± 10 min) asks `rebalanceDecision`
 * whether the account should move to the relay most of its visitors arrive through. Only completed sessions count,
 * keyed by the visitor's client-address key: an entry's `streams` are its distinct keys and its `bytes` the sum over
 * keys of each key's bytes capped at 8 MiB (§10.1, review 2026-11-03), so one address cannot steer an account.
 */
import {
  REBALANCE_CLIENT_BYTES_CAP,
  REBALANCE_CLIENTS_PER_BUCKET_MAX,
  REBALANCE_BUCKET_MS,
  REBALANCE_INTERVAL_MS,
  REBALANCE_JITTER_MS,
  REBALANCE_WINDOW_MS,
  rebalanceDecision,
  type RebalanceRelay,
  type RebalanceRefusal,
} from "@flagship/protocol";

export interface RebalancerOptions {
  selfRelayId: string;
  now?: () => number;
  /** `FLAGSHIP_MESH_REBALANCE_MS` (tests): the decision cadence; the window is the same length. */
  intervalMs?: number;
  /** The relays as `rebalanceDecision` sees them (directory kind, last `load`). */
  relays: () => RebalanceRelay[];
  homeOf: (account: string) => string | null;
  lastMove: (account: string) => number | null;
  hasLegacyBox: (account: string) => boolean;
  /** Move the account (mint the account move, announce it, hint the boxes). */
  move: (account: string, to: string) => void;
  /** Test shortening of the 6 h spacing (`FLAGSHIP_MESH_MIN_MOVE_MS`). */
  minMoveMs?: number;
}

/** account → bucket start → entry relay → client key → bytes. */
type Buckets = Map<number, Map<string, Map<string, number>>>;

/** The key later clients of a full (account, minute, entry) bucket share. */
export const REBALANCE_OVERFLOW_CLIENT = "~";

export class Rebalancer {
  private readonly accounts = new Map<string, Buckets>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  readonly decisions: Record<string, number> = {};
  moves = 0;

  constructor(private readonly opts: RebalancerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  private get windowMs(): number {
    return this.opts.intervalMs ?? REBALANCE_WINDOW_MS;
  }

  private get bucketMs(): number {
    return Math.max(1, Math.min(REBALANCE_BUCKET_MS, Math.floor(this.windowMs / 60)));
  }

  /**
   * A completed visitor session to a box of `account` that arrived through `entry` (self for local visitors), from the
   * visitor whose client-address key is `client`, carrying `bytes` both ways. Call it once, when the session ends.
   */
  countSession(account: string, entry: string, client: string, bytes: number): void {
    const per = this.slot(account, entry);
    const key = per.has(client) || per.size < REBALANCE_CLIENTS_PER_BUCKET_MAX ? client : REBALANCE_OVERFLOW_CLIENT;
    per.set(key, (per.get(key) ?? 0) + Math.max(0, bytes));
  }

  /** The window the decision sees for an account: per entry, distinct client keys and their capped bytes. */
  window(account: string): Array<{ relayId: string; bytes: number; streams: number }> {
    const buckets = this.accounts.get(account);
    if (!buckets) return [];
    this.prune(buckets, this.now());
    const byEntry = new Map<string, Map<string, number>>();
    for (const per of buckets.values()) {
      for (const [relayId, clients] of per) {
        const m = byEntry.get(relayId) ?? new Map<string, number>();
        for (const [c, b] of clients) m.set(c, (m.get(c) ?? 0) + b);
        byEntry.set(relayId, m);
      }
    }
    return [...byEntry].map(([relayId, clients]) => {
      let bytes = 0;
      for (const b of clients.values()) bytes += Math.min(b, REBALANCE_CLIENT_BYTES_CAP);
      return { relayId, bytes, streams: clients.size };
    });
  }

  start(): void {
    const base = this.opts.intervalMs ?? REBALANCE_INTERVAL_MS;
    const jitter = this.opts.intervalMs !== undefined ? 0 : REBALANCE_JITTER_MS;
    const schedule = () => {
      this.timer = setTimeout(() => {
        this.runOnce();
        schedule();
      }, base + (Math.random() * 2 - 1) * jitter);
      this.timer.unref?.();
    };
    schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One round over every counted account this relay is home for. */
  runOnce(): void {
    const now = this.now();
    for (const [account, buckets] of this.accounts) {
      this.prune(buckets, now);
      if (buckets.size === 0) {
        this.accounts.delete(account);
        continue;
      }
      if (this.opts.homeOf(account) !== this.opts.selfRelayId) continue;
      const window = this.window(account);
      const last = this.opts.lastMove(account);
      const minMove = this.opts.minMoveMs;
      const d = rebalanceDecision({
        home: this.opts.selfRelayId,
        window,
        relays: this.opts.relays(),
        lastMoveAt: last !== null && minMove !== undefined && now - last >= minMove ? null : last,
        hasLegacyBox: this.opts.hasLegacyBox(account),
        now,
      });
      const key = d.move ? "move" : (d as { reason: RebalanceRefusal }).reason;
      this.decisions[key] = (this.decisions[key] ?? 0) + 1;
      if (d.move) {
        this.moves++;
        this.accounts.delete(account);
        this.opts.move(account, d.to);
      }
    }
  }

  private slot(account: string, entry: string): Map<string, number> {
    const now = this.now();
    const start = now - (now % this.bucketMs);
    let buckets = this.accounts.get(account);
    if (!buckets) this.accounts.set(account, (buckets = new Map()));
    let per = buckets.get(start);
    if (!per) {
      buckets.set(start, (per = new Map()));
      this.prune(buckets, now);
    }
    let s = per.get(entry);
    if (!s) per.set(entry, (s = new Map()));
    return s;
  }

  private prune(buckets: Buckets, now: number): void {
    for (const start of buckets.keys()) if (start + this.bucketMs <= now - this.windowMs) buckets.delete(start);
  }
}
