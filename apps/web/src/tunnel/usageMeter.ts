// Per-account public-egress metering on the `.services` relay, with budget
// leases from `.com` (billing/docs/spec/report-and-lease-v1.md,
// docs/metering.md).
//
//   relay: add(account, bytes) per buffer → LeaseBook.use (a RAM map update)
//        → report: POST /api/usage/report { batchId, items:[{username,bytes}] }
//        ← { duplicate, results:[{ username, admit, lease:{ action,
//              grantBytes, policy, ttlMs } }] }
//   relay: enforces each lease locally. An account may carry `grantBytes` at
//          full speed before the relay must hear back; a throttle lease (or a
//          spent grant) SLOWS it (throttle.ts), never refuses it, so an owner
//          over the Free allowance can still reach their own box.
//
// Reporting is adaptive: every ~500 ms the relay sends the accounts that are
// due (no lease yet, half the grant spent, or the lease lapsed), and every
// flushIntervalMs (default 60 s) everyone with unreported usage. A batch keeps
// its id across retries, so `.com` counts it once.
//
// Bounds, per account per relay machine:
//   overshoot past the allowance ≤ initialGrant (32 MiB) each time the relay
//     meets the account without a lease (first sight, restart, forgotten
//     after an hour idle); 0 otherwise. Machines add up: E machines carrying
//     one account at once ≤ (E − 1) × 256 MiB more.
//   lost on a relay crash ≤ the current grant (≤ 256 MiB, and a quarter of
//     what's left near the cap) + the batch in flight.
// While `.com` is unreachable the relay fails open: a spent grant doesn't
// slow anyone (explicit throttles stay), usage keeps accumulating, and a batch
// that can't be delivered within 10 minutes is dropped (under-count).
//
// Multiple relay machines each report independently; `.com`'s adds are
// atomic, so the totals sum with no coordination.

import { LeaseBook, type EdgeBatch, type EdgeLease, type LeaseBookOptions } from "@ibisllc/billing-metering";
import { AccountThrottle, DEFAULT_THROTTLE_BYTES_PER_SEC } from "./throttle.js";

export interface UsageMeterOptions {
  /** POST endpoint on `.com`, e.g. https://flagshipserver.com/api/usage/report */
  reportUrl: string;
  /** Shared secret (USAGE_REPORT_SECRET); sent as the `x-usage-secret` header. */
  secret: string;
  /** Slow pass: everyone with unreported usage. Default 60 s (USAGE_FLUSH_MS). */
  flushIntervalMs?: number;
  /** Fast pass for due accounts. Default 500 ms. */
  dueCheckMs?: number;
  fetchImpl?: typeof fetch;
  /** Test hook: invoked after each report attempt. */
  onFlush?: (info: { sent: number; ok: boolean }) => void;
  /** Speed limit for over-quota accounts, bytes/second. Default 32,000 B/s
   *  (256 kbit/s); set on the Fly app via FLAGSHIP_OVER_QUOTA_KBPS. */
  throttleBytesPerSec?: number;
  /** Clock for the throttle and the leases. */
  now?: () => number;
  /** Lease bookkeeping overrides (tests, tuning). */
  leases?: Partial<LeaseBookOptions>;
}

const MiB = 1024 * 1024;
const DEFAULT_FLUSH_MS = 60_000;
const DEFAULT_DUE_CHECK_MS = 500;
/** Batches sent back to back in one flush (a retried one, then new ones). */
const MAX_BATCHES_PER_FLUSH = 4;

/** What a relay may carry for an account before `.com` has answered for it. */
export const INITIAL_GRANT_BYTES = 32 * MiB;

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

const ACTIONS = new Set(["allow", "throttle", "stop"]);

/** The lease in one result. A `.com` from before leases sends only `admit`;
 *  that keeps its semantics (no local limit; throttle on admit:false). */
function leaseFrom(r: Record<string, unknown>, flushIntervalMs: number): EdgeLease | undefined {
  const l = r.lease as Record<string, unknown> | undefined;
  if (
    l &&
    ACTIONS.has(l.action as string) &&
    ACTIONS.has(l.policy as string) &&
    typeof l.grantBytes === "number" &&
    typeof l.ttlMs === "number"
  ) {
    return {
      action: l.action as EdgeLease["action"],
      grant: l.grantBytes,
      policy: l.policy as EdgeLease["policy"],
      ttlMs: l.ttlMs,
    };
  }
  if (typeof r.admit !== "boolean") return undefined;
  return r.admit
    ? { action: "allow", grant: 256 * MiB, policy: "allow", ttlMs: flushIntervalMs }
    : { action: "throttle", grant: 0, policy: "throttle", ttlMs: flushIntervalMs };
}

