/**
 * Account homes (relay-mesh.md §7.3, §10.3): the relay an account's boxes should be on, computed by every relay from
 * the same replicated data (`accountHome`), and the account moves the home announces when rebalancing. A peer accepts
 * a move only from the relay it computes as the account's home, at most one per account per 6 h (`checkAccountMove`).
 */
import {
  ACCOUNT_MOVE_MIN_INTERVAL_MS,
  ACCOUNT_MOVE_TTL_MS,
  accountHash,
  accountHome,
  checkAccountMove,
  signRelayMeshRecord,
  type AccountMove,
  type AccountMoveRefusal,
  type AttachmentItem,
  type MeshCheckContext,
} from "@flagship/protocol";

export interface SignedAccountMove {
  move: AccountMove;
  signature: string;
}

export interface AccountHomesOptions {
  selfRelayId: string;
  ctx: () => MeshCheckContext;
  /** The winning attachments of an account's boxes (store). */
  winners: (account: string) => AttachmentItem[];
  sign: (msg: Uint8Array) => Uint8Array;
  /** Test shortening of the 6 h spacing (`FLAGSHIP_MESH_MIN_MOVE_MS`). */
  minMoveMs?: number;
}

export class AccountHomes {
  /** accountHash → the accepted move and when it was accepted. */
  private readonly moves = new Map<string, { move: SignedAccountMove; acceptedAt: number }>();
  /** accountHash → when the last move was accepted (kept after the move expires, for the 6 h spacing). */
  private readonly lastMoveAt = new Map<string, number>();
  readonly refused: Record<string, number> = {};

  constructor(private readonly opts: AccountHomesOptions) {}

  /** §7.3: the account's home, or null when no `full` relay holds a live attachment of it. */
  homeOf(account: string): string | null {
    const ctx = this.opts.ctx();
    let h: string;
    try {
      h = accountHash(account);
    } catch {
      return null;
    }
    const m = this.moves.get(h)?.move.move ?? null;
    return accountHome({
      attachments: this.opts.winners(account).map((w) => ({ relayId: w.attachment.relayId, attachedAt: w.attachment.attachedAt })),
      directory: ctx.directory,
      move: m ? { toRelayId: m.toRelayId, notAfter: m.notAfter } : null,
      now: ctx.now,
    });
  }

  /** When the account last moved (for `rebalanceDecision`), or null. */
  lastMove(account: string): number | null {
    try {
      return this.lastMoveAt.get(accountHash(account)) ?? null;
    } catch {
      return null;
    }
  }

  /** A peer's `account-move`: accepted only from the account's current home (as this relay computes it). */
  offer(raw: unknown, account: string | null, from: string): { ok: true } | { ok: false; reason: AccountMoveRefusal | "unknown-account" } {
    const o = raw as { move?: AccountMove; signature?: string } | null;
    if (!o?.move || typeof o.signature !== "string") return this.refuse(from, "malformed");
    const m = o.move;
    const ctx = this.opts.ctx();
    const last = this.lastMoveAt.get(m.accountHash) ?? null;
    // The expected home needs the account name; a relay that holds no box of the account computes it from nothing
    // and falls back to the move's own `from` only when it holds no attachment of the account at all.
    const expected = account ? this.homeOf(account) ?? m.fromRelayId : m.fromRelayId;
    const minMove = this.opts.minMoveMs ?? ACCOUNT_MOVE_MIN_INTERVAL_MS;
    const c = checkAccountMove({ move: m, signature: o.signature, expectedHome: expected, lastAcceptedAt: last !== null && ctx.now - last >= minMove ? null : last, ctx });
    if (!c.ok) return this.refuse(from, c.reason);
    this.moves.set(m.accountHash, { move: { move: m, signature: o.signature }, acceptedAt: ctx.now });
    this.lastMoveAt.set(m.accountHash, ctx.now);
    return { ok: true };
  }

  /** The home moves the account to `to` (§10.3): signed, recorded here, returned to announce. */
  mint(account: string, to: string): SignedAccountMove {
    const now = this.opts.ctx().now;
    const move: AccountMove = { accountHash: accountHash(account), fromRelayId: this.opts.selfRelayId, toRelayId: to, issuedAt: now, notAfter: now + ACCOUNT_MOVE_TTL_MS };
    const s = { move, signature: signRelayMeshRecord("relay-account-move", move, this.opts.sign) };
    this.moves.set(move.accountHash, { move: s, acceptedAt: now });
    this.lastMoveAt.set(move.accountHash, now);
    return s;
  }

  /** Live moves (for a full dump to a new peer). */
  liveMoves(): SignedAccountMove[] {
    const now = this.opts.ctx().now;
    return [...this.moves.values()].filter((m) => m.move.move.notAfter > now).map((m) => m.move);
  }

  sweep(): void {
    const now = this.opts.ctx().now;
    for (const [k, m] of this.moves) if (m.move.move.notAfter <= now) this.moves.delete(k);
  }

  stats(): { moves: number; refused: Record<string, number> } {
    return { moves: this.moves.size, refused: { ...this.refused } };
  }

  private refuse(from: string, reason: AccountMoveRefusal | "unknown-account"): { ok: false; reason: AccountMoveRefusal | "unknown-account" } {
    const k = `${from}:${reason}`;
    this.refused[k] = (this.refused[k] ?? 0) + 1;
    return { ok: false, reason };
  }
}
