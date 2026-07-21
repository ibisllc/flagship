/**
 * P14 Phase 2 — Companion write-relay request ledger.
 *
 * Phase 1 made companions strictly read-only: any destination endpoint
 * that mutates pod state under a paired-session token returns 403
 * `companion-write-not-allowed`. Phase 2 adds an *opt-in* queue path: a
 * companion may POST `/api/companion/request-write` with an unsigned
 * intent; the owner's app/webapp polls
 * `GET /api/screens/companion/pending-writes`, signs + dispatches the
 * intent itself, and then POSTs `/api/screens/companion/resolve-pending`
 * to mark the row approved/denied. The companion polls
 * `GET /api/companion/my-pending` for the outcome.
 *
 * The 403 gate on destination endpoints STAYS — this new endpoint is
 * the explicit opt-in path companions take to ask the owner to do the
 * write instead of trying to hit the destination directly.
 *
 * Storage interface mirrors `CompanionTicketStore` + `AppInviteStore`
 * (thin async surface so a SQLite-backed adapter can slot in later).
 * `InMemoryCompanionWriteRequestStore` is enough for v1: the 10-minute
 * TTL bounds the daemon-restart window so an in-memory ledger never
 * strands a real user.
 *
 * IMPORTANT: this store records the unsigned `intent` body verbatim.
 * The owner reads it, decides, then signs + POSTs to the destination
 * itself. We never derive a signature from the queued row — the IRK
 * stays on the owner's phone.
 *
 * Phase 2.5 hook points: see `notifyOwnerOnRequest` + `notifyCompanionOnResolve`
 * comment markers in `screens/companionWriteRelay.ts`. v1 is pure
 * polling; push wiring lands in the next wave.
 */

export type CompanionWriteRequestKind = "release-server" | "revoke-server";

/** Closed v1 set; new kinds add explicit entries. */
export const COMPANION_WRITE_REQUEST_KINDS: readonly CompanionWriteRequestKind[] = [
  "release-server",
  "revoke-server",
] as const;

export function isSupportedWriteRequestKind(
  s: string,
): s is CompanionWriteRequestKind {
  return (COMPANION_WRITE_REQUEST_KINDS as readonly string[]).includes(s);
}

export type CompanionWriteRequestStatus = "pending" | "approved" | "denied";

export interface CompanionWriteRequestRow {
  requestId: string;
  /** First 12 chars of the companion's paired-session token. */
  companionTokenPrefix: string;
  kind: CompanionWriteRequestKind;
  /**
   * The unsigned intent body. v1 is `release-server` / `revoke-server`,
   * both of which carry a `{serverName}` object. We persist the raw
   * object verbatim — the owner reads + signs + dispatches.
   */
  intent: Record<string, unknown>;
  queuedAt: number;
  expiresAt: number;
  status: CompanionWriteRequestStatus;
  /** Set when an owner resolves the row. */
  resolvedAt?: number;
}

export interface CompanionWriteRequestStore {
  insert(row: CompanionWriteRequestRow): Promise<void>;
  get(requestId: string): Promise<CompanionWriteRequestRow | null>;
  /**
   * Owner view — all rows still in `pending` AND not yet past
   * `expiresAt` at `nowMs`. Caller sorts oldest-first.
   */
  listPendingForOwner(nowMs: number): Promise<CompanionWriteRequestRow[]>;
  /**
   * Companion view — every row this companion-token-prefix enqueued,
   * regardless of status (so the poller observes state transitions).
   */
  listForCompanion(
    companionTokenPrefix: string,
  ): Promise<CompanionWriteRequestRow[]>;
  /**
   * Atomically transition `requestId` from `pending` to the supplied
   * outcome. Idempotent: returns `{ ok: true, alreadyResolved: true }`
   * when the row was already resolved (any outcome).
   */
  resolve(args: {
    requestId: string;
    outcome: "approved" | "denied";
    resolvedAt: number;
  }): Promise<
    | { ok: true; alreadyResolved: boolean; row: CompanionWriteRequestRow }
    | { ok: false; reason: "not-found" }
  >;
  /** Drops `pending` rows whose `expiresAt <= nowMs`. Returns count dropped. */
  cleanupExpired(nowMs: number): Promise<number>;
}

export class InMemoryCompanionWriteRequestStore
  implements CompanionWriteRequestStore
{
  private readonly byId = new Map<string, CompanionWriteRequestRow>();

  async insert(row: CompanionWriteRequestRow): Promise<void> {
    this.byId.set(row.requestId, cloneRow(row));
  }

  async get(requestId: string): Promise<CompanionWriteRequestRow | null> {
    const r = this.byId.get(requestId);
    return r ? cloneRow(r) : null;
  }

  async listPendingForOwner(
    nowMs: number,
  ): Promise<CompanionWriteRequestRow[]> {
    const out: CompanionWriteRequestRow[] = [];
    for (const r of this.byId.values()) {
      if (r.status !== "pending") continue;
      if (r.expiresAt <= nowMs) continue;
      out.push(cloneRow(r));
    }
    return out;
  }

  async listForCompanion(
    companionTokenPrefix: string,
  ): Promise<CompanionWriteRequestRow[]> {
    const out: CompanionWriteRequestRow[] = [];
    for (const r of this.byId.values()) {
      if (r.companionTokenPrefix !== companionTokenPrefix) continue;
      out.push(cloneRow(r));
    }
    return out;
  }

  async resolve(args: {
    requestId: string;
    outcome: "approved" | "denied";
    resolvedAt: number;
  }): Promise<
    | { ok: true; alreadyResolved: boolean; row: CompanionWriteRequestRow }
    | { ok: false; reason: "not-found" }
  > {
    const r = this.byId.get(args.requestId);
    if (!r) return { ok: false, reason: "not-found" };
    if (r.status !== "pending") {
      return { ok: true, alreadyResolved: true, row: cloneRow(r) };
    }
    const updated: CompanionWriteRequestRow = {
      ...r,
      status: args.outcome,
      resolvedAt: args.resolvedAt,
    };
    this.byId.set(r.requestId, updated);
    return { ok: true, alreadyResolved: false, row: cloneRow(updated) };
  }

  async cleanupExpired(nowMs: number): Promise<number> {
    let n = 0;
    for (const [id, r] of this.byId) {
      if (r.status === "pending" && r.expiresAt <= nowMs) {
        this.byId.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /** Test inspector. */
  _all(): CompanionWriteRequestRow[] {
    return [...this.byId.values()].map(cloneRow);
  }
}

function cloneRow(r: CompanionWriteRequestRow): CompanionWriteRequestRow {
  // Deep-clone the intent so callers can't mutate stored state by
  // editing the returned reference.
  return {
    ...r,
    intent: JSON.parse(JSON.stringify(r.intent)) as Record<string, unknown>,
  };
}
