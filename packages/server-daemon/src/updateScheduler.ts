/**
 * 6-hour-jittered pull scheduler for the update-pack distribution
 * subsystem.
 *
 * The daemon's `ServicePlatform.install` records an `AppPullState` for every
 * cross-creator app it installs. This scheduler scans the state store on
 * each tick and calls `UpdateClient.pullOne` for each app. Per-app jitter
 * ensures a fleet of subscribers doesn't synchronize their pulls (which
 * would all hit the canonical home in the same second).
 *
 * Cadence:
 *   - Initial tick fires `initialDelayMs` (default 5 min) after `start()`,
 *     so a freshly-installed app gets its first update check before the
 *     full 6h elapses, but not so fast that we hammer the canonical home
 *     during install storms.
 *   - Subsequent ticks fire every `intervalMs` ± `jitterMs/2` (default
 *     6h ± 30 min).
 *
 * The scheduler is single-flight per app: if a pull is still running when
 * the next tick fires, we skip it and pick up next time. The scheduler
 * itself is single-threaded (Node event loop) so we don't need locking.
 *
 * Failures are logged + isolated per app — one app's halted pull does
 * not block the others. The repair pathway is the next tick.
 */

import type { AppPullStateStore, PullResult, UpdateClient } from "./updateClient.js";

export interface UpdateSchedulerDeps {
  client: UpdateClient;
  store: AppPullStateStore;
  /** Interval between full sweeps. Default 6h. */
  intervalMs?: number;
  /** First sweep delay after start(). Default 5 min. */
  initialDelayMs?: number;
  /** Sweep cadence jitter ± half this. Default 30 min (=> ±15 min). */
  jitterMs?: number;
  /** Per-app extra delay between pulls in the same sweep. Default 0. */
  perAppGapMs?: number;
  /** Test seam — replace setTimeout. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  random?: () => number;
  /** Receive a callback after every per-app pull. Useful for tests + metrics. */
  onResult?: (serviceId: string, result: PullResult) => void;
  /** Called when a pull throws (the scheduler doesn't propagate). */
  onError?: (serviceId: string, err: Error) => void;
}

export class UpdateScheduler {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly jitterMs: number;
  private readonly perAppGapMs: number;
  private readonly random: () => number;
  private readonly setTimeout: typeof setTimeout;
  private readonly clearTimeout: typeof clearTimeout;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: UpdateSchedulerDeps) {
    this.intervalMs = deps.intervalMs ?? 6 * 60 * 60 * 1000;
    this.initialDelayMs = deps.initialDelayMs ?? 5 * 60 * 1000;
    this.jitterMs = deps.jitterMs ?? 30 * 60 * 1000;
    this.perAppGapMs = deps.perAppGapMs ?? 0;
    this.random = deps.random ?? Math.random;
    this.setTimeout = deps.setTimeoutImpl ?? setTimeout;
    this.clearTimeout = deps.clearTimeoutImpl ?? clearTimeout;
  }

  /** Schedule the first sweep. Idempotent. */
  start(): void {
    if (this.stopped) {
      throw new Error("UpdateScheduler.start called after stop");
    }
    if (this.timer) return;
    this.timer = this.setTimeout(() => void this.tick(), this.initialDelayMs);
    // Don't keep Node alive solely on this timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Cancel the next sweep + refuse to schedule more. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one full sweep immediately. Useful for tests + for triggering an
   * out-of-band pull (e.g. when the user taps "check for updates" on the
   * phone). Returns once every per-app pull is done.
   */
  async sweepNow(): Promise<Map<string, PullResult>> {
    if (!this.deps.store.list) {
      // Without `list()`, the scheduler has nothing to iterate.
      return new Map();
    }
    const appIds = await this.deps.store.list();
    const results = new Map<string, PullResult>();
    for (const serviceId of appIds) {
      if (this.running.has(serviceId)) {
        // Skip if a previous tick's pull is still in flight.
        continue;
      }
      this.running.add(serviceId);
      try {
        const r = await this.deps.client.pullOne({ serviceId });
        results.set(serviceId, r);
        this.deps.onResult?.(serviceId, r);
      } catch (e) {
        this.deps.onError?.(serviceId, e as Error);
      } finally {
        this.running.delete(serviceId);
      }
      if (this.perAppGapMs > 0) {
        await new Promise<void>((resolve) =>
          this.setTimeout(() => resolve(), this.perAppGapMs),
        );
      }
    }
    return results;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.sweepNow();
    } catch (e) {
      // sweepNow already isolates per-app errors; an outer throw means
      // the store.list() failed. Don't propagate; let the next tick try.
      this.deps.onError?.("", e as Error);
    } finally {
      if (!this.stopped) {
        // ± jitterMs/2 around intervalMs.
        const half = this.jitterMs / 2;
        const offset = (this.random() - 0.5) * 2 * half;
        const delay = Math.max(1000, this.intervalMs + offset);
        this.timer = this.setTimeout(() => void this.tick(), delay);
        (this.timer as { unref?: () => void }).unref?.();
      }
    }
  }
}
