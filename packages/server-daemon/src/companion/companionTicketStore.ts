/**
 * P14 — Companion-browser dock: one-shot tickets.
 *
 * The owner's paired-session mints a short-lived ticket (default TTL 60s).
 * The ticket holder POSTs `/api/companion/redeem` with `{ticketId,
 * ticketSecret}` to exchange it for a 4-hour companion paired-session
 * token. Tickets are single-use; redemption marks them consumed.
 *
 * Storage interface mirrors `AppInviteStore` from `inviteHandler.ts` — a
 * thin async surface so a SQLite-backed store can slot in later without
 * touching the BFF. `InMemoryCompanionTicketStore` is enough for v1: the
 * daemon-restart window is bounded by the 60s TTL so an in-memory ledger
 * never strands a real user.
 *
 * Secrets are NEVER persisted in plaintext. We keep the SHA-256 hex
 * (matches the bearer-invite + recovery-passphrase patterns elsewhere).
 */

import { createHash } from "node:crypto";

export interface CompanionTicketRow {
  ticketId: string;
  /** SHA-256 hex of the random ticket secret. */
  secretHash: string;
  issuedAt: number;
  expiresAt: number;
  /** Set when redeemed; "consumed" tickets must NEVER redeem again. */
  status: "pending" | "consumed";
  consumedAt?: number;
}

export interface CompanionTicketStore {
  insert(row: CompanionTicketRow): Promise<void>;
  /**
   * Atomically transition `ticketId`'s row from "pending" to "consumed",
   * but only if `secretHashMatch === row.secretHash`. Implementations
   * MUST make this race-safe (two simultaneous redeems → exactly one
   * succeeds; the other gets `replay`).
   *
   * Returns `{ row }` on success, or one of the structural failure
   * codes on the other branches so the BFF can map to HTTP statuses
   * deterministically (401 / 409 / 410).
   */
  consumeAtomically(args: {
    ticketId: string;
    secretHashMatch: string;
    consumedAt: number;
  }): Promise<
    | { ok: true; row: CompanionTicketRow }
    | { ok: false; reason: "not-found" | "wrong-secret" | "replay" | "expired" }
  >;
  cleanupExpired(nowMs: number): Promise<number>;
}

export class InMemoryCompanionTicketStore implements CompanionTicketStore {
  private readonly byId = new Map<string, CompanionTicketRow>();

  async insert(row: CompanionTicketRow): Promise<void> {
    this.byId.set(row.ticketId, { ...row });
  }

  async consumeAtomically(args: {
    ticketId: string;
    secretHashMatch: string;
    consumedAt: number;
  }): Promise<
    | { ok: true; row: CompanionTicketRow }
    | { ok: false; reason: "not-found" | "wrong-secret" | "replay" | "expired" }
  > {
    const r = this.byId.get(args.ticketId);
    if (!r) return { ok: false, reason: "not-found" };
    if (r.status === "consumed") return { ok: false, reason: "replay" };
    if (r.expiresAt <= args.consumedAt) {
      return { ok: false, reason: "expired" };
    }
    if (r.secretHash !== args.secretHashMatch) {
      // Don't transition the row — a wrong secret is a denial, not a
      // consumption. The legitimate holder may still redeem within TTL.
      return { ok: false, reason: "wrong-secret" };
    }
    const updated: CompanionTicketRow = {
      ...r,
      status: "consumed",
      consumedAt: args.consumedAt,
    };
    this.byId.set(args.ticketId, updated);
    return { ok: true, row: updated };
  }

  async cleanupExpired(nowMs: number): Promise<number> {
    let n = 0;
    for (const [id, r] of this.byId) {
      if (r.expiresAt <= nowMs && r.status === "pending") {
        this.byId.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /** Test inspector. */
  _all(): CompanionTicketRow[] {
    return [...this.byId.values()].map((r) => ({ ...r }));
  }
}

export function sha256HexOfHex(hex: string): string {
  // Hash the raw bytes the hex encodes (not the ASCII hex string) so
  // we match the same crypto contract callers expect — they hand us a
  // hex secret; we hash its bytes once.
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    // Defensive: fall back to hashing the literal string so we never
    // panic on bad input. The consumeAtomically caller catches the
    // "wrong-secret" branch and emits a 401 either way.
    return createHash("sha256").update(hex).digest("hex");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return createHash("sha256").update(bytes).digest("hex");
}