export class UsageMeter {
  private readonly book: LeaseBook;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private lastFullAt: number;
  private readonly flushIntervalMs: number;
  private readonly dueCheckMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly throttle: AccountThrottle;
  private readonly now: () => number;

  constructor(private readonly opts: UsageMeterOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.dueCheckMs = opts.dueCheckMs ?? DEFAULT_DUE_CHECK_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.throttle = new AccountThrottle(opts.throttleBytesPerSec ?? DEFAULT_THROTTLE_BYTES_PER_SEC, this.now);
    this.book = new LeaseBook({ initialGrant: INITIAL_GRANT_BYTES, unknownPolicy: "throttle", ...opts.leases });
    this.lastFullAt = this.now();
  }

  /** Hot path — add egress bytes for an account. A RAM map update; no I/O. */
  add(account: string | null, bytes: number): void {
    if (!account || bytes <= 0) return;
    this.book.use(account, bytes, this.now());
  }

  /** May this account carry more at full speed right now? Fail-open: only a
   *  lease from `.com` (or a spent grant while `.com` is reachable) says no. */
  admits(account: string | null): boolean {
    return account ? this.book.action(account) === "allow" : true;
  }

  /** Charge carried bytes to a restricted account's speed limit; returns how
   *  long the caller should pause its source (0 = keep going). Allowed
   *  accounts cost one map lookup and are never slowed. */
  throttleDelayMs(account: string | null, bytes: number): number {
    if (!account || this.book.action(account) === "allow") return 0;
    return this.throttle.charge(account, bytes);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.dueCheckMs);
    // Never keep the process alive just for metering.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One timer tick: the slow pass when it is time, else the due accounts. */
  tick(): void {
    if (this.flushing) return;
    const now = this.now();
    if (now - this.lastFullAt >= this.flushIntervalMs) {
      this.lastFullAt = now;
      this.book.prune(now);
      void this.flush("all");
    } else if (this.book.hasDue(now)) {
      void this.flush("due");
    }
  }

  /** Report usage: a failed batch first (same id), then new ones. Never
   *  throws into the data plane. Concurrent calls share one run. */
  flush(mode: "due" | "all" = "all"): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.run(mode).finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  /** Test/diagnostics: number of accounts currently slowed. */
  blockedCount(): number {
    return this.book.restrictedCount();
  }

  /** Test/diagnostics: accounts held in memory. */
  trackedCount(): number {
    return this.book.size();
  }

  private async run(mode: "due" | "all"): Promise<void> {
    let sentAny = false;
    for (let i = 0; i < MAX_BATCHES_PER_FLUSH; i++) {
      const batch = this.book.takeBatch(this.now(), mode);
      if (!batch) break;
      sentAny = true;
      if (!(await this.send(batch))) break;
    }
    if (!sentAny) this.opts.onFlush?.({ sent: 0, ok: true });
  }

  private async send(batch: EdgeBatch): Promise<boolean> {
    const sent = batch.items.length;
    try {
      const resp = await this.fetchImpl(this.opts.reportUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-usage-secret": this.opts.secret },
        body: JSON.stringify({
          batchId: batch.id,
          items: batch.items.map((i) => ({ username: i.account, bytes: i.amount })),
        }),
      });
      if (!resp.ok) {
        // 5xx / 408 / 429: try the same batch again; any other refusal won't
        // change on a retry, so drop it (an under-count).
        const retry = resp.status >= 500 || resp.status === 408 || resp.status === 429;
        this.book.failed(batch, this.now(), retry);
        this.opts.onFlush?.({ sent, ok: false });
        return false;
      }
      const body = (await resp.json().catch(() => null)) as { results?: unknown } | null;
      const leases = new Map<string, EdgeLease>();
      for (const r of Array.isArray(body?.results) ? body.results : []) {
        const rec = r as Record<string, unknown>;
        if (typeof rec.username !== "string") continue;
        const lease = leaseFrom(rec, this.flushIntervalMs);
        if (lease) leases.set(rec.username, lease);
      }
      this.book.settle(batch, leases, this.now());
      for (const { account } of batch.items) {
        if (this.book.action(account) === "allow") this.throttle.forget(account);
      }
      this.opts.onFlush?.({ sent, ok: true });
      return true;
    } catch {
      // Keep serving: a metering outage must never hiccup the data plane.
      this.book.failed(batch, this.now(), true);
      this.opts.onFlush?.({ sent, ok: false });
      return false;
    }
  }
}
