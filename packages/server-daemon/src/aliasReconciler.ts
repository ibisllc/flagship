// V5 — periodic alias reconciliation against .com.
//
// The phone-driven Replace flow lands on flagshipserver.com:
// /api/users/:u/apps/:serviceId/rename upserts `user_app_aliases` +
// rotates the voi.ci link. The DAEMON (on the user's box) needs to
// hear about the rename so its reverse-proxy can route the new
// subdomain to the right container.
//
// We could push the change down a tunnel — but the daemon is
// already polling .com for adjacent state (daemon-status, push
// relay, etc.), and Replace is a low-frequency event. So we just
// pull: every N seconds, GET /api/users/:u/apps/aliases and apply
// any diffs via ServicePlatform.setAlias.
//
// Failure mode: a transient network blip leaves the daemon a
// reconcile cycle behind. The next tick catches up. The Worker
// side is idempotent (re-applying the same alias is a no-op via
// ServicePlatform.setAlias's `unchanged` short-circuit), so the
// reconciler is safe to retry without a separate dedup layer.

import type { ServicePlatform } from "./servicePlatform.js";

/** Default poll cadence — 60 seconds. Replace is interactive but
 *  not latency-critical (the user just authorized it on their phone
 *  and reads a 'Renamed.' toast); a minute-of-staleness on the box
 *  is fine. Tests override via `reconcileNow()`. */
const DEFAULT_INTERVAL_MS = 60_000;

export interface AliasReconcilerDeps {
  /** Where .com lives. Production: `https://flagshipserver.com`.
   *  Tests: overrideable. */
  comBaseUrl: string;
  /** The user this daemon's installed apps belong to. */
  username: string;
  /** The platform owns the urlLabel → InstalledService index that the
   *  reverse proxy consults; setAlias mutates it. */
  platform: ServicePlatform;
  /** Injection seam for tests + dev. Production: a thin wrapper
   *  around globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Interval between reconciles. Defaults to 60s. */
  intervalMs?: number;
  /** Optional hook — invoked with the set of (serviceId, oldLabel,
   *  newLabel) tuples that were applied on each tick. Tests use it
   *  to assert; production may wire a log line. */
  onApplied?: (changes: Array<{ serviceId: string; oldLabel?: string; newLabel: string }>) => void;
  /** Optional error sink. Defaults to console.warn. */
  onError?: (e: unknown) => void;
}

interface AliasRow {
  serviceId: string;
  displayLabel: string;
  updatedAt: number;
}

interface AliasesResponse {
  aliases: AliasRow[];
}

export class AliasReconciler {
  private timer: NodeJS.Timeout | undefined;
  /** Latest updatedAt we've seen across all aliases — short-circuits
   *  the apply step when nothing has moved since the last fetch. */
  private highWatermark = 0;
  /** Last-applied label per serviceId. Lets us trace which alias we
   *  pushed into ServicePlatform last, useful for the audit trail when
   *  the .com row is itself rolled back. */
  private readonly lastApplied = new Map<string, string>();

  constructor(private readonly deps: AliasReconcilerDeps) {}

  start(): void {
    if (this.timer) return;
    // Initial reconcile happens immediately + then on a cadence.
    void this.reconcileNow();
    this.timer = setInterval(() => {
      void this.reconcileNow();
    }, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One reconcile pass. Exposed so tests can drive it deterministically
   *  without spinning a real interval. */
  async reconcileNow(): Promise<void> {
    try {
      const rows = await this.fetchAliases();
      if (rows.length === 0) {
        // No aliases on .com — possibly a fresh user, possibly the
        // user reset every app. Either way, nothing to apply.
        return;
      }
      const max = rows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), 0);
      if (max <= this.highWatermark) return; // unchanged
      const applied: Array<{ serviceId: string; oldLabel?: string; newLabel: string }> = [];
      for (const row of rows) {
        const r = this.deps.platform.setAlias(row.serviceId, row.displayLabel);
        if (r.ok && !r.unchanged) {
          applied.push({
            serviceId: row.serviceId,
            ...(r.oldLabel ? { oldLabel: r.oldLabel } : {}),
            newLabel: r.newLabel ?? row.displayLabel,
          });
          this.lastApplied.set(row.serviceId, row.displayLabel);
        }
        // r.ok === false cases:
        //   - 'unknown serviceId' — the daemon hasn't installed this app
        //     yet. That's normal during a fresh install; the next
        //     reconcile (after install lands) will pick it up.
        //   - collision — two .com aliases land on the same label.
        //     The Worker side enforces uniqueness, so this shouldn't
        //     happen in practice; we surface via onError.
        //   - invalid label — the Worker validated this on write, so
        //     a malformed row arriving here means a downgrade attack
        //     or corrupt state. Surface and skip.
        if (!r.ok && r.reason !== "unknown serviceId") {
          this.deps.onError?.(new Error(`alias apply failed for ${row.serviceId}: ${r.reason}`));
        }
      }
      this.highWatermark = max;
      if (applied.length > 0) this.deps.onApplied?.(applied);
    } catch (e) {
      this.deps.onError?.(e);
    }
  }

  private async fetchAliases(): Promise<AliasRow[]> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const url = `${this.deps.comBaseUrl}/api/users/${encodeURIComponent(this.deps.username)}/apps/aliases`;
    // `cache` isn't typed on Node's RequestInit but browsers + Worker
    // runtimes honour it. Cast through so we still pass it at runtime
    // without losing strict TS elsewhere.
    const r = await fetchImpl(url, { cache: "no-store" } as RequestInit);
    if (!r.ok) {
      throw new Error(`alias fetch failed: status ${r.status}`);
    }
    const body = (await r.json()) as AliasesResponse;
    return body.aliases ?? [];
  }
}
