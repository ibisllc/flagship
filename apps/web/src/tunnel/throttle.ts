// Per-account speed limit for over-quota Free accounts on the `.services` relay.
//
// Going over the Free allowance used to refuse new connections, which could
// lock an owner out of their own box until the month reset. Over-quota
// accounts are now admitted but slowed: every byte the relay carries for the
// account (both directions — both are metered) is charged to ONE token bucket
// shared by all of that account's streams on this relay machine. The bucket
// never queues data: a charge that overdraws it returns how long the caller
// should pause its source (socket / tunnel backpressure) for the debt to
// refill. Accounts within quota never reach this module.

/** 256 kbit/s — enough to keep a box reachable (pages, chat, unlock
 *  approvals) while making bulk transfer impractical. */
export const DEFAULT_THROTTLE_BYTES_PER_SEC = 32_000;

/** Parse FLAGSHIP_OVER_QUOTA_KBPS (kbit/s) into bytes/second. Unset, empty, or
 *  not a positive number ⇒ undefined (the default applies) — a bad value must
 *  never turn into a zero rate that stalls every over-quota box. */
export function overQuotaBytesPerSec(kbps: string | undefined): number | undefined {
  if (kbps === undefined || kbps.trim() === "") return undefined;
  const n = Number(kbps);
  return Number.isFinite(n) && n > 0 ? (n * 1000) / 8 : undefined;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class AccountThrottle {
  private readonly buckets = new Map<string, Bucket>();
  private readonly burstBytes: number;

  constructor(
    private readonly bytesPerSec: number = DEFAULT_THROTTLE_BYTES_PER_SEC,
    private readonly now: () => number = () => Date.now(),
    burstBytes?: number,
  ) {
    if (!(bytesPerSec > 0)) throw new Error(`throttle rate must be positive, got ${bytesPerSec}`);
    this.burstBytes = burstBytes ?? bytesPerSec;
  }

  /** Charge `bytes` to the account; returns the ms its sources should pause
   *  before carrying more (0 = keep going). */
  charge(account: string, bytes: number): number {
    const t = this.now();
    let b = this.buckets.get(account);
    if (!b) {
      b = { tokens: this.burstBytes, at: t };
      this.buckets.set(account, b);
    }
    b.tokens = Math.min(this.burstBytes, b.tokens + ((t - b.at) * this.bytesPerSec) / 1000);
    b.at = t;
    b.tokens -= bytes;
    return b.tokens >= 0 ? 0 : Math.ceil((-b.tokens * 1000) / this.bytesPerSec);
  }

  /** Drop the account's bucket (it left the over-quota set). */
  forget(account: string): void {
    this.buckets.delete(account);
  }

  /** Test/diagnostics. */
  size(): number {
    return this.buckets.size;
  }
}

/**
 * Pauses one source (a socket or a tunnel) for a debt, resuming when it
 * refills. Overlapping requests extend the pause to the latest deadline;
 * `dispose()` clears the timer so a closed source leaks nothing.
 */
export class SourcePauser {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private until = 0;

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  hold(ms: number): void {
    if (ms <= 0) return;
    const deadline = this.now() + ms;
    if (this.timer && deadline <= this.until) return;
    if (this.timer) clearTimeout(this.timer);
    else this.pause();
    this.until = deadline;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.resume();
    }, deadline - this.now());
  }

  get paused(): boolean {
    return this.timer !== null;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
