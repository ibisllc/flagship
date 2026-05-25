// Account-level audit feed.
//
// Server-side ingest from other handlers in this package (Disconnect,
// Replace device, Wipe & restart, etc.) plus a polling read API the
// client Activity feed consumes.
//
// Wire shape:
//   GET /api/users/:u/audit?since=<seq>&limit=<n>
//   →  { events: [{ seq, eventKind, detail, devicePrefix, postedAt }, …] }
//
// Events are descending by seq so the latest is first. `since` is an
// exclusive lower bound; the client passes 0 on initial load and
// `events[0].seq` thereafter to fetch incrementally. `limit` is
// clamped to 50.
//
// Privacy: the detail string is surfaced verbatim to the user. It's
// supplied by other handlers in this package — no external input
// path lands here directly — so we trust the source. The handler
// still bounds length on ingest at 256 chars; longer strings get
// truncated rather than rejected so an audit insert never fails the
// triggering operation.

import type {
  AccountType,
  AuditEventStorage,
  AuditEventKind,
  AuditEventRecord,
  AuditRecoveryMethod,
} from "@flagship/storage";
import { malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

export interface AuditEventsDeps {
  auditEvents: AuditEventStorage;
}

export interface AuditEventSummary {
  seq: number;
  eventKind: AuditEventKind;
  detail: string;
  devicePrefix: string;
  postedAt: number;
  /**
   * v1.2 Plan B Phase 5 — account-type snapshot at the time the
   * event landed. Omitted on pre-v1.2 rows that pre-date the
   * 0030_audit_events_v12 migration.
   */
  accountTypeAtEvent?: AccountType;
  /** v1.2 Plan B Phase 5 — quarantine wall-clock ms; omitted unless set. */
  quarantineUntil?: number;
  /** v1.2 Plan B Phase 5 — recovery method ('totp' | 'recovery-code' | 'none'). */
  recoveryMethod?: AuditRecoveryMethod;
}

export interface AuditListResponse {
  events: AuditEventSummary[];
}

const USERNAME_RE = /^[a-z0-9]{3,30}$/; // no hyphens — see labels.ts
const MAX_LIMIT = 50;
const MAX_DETAIL_LEN = 256;

export async function handleGetAuditEvents(
  deps: AuditEventsDeps,
  username: string,
  sinceSeq: number,
  limit: number,
): Promise<HandlerResponseWithHeaders> {
  const norm = username.toLowerCase();
  if (!USERNAME_RE.test(norm)) return malformed("malformed username");
  const cappedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  const cappedSince = Math.max(0, sinceSeq | 0);

  const rows = await deps.auditEvents.list(norm, cappedSince, cappedLimit);
  return ok<AuditListResponse>(
    {
      events: rows.map((r) => {
        const summary: AuditEventSummary = {
          seq: r.seq,
          eventKind: r.eventKind,
          detail: r.detail,
          devicePrefix: r.devicePrefix,
          postedAt: r.postedAt,
        };
        // v1.2 Plan B Phase 5 — only echo the new fields when set so
        // legacy clients that don't know about them just see the
        // unchanged old shape. (Optional fields ⇒ no breaking change
        // for the mobile UI follow-up that wires the rendering.)
        if (r.accountTypeAtEvent !== undefined) {
          summary.accountTypeAtEvent = r.accountTypeAtEvent;
        }
        if (r.quarantineUntil !== undefined) {
          summary.quarantineUntil = r.quarantineUntil;
        }
        if (r.recoveryMethod !== undefined) {
          summary.recoveryMethod = r.recoveryMethod;
        }
        return summary;
      }),
    },
    { "cache-control": "private, no-cache" },
  );
}

/**
 * Best-effort audit insert. Truncates oversized details rather than
 * rejecting so callers (other handlers in this package) can fire-and-
 * forget without bracing for an exception on the audit path. Returns
 * the inserted record so the caller can echo `seq` back if useful.
 */
export async function recordAuditEvent(
  deps: AuditEventsDeps,
  rec: Omit<AuditEventRecord, "seq">,
): Promise<AuditEventRecord> {
  const truncated: Omit<AuditEventRecord, "seq"> = {
    ...rec,
    username: rec.username.toLowerCase(),
    detail: rec.detail.slice(0, MAX_DETAIL_LEN),
  };
  return deps.auditEvents.append(truncated);
}
