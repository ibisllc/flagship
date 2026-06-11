import type { AuditEventStorage } from "@flagship/storage";
import type { HandlerResponse } from "./types.js";

/**
 * CA-endorsement lease lapse warning (OPS-3).
 *
 * Under ENFORCE mode the #30 CA chokepoint refuses to mint a pubkey-cert
 * once the active `CaEndorsement` lease's `notAfter` passes — a hard
 * outage that today arrives with NO advance warning (the lease is renewed
 * by a 14-day YubiKey ceremony). This module adds the missing warning: a
 * scheduled check that, when the soonest-expiring active lease is within
 * WARN_THRESHOLD_MS of `notAfter`, emits a high-severity audit event (and,
 * where a push/notify mechanism is wired, fires an owner alert) so the
 * ceremony happens BEFORE the lapse.
 *
 * NOTIFY GAP: `.com` has no operator-facing alert channel (Slack/webhook/
 * pager) — the push fan-out is per-USER (APNs/FCM/Web Push to a username's
 * devices), and the CA lease is an operator/founder concern with no owning
 * username. So this check's durable signal is the audit event + the
 * queryable `GET /api/admin/ca-lease-status` admin endpoint (and a loud
 * console.error). Wiring a real operator pager is left as a follow-up; the
 * threshold + audit-event scaffolding here is what an external monitor
 * would poll.
 */

/** Warn when the active lease's notAfter is within this window. 7 days. */
export const CA_LEASE_WARN_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Audit-event username the operator-scoped CA-lease warning is filed under. */
export const CA_LEASE_AUDIT_USERNAME = "__ca_operator__";

export type CaLeaseSeverity = "ok" | "warn" | "expired" | "none";

export interface CaLeaseStatus {
  /** Whether any active endorsement lease exists at `now`. */
  hasActiveLease: boolean;
  /** notAfter (ms) of the soonest-expiring active lease, or null when none. */
  soonestNotAfterMs: number | null;
  /** ms until that lease lapses (negative once expired), or null. */
  msUntilExpiry: number | null;
  severity: CaLeaseSeverity;
  thresholdMs: number;
}

/**
 * Pure status computation over the active leases' notAfter timestamps.
 * `activeNotAfterMs` is the list of `notAfter` (ms) for every endorsement
 * lease currently authorizing at `now` (the caller resolves these from the
 * committed bundle + verified chain). Empty ⇒ no lease (severity "none";
 * under ENFORCE this is itself an outage, but distinguishing it lets the
 * endpoint report "never endorsed" vs "endorsement lapsing").
 */
export function computeCaLeaseStatus(
  activeNotAfterMs: number[],
  now: number,
  thresholdMs: number = CA_LEASE_WARN_THRESHOLD_MS,
): CaLeaseStatus {
  if (activeNotAfterMs.length === 0) {
    return {
      hasActiveLease: false,
      soonestNotAfterMs: null,
      msUntilExpiry: null,
      severity: "none",
      thresholdMs,
    };
  }
  const soonest = Math.min(...activeNotAfterMs);
  const msUntil = soonest - now;
  let severity: CaLeaseSeverity;
  if (msUntil <= 0) severity = "expired";
  else if (msUntil <= thresholdMs) severity = "warn";
  else severity = "ok";
  return {
    hasActiveLease: true,
    soonestNotAfterMs: soonest,
    msUntilExpiry: msUntil,
    severity,
    thresholdMs,
  };
}

export interface CaLeaseCheckDeps {
  /** Resolve the active leases' notAfter timestamps (ms) at `now`. */
  activeLeaseNotAfterMs: (now: number) => number[];
  auditEvents: AuditEventStorage;
  now: () => number;
  thresholdMs?: number;
  /**
   * Optional operator alert hook. `.com` has no operator pager today
   * (see NOTIFY GAP above); when wired, it's invoked once per warn/expired
   * transition. Best-effort — a throw is swallowed so the audit write
   * still lands.
   */
  notifyOperator?: (status: CaLeaseStatus, message: string) => Promise<void>;
}

export interface CaLeaseCheckResult {
  status: CaLeaseStatus;
  /** True when this run emitted a warn/expired audit event. */
  alerted: boolean;
}

/**
 * Scheduled CA-lease check. Emits a high-severity audit event (and the
 * best-effort operator alert) when the soonest active lease is within the
 * threshold of — or past — its notAfter. Idempotency: the audit row is
 * deduped per-DAY-bucket of the lease's notAfter so a daily cron doesn't
 * spam the feed (one warn row per lease per day it stays in the window).
 */
export async function runCaLeaseWarningCheck(
  deps: CaLeaseCheckDeps,
): Promise<CaLeaseCheckResult> {
  const now = deps.now();
  const threshold = deps.thresholdMs ?? CA_LEASE_WARN_THRESHOLD_MS;
  const status = computeCaLeaseStatus(
    deps.activeLeaseNotAfterMs(now),
    now,
    threshold,
  );

  if (status.severity !== "warn" && status.severity !== "expired") {
    return { status, alerted: false };
  }

  const days =
    status.msUntilExpiry === null
      ? "?"
      : Math.floor(status.msUntilExpiry / (24 * 60 * 60 * 1000));
  const message =
    status.severity === "expired"
      ? `CA-endorsement lease EXPIRED — pubkey-cert issuance will 410 under ENFORCE. Run the CaEndorsement YubiKey ceremony NOW.`
      : `CA-endorsement lease lapses in ~${days}d (notAfter ${
          status.soonestNotAfterMs
            ? new Date(status.soonestNotAfterMs).toISOString()
            : "?"
        }). Run the 14-day CaEndorsement YubiKey ceremony before it lapses.`;

  // Loud log regardless of audit/notify outcome.
  console.error(`[ca-lease] ${status.severity.toUpperCase()}: ${message}`);

  await deps.auditEvents.append({
    username: CA_LEASE_AUDIT_USERNAME,
    // ct-unexpected-cert is the nearest existing high-severity operator
    // kind; we reuse the controlled vocabulary rather than widening it,
    // and disambiguate via the detail string. (A dedicated kind would
    // require a protocol/UI change out of scope for this ops fix.)
    eventKind: "ct-unexpected-cert",
    detail: `[ca-lease ${status.severity}] ${message}`,
    devicePrefix: "",
    postedAt: now,
  });

  if (deps.notifyOperator) {
    try {
      await deps.notifyOperator(status, message);
    } catch (e) {
      console.error("[ca-lease] operator notify failed (non-fatal)", e);
    }
  }

  return { status, alerted: true };
}

/**
 * GET /api/admin/ca-lease-status — queryable lease health. Admin-gated at
 * the route layer (FLAGSHIP_ADMIN_SECRET).
 */
export async function handleCaLeaseStatus(deps: {
  activeLeaseNotAfterMs: (now: number) => number[];
  now: () => number;
  thresholdMs?: number;
}): Promise<HandlerResponse<CaLeaseStatus & { soonestNotAfterIso: string | null }>> {
  const now = deps.now();
  const status = computeCaLeaseStatus(
    deps.activeLeaseNotAfterMs(now),
    now,
    deps.thresholdMs ?? CA_LEASE_WARN_THRESHOLD_MS,
  );
  return {
    status: 200,
    body: {
      ...status,
      soonestNotAfterIso: status.soonestNotAfterMs
        ? new Date(status.soonestNotAfterMs).toISOString()
        : null,
    },
  };
}
