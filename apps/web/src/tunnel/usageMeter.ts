// Per-account public-egress accumulator on the `.services` relay.
//
// Approximate BY DESIGN (see docs/monetization-free-tier-first.md). The hot
// path is a RAM integer add per buffer; deltas flush to `.com` periodically
// and are LOST on restart / flush-failure. The slop is always in the tolerable
// direction — a free account over quota keeps full speed until the next flush
// flips its over-quota bit (≤ one interval of overage), and a lost delta
// under-counts ("the user gets a bit more"), never stalls traffic.
//
//   relay: counter[account] += bytes   (in routeToTunnel, per buffer)
//        → flush every ~20s: POST /api/usage/report { items:[{username,bytes}] }
//        ← response { results:[{username, admit}] }  → update RAM over-quota set
//   relay: an over-quota account is SLOWED, never refused (throttle.ts) — so an
//          owner over the Free allowance can still reach their own box.
//
// Multiple relay machines each accumulate + flush independently; `.com`'s
// addEgress is an atomic `+=`, so the totals sum with no coordination.

import { AccountThrottle, DEFAULT_THROTTLE_BYTES_PER_SEC } from "./throttle.js";

export interface UsageMeterOptions {
  /** POST endpoint on `.com`, e.g. https://flagshipserver.com/api/usage/report */
  reportUrl: string;
  /** Shared secret (USAGE_REPORT_SECRET); sent as the `x-usage-secret` header. */
  secret: string;
  /** Flush cadence. Default 20s. */
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Test hook: invoked after each flush attempt. */
  onFlush?: (info: { sent: number; ok: boolean }) => void;
  /** Speed limit for over-quota accounts, bytes/second. Default 32,000 B/s
   *  (256 kbit/s); set on the Fly app via FLAGSHIP_OVER_QUOTA_KBPS. */
  throttleBytesPerSec?: number;
  /** Test hook: the throttle's clock. */
  now?: () => number;
}

const DEFAULT_FLUSH_MS = 20_000;

/** Account (username) from a pod canonical
 *  (`<server>.<user>.flagship.services` or `<user>.flagship.services` → the
 *  `<user>` label). Returns null when the name isn't a flagship.services
 *  canonical (we don't meter what we can't attribute). */
export function accountFromCanonical(podCanonical: string): string | null {
  const lower = podCanonical.trim().toLowerCase();
  const stem = lower.replace(/\.flagship\.services$/, "");
  if (stem === lower || stem.length === 0) return null;
  const labels = stem.split(".").filter(Boolean);
  return labels.length ? labels[labels.length - 1]! : null;
}

export class UsageMeter {
  private readonly counters = new Map<string, number>(); // account -> bytesSinceFlush
  private readonly blocked = new Set<string>(); // free accounts currently over quota
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly throttle: AccountThrottle;

  constructor(private readonly opts: UsageMeterOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.throttle = new AccountThrottle(
      opts.throttleBytesPerSec ?? DEFAULT_THROTTLE_BYTES_PER_SEC,
      opts.now,
    );
  }

  /** Hot path — add egress bytes for an account. A RAM map add; no I/O. */
  add(account: string | null, bytes: number): void {
    if (!account || bytes <= 0) return;
    this.counters.set(account, (this.counters.get(account) ?? 0) + bytes);
  }

  /** Is this account within quota? Default-yes — only an explicit over-quota
   *  verdict from `.com` says otherwise (fail-open). */
  admits(account: string | null): boolean {
    return account ? !this.blocked.has(account) : true;
  }

  /** Charge carried bytes to an over-quota account's speed limit; returns how
   *  long the caller should pause its source (0 = keep going). Within-quota
   *  accounts cost one set lookup and are never slowed. */
  throttleDelayMs(account: string | null, bytes: number): number {
    if (!account || !this.blocked.has(account)) return 0;
    return this.throttle.charge(account, bytes);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Never keep the process alive just for metering.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Snapshot + reset BEFORE the network call (optimistic): a failed flush
   *  DROPS the deltas (under-count) rather than risking a double-count on the
   *  next interval. Never throws into the data plane (fail-open). */
  async flush(): Promise<void> {
    if (this.counters.size === 0) {
      this.opts.onFlush?.({ sent: 0, ok: true });
      return;
    }
    const items = [...this.counters].map(([username, bytes]) => ({ username, bytes }));
    this.counters.clear();
    try {
      const resp = await this.fetchImpl(this.opts.reportUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-usage-secret": this.opts.secret },
        body: JSON.stringify({ items }),
      });
      if (resp.ok) {
        const body = (await resp.json().catch(() => null)) as
          | { results?: Array<{ username: string; admit: boolean }> }
          | null;
        for (const r of body?.results ?? []) {
          if (r.admit) {
            this.blocked.delete(r.username);
            this.throttle.forget(r.username);
          } else this.blocked.add(r.username);
        }
      }
      this.opts.onFlush?.({ sent: items.length, ok: resp.ok });
    } catch {
      // Deltas already dropped; keep serving — a metering outage must never
      // hiccup the data plane.
      this.opts.onFlush?.({ sent: items.length, ok: false });
    }
  }

  /** Test/diagnostics: number of accounts currently slowed. */
  blockedCount(): number {
    return this.blocked.size;
  }
}
