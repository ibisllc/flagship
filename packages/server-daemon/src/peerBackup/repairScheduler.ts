/**
 * B4 — production-side scheduler that drives `RepairDaemon.repairOnce`
 * on a fixed interval and routes the result through a
 * `RepairStatsAccumulator` so the P9 BFF can surface live repair
 * status.
 *
 * Today (May 2026) the upstream peer-backup data plane (shard upload,
 * matchmaker, peer placement) is partially-wired in production — the
 * `BackupLoop` participation toggle ships but the shard registry +
 * peer-side HTTP adapters (`PeerProvider`, `ShardPusher`,
 * `OwnerShardLoader`) are not yet bolted into the daemon's boot path.
 * Without those a real `RepairDaemon` can't be constructed.
 *
 * This scheduler is constructed at boot anyway. When the daemon
 * argument is null the scheduler is a no-op — `.start()` doesn't
 * arm an interval, the accumulator stays idle, and the BFF surfaces
 * "idle / lastTickMs:null / 0 completed / 0 queued" (identical to
 * the pre-B4 null-provider default). Once the upstream lands, passing
 * a real `RepairDaemon` to the constructor (or `setDaemon` for late
 * binding) is enough to make the scheduler active — no other wiring
 * change is required.
 */

import type { RepairDaemon, RepairResult } from "./repairDaemon.js";
import type { RepairStatsAccumulator } from "./repairStatsAccumulator.js";

export interface RepairSchedulerOptions {
  /** The accumulator that wraps each tick and exposes
   *  `snapshot()` to the BFF. Required so the scheduler has somewhere
   *  to report state even when no daemon is wired. */
  accumulator: RepairStatsAccumulator;
  /** Real daemon to drive. Pass null until the upstream peer-backup
   *  data plane is wired — `.start()` becomes a no-op. */
  daemon?: RepairDaemon | null;
  /** Interval between ticks in ms. Default 5 min — balances
   *  responsiveness against the cost of re-walking the shard registry
   *  on a healthy network. Tunable per pod via the daemon boot env. */
  intervalMs?: number;
  /** Optional logger hook for failed ticks. Defaults to console.warn. */
  onError?: (err: unknown) => void;
  /** Test seam — defaults to `globalThis.setInterval` /
   *  `globalThis.clearInterval`. Tests inject a synchronous fake. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export class RepairScheduler {
  private readonly accumulator: RepairStatsAccumulator;
  private daemon: RepairDaemon | null;
  private readonly intervalMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly _setInterval: typeof setInterval;
  private readonly _clearInterval: typeof clearInterval;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RepairSchedulerOptions) {
    this.accumulator = opts.accumulator;
    this.daemon = opts.daemon ?? null;
    this.intervalMs = Math.max(1_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.onError =
      opts.onError ??
      ((e) => console.warn(`[repair-scheduler] tick failed: ${describe(e)}`));
    this._setInterval = opts.setInterval ?? setInterval;
    this._clearInterval = opts.clearInterval ?? clearInterval;
  }

  /** Late-bind a daemon. Lets boot construct the scheduler before the
   *  upstream peer-backup pieces are ready and swap a real daemon in
   *  later without re-constructing. Idempotent. */
  setDaemon(daemon: RepairDaemon | null): void {
    this.daemon = daemon;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  /** Begin the tick interval. No-op when no daemon is wired or when
   *  already started. Safe to call multiple times. */
  start(): void {
    if (this.handle !== null) return;
    if (!this.daemon) return;
    this.handle = this._setInterval(() => {
      void this.tickOnce();
    }, this.intervalMs);
    // Node-only: don't keep the event loop alive solely for this
    // interval. The daemon's HTTP server is the lifecycle anchor.
    const h = this.handle as { unref?: () => void };
    if (typeof h.unref === "function") h.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    this._clearInterval(this.handle);
    this.handle = null;
  }

  /** Single tick. Public so the daemon (or a test) can force a tick
   *  without waiting for the interval. Returns the result or null if
   *  no daemon is wired. */
  async tickOnce(): Promise<RepairResult | null> {
    const d = this.daemon;
    if (!d) return null;
    try {
      return await this.accumulator.wrapTick(() => d.repairOnce());
    } catch (e) {
      this.onError(e);
      return null;
    }
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}
