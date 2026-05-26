/**
 * Cross-tick accumulator for the P9 peer-backup BFF's repair-status row.
 *
 * `RepairDaemon.repairOnce` is stateless — each call returns its result
 * and forgets it. To populate `/api/screens/peer-backup/status.repair`
 * the runtime layer wraps the scheduled tick in this accumulator. The
 * accumulator implements `RepairStatsProvider` directly so it can be
 * passed straight into `PeerBackupSnapshotDeps.repairStats`.
 *
 * Wire-up sketch (when the scheduled caller lands):
 *
 *   const accumulator = new RepairStatsAccumulator();
 *   const daemon = new RepairDaemon({ ... });
 *   setInterval(() => accumulator.wrapTick(() => daemon.repairOnce()), N);
 *   buildScreensHttp({ ..., peerBackup: { ..., repairStats: accumulator } });
 *
 * Until that scheduled caller exists the accumulator can be constructed
 * standalone — `.snapshot()` returns idle/zero and the BFF surfaces the
 * same honest-empty payload it does today.
 */

import type { RepairStatsProvider } from "../screens/peerBackupStatus.js";

/**
 * Shape required from a `RepairDaemon.repairOnce()` call. We only use
 * `replaced` from the result so any future expansion of `RepairResult`
 * stays additive.
 */
export interface RepairTickResult {
  replaced: number;
}

export interface RepairStatsAccumulatorOptions {
  /** Test seam. Defaults to `Date.now()`. */
  now?: () => number;
  /** Rolling-window length for `completed24h`. Defaults to 24h. */
  windowMs?: number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

export class RepairStatsAccumulator implements RepairStatsProvider {
  private readonly now: () => number;
  private readonly windowMs: number;
  private state: "idle" | "running" | "error" = "idle";
  private lastTickMs: number | null = null;
  private queued = 0;
  private lastError: string | undefined;
  /** Rolling log of (completedAt, count) entries; pruned to windowMs on every read/write. */
  private readonly completions: { at: number; count: number }[] = [];

  constructor(opts: RepairStatsAccumulatorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Wrap a single tick call. The accumulator transitions to "running"
   * for the duration, stamps `lastTickMs` on completion, and rolls
   * `completed24h` forward by the result's `replaced` count. On throw,
   * state becomes "error" and `lastError` is set; the exception is
   * re-raised so the scheduler can see it.
   */
  async wrapTick<R extends RepairTickResult>(tick: () => Promise<R>): Promise<R> {
    this.beginTick();
    try {
      const r = await tick();
      this.finishTick(r);
      return r;
    } catch (e) {
      this.failTick(e);
      throw e;
    }
  }

  /** Bump the in-flight count (call before kicking off N parallel pushes). */
  setQueued(n: number): void {
    this.queued = Math.max(0, n);
  }

  /** Manual completion bump — used when wrapTick isn't a fit (streaming repair). */
  recordCompleted(count: number, at?: number): void {
    if (count <= 0) return;
    this.completions.push({ at: at ?? this.now(), count });
    this.prune();
  }

  /** Manual error bump — used when wrapTick isn't a fit. */
  recordError(err: unknown): void {
    this.state = "error";
    this.lastError = describeError(err);
  }

  /** Clear any prior error and return to idle. */
  clearError(): void {
    this.state = "idle";
    this.lastError = undefined;
  }

  snapshot(): {
    state: "idle" | "running" | "error";
    lastTickMs: number | null;
    queued: number;
    completed24h: number;
    lastError?: string;
  } {
    this.prune();
    const completed24h = this.completions.reduce((acc, c) => acc + c.count, 0);
    const out: {
      state: "idle" | "running" | "error";
      lastTickMs: number | null;
      queued: number;
      completed24h: number;
      lastError?: string;
    } = {
      state: this.state,
      lastTickMs: this.lastTickMs,
      queued: this.queued,
      completed24h,
    };
    if (this.lastError) out.lastError = this.lastError;
    return out;
  }

  private beginTick(): void {
    this.state = "running";
  }

  private finishTick(r: RepairTickResult): void {
    this.lastTickMs = this.now();
    if (r.replaced > 0) {
      this.completions.push({ at: this.lastTickMs, count: r.replaced });
    }
    this.queued = 0;
    this.state = "idle";
    this.lastError = undefined;
    this.prune();
  }

  private failTick(e: unknown): void {
    this.lastTickMs = this.now();
    this.queued = 0;
    this.state = "error";
    this.lastError = describeError(e);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.completions.length > 0 && this.completions[0]!.at < cutoff) {
      this.completions.shift();
    }
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
