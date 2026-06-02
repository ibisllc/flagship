// Account-level audit feed (live, .com-backed).
//
// Mirror of apps/mobile/{ios,android} AuditLogViewModel. The mobile
// apps read the LIVE identity-plane endpoint
//   GET /api/users/:u/audit?since=<seq>&limit=<n>
// (packages/control-plane/src/auditEvents.ts), rather than the daemon
// BFF screens surface (still on the v1-launch checklist). This lib
// gives the webapp the same live feed so the four surfaces stay at
// parity.
//
// Pagination note (mirrors AuditLogViewModel): the .com endpoint returns
// rows DESC by `seq`, `since` is an EXCLUSIVE LOWER bound, and `limit`
// is server-capped at 50 (MAX_LIMIT in auditEvents.ts). We page by
// growing the request window (`limit += pageSize`) and re-reading from
// `since=0`, then sorting by `seq`. "Load more" stops once the server
// returns fewer rows than the requested window (no more history) or the
// 50-row cap is reached. Events are always presented newest-first.

/** Server-side per-request cap — mirror of MAX_LIMIT in
 *  packages/control-plane/src/auditEvents.ts. */
export const AUDIT_MAX_LIMIT = 50;

const COM_BASE = "https://flagshipserver.com";

/**
 * Human label for an audit event kind. Mirrors AuditLogViewModel.label
 * (iOS) + the inline Activity feed mapping. Covers the v1.1 device-
 * lifecycle kinds AND the v1.2 account-type / TOTP kinds the Worker
 * emits (account-type-changed-*, totp-enrolled, totp-disabled,
 * totp-failed-rate). Unknown kinds fall back to the raw string.
 * @param {string} kind
 * @returns {string}
 */
export function auditKindLabel(kind) {
  return (
    {
      "device-disconnected": "Disconnected device",
      "device-replaced": "Replaced device",
      "device-added": "Added device",
      "wipe-restart": "Wiped & restarted account",
      "recovery-set-up": "Set up recovery",
      "recovery-rotated": "Rotated recovery passkey",
      "app-renamed": "Renamed app URL",
      "account-type-changed-single-to-multi": "Enabled multi-device + 2FA",
      "account-type-changed-multi-to-single": "Disabled multi-device + 2FA",
      "totp-enrolled": "Enrolled 2FA (recovery codes issued)",
      "totp-disabled": "Disabled 2FA",
      "totp-failed-rate": "Too many failed 2FA codes",
      "re-pair": "Re-paired a device",
      "quarantine-blocked-revoke": "Blocked a quarantined device's action",
    }[kind] ?? kind
  );
}

/**
 * Emoji icon for an audit event kind. Mirrors the Activity feed's
 * eventKindIcon (iOS uses SF Symbols; the webapp + Android use emoji).
 * @param {string} kind
 * @returns {string}
 */
export function auditKindIcon(kind) {
  return (
    {
      "device-disconnected": "🔌",
      "device-replaced": "🔄",
      "device-added": "➕",
      "wipe-restart": "🗑️",
      "recovery-set-up": "🔐",
      "recovery-rotated": "🔁",
      "app-renamed": "🔗",
      "account-type-changed-single-to-multi": "🛡️",
      "account-type-changed-multi-to-single": "🛡",
      "totp-enrolled": "🔑",
      "totp-disabled": "🔓",
      "totp-failed-rate": "⚠️",
      "re-pair": "🔗",
      "quarantine-blocked-revoke": "⛔",
    }[kind] ?? "•"
  );
}

/**
 * Fetch one window of audit events from .com. Returns the parsed
 * `events` array (DESC by seq) or throws on a hard transport error.
 * A 404 (unknown user / no rows) resolves to an empty list — the same
 * graceful-degrade AuditLogViewModel applies.
 *
 * @param {string} username
 * @param {{ sinceSeq?: number, limit?: number, fetch?: typeof fetch, baseUrl?: string }} [opts]
 * @returns {Promise<Array<{ seq: number, eventKind: string, detail: string, devicePrefix: string, postedAt: number, accountTypeAtEvent?: string }>>}
 */
export async function fetchAuditEvents(username, opts = {}) {
  if (!username) return [];
  const f = opts.fetch || fetch;
  const baseUrl = opts.baseUrl || COM_BASE;
  const since = Math.max(0, opts.sinceSeq ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 30, AUDIT_MAX_LIMIT));
  const url =
    `${baseUrl}/api/users/${encodeURIComponent(username)}/audit` +
    `?since=${since}&limit=${limit}`;
  const r = await f(url, { cache: "no-store" });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`audit fetch failed: HTTP ${r.status}`);
  const body = await r.json();
  const events = Array.isArray(body.events) ? body.events : [];
  // Defensive: the Worker returns DESC, but sort here so the screen
  // never depends on transport ordering (mirror AuditLogViewModel).
  return events.slice().sort((a, b) => b.seq - a.seq);
}

/**
 * Paginating audit-log model — mirrors AuditLogViewModel's
 * grow-the-window strategy. Construct once per view; call `load()` for
 * a fresh read (also the pull-to-refresh path) and `loadMore()` to grow
 * the window by one page. `canLoadMore` is true iff the server filled
 * the window AND the 50-row cap hasn't been hit.
 */
export function createAuditLogModel({ username, pageSize = 30, fetch: f, baseUrl } = {}) {
  let requestedLimit = Math.max(1, pageSize);
  let events = [];
  let canLoadMore = false;

  async function read(limit) {
    const rows = await fetchAuditEvents(username, {
      sinceSeq: 0,
      limit,
      fetch: f,
      baseUrl,
    });
    events = rows;
    // More history is available iff the server filled the window AND we
    // haven't hit its hard cap.
    canLoadMore = rows.length >= limit && limit < AUDIT_MAX_LIMIT;
    return rows;
  }

  return {
    get events() {
      return events;
    },
    get canLoadMore() {
      return canLoadMore;
    },
    async load() {
      requestedLimit = Math.max(1, pageSize);
      return read(requestedLimit);
    },
    async loadMore() {
      if (!canLoadMore) return events;
      requestedLimit = Math.min(AUDIT_MAX_LIMIT, requestedLimit + pageSize);
      return read(requestedLimit);
    },
  };
}
