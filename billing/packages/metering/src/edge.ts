// Budget leases (spec/report-and-lease-v1.md), the edge side.
//
// A LeaseBook is the in-memory state an edge keeps for ONE metered resource:
// per account, the usage not yet reported and the lease central last
// granted. It does no I/O and reads no clock; the host passes `now`, sends
// the batches it hands out and feeds back the answers.
//
//   hot path   use(account, amount, now)    a map update; true when the
//                                           account just became due
//              action(account, now)         "allow" | "throttle" | "stop"
//   reporting  takeBatch(now, "due"|"all")  next batch (a failed one first,
//                                           with the same id)
//              settle(batch, leases, now)   central answered
//              failed(batch, now, retry)    it did not
//
// Adaptive reporting: an account is due (worth an early report) when it has
// unreported usage and either has no lease yet, has spent `renewAt` of its
// grant, or its lease has lapsed. Everyone else waits for the host's slow
// "all" pass. Grants shrink as an account nears its allowance, so accounts
// near the limit report more often without any extra rule.
//
// Usage lost if the edge crashes: per account, at most what it has spent on
// its current lease (≤ the grant, which central caps at maxGrant), plus a
// batch in flight; for an account without a lease, at most initialGrant.
// Exception: while central is unreachable and failOpen is on, an exhausted
// grant stops restricting and usage keeps accumulating unreported.

import type { MeterAction, OverAllowancePolicy } from "./meter.js";
import type { MeterLease } from "./lease.js";

export type EdgeLease = Pick<MeterLease, "action" | "grant" | "policy" | "ttlMs">;

export interface LeaseBookOptions {
  /** Units an account with no lease (first seen, or forgotten) may use before
   *  its first answer arrives. */
  initialGrant: number;
  /** What an account with no lease gets once it spends initialGrant before
   *  an answer arrives. */
  unknownPolicy: OverAllowancePolicy;
  /** Report an account once it has spent this share of its grant. Default 0.5. */
  renewAt?: number;
  /** While the last report failed to reach central, a spent grant does not
   *  restrict (a throttle or stop lease still does). Default true. */
  failOpen?: boolean;
  /** Most accounts in one batch. Default 500. */
  maxItems?: number;
  /** Retry a failed batch, with the same id, for this long after it was
   *  taken; then drop it (an under-count). Must stay well below central's
   *  batch keep time. Default 10 minutes. */
  retryForMs?: number;
  /** Forget an idle account this long after its lease lapsed (or after its
   *  last use, without one). Default 1 hour. */
  forgetAfterMs?: number;
  /** Random batch id; default 32 hex digits from crypto.getRandomValues. */
  newBatchId?: () => string;
}

export interface EdgeBatch {
  id: string;
  items: Array<{ account: string; amount: number }>;
  /** When the batch was taken (retries keep it). */
  takenAt: number;
  attempts: number;
  /** Earliest next retry, after a retryable failure. */
  retryAt: number;
}

interface HeldLease {
  action: MeterAction;
  grant: number;
  policy: OverAllowancePolicy;
  expiresAt: number;
}

interface AccountState {
  /** Used and not yet in a batch. */
  pending: number;
  /** Used since the current lease's base (or since first seen, without one). */
  spent: number;
  lastUseAt: number;
  lease?: HeldLease;
}

function randomBatchId(): string {
  const c = (globalThis as { crypto?: { getRandomValues<T extends Uint8Array>(a: T): T } }).crypto;
  if (!c) throw new Error("no crypto.getRandomValues; pass newBatchId");
  return [...c.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class LeaseBook {
  private readonly states = new Map<string, AccountState>();
  private readonly due = new Set<string>();
  private retained: EdgeBatch | undefined;
  private inFlight: EdgeBatch | undefined;
  private unreachable = false;
  private readonly renewAt: number;
  private readonly failOpen: boolean;
  private readonly maxItems: number;
  private readonly retryForMs: number;
  private readonly forgetAfterMs: number;
  private readonly newBatchId: () => string;
  /** Batches dropped unconfirmed (after retryForMs, or refused by central). */
  droppedBatches = 0;

  constructor(private readonly opts: LeaseBookOptions) {
    if (!(opts.initialGrant >= 0)) throw new RangeError("initialGrant must be ≥ 0");
    this.renewAt = opts.renewAt ?? 0.5;
    if (!(this.renewAt > 0 && this.renewAt <= 1)) throw new RangeError("renewAt must be in (0, 1]");
    this.failOpen = opts.failOpen ?? true;
    this.maxItems = opts.maxItems ?? 500;
    this.retryForMs = opts.retryForMs ?? 10 * 60_000;
    this.forgetAfterMs = opts.forgetAfterMs ?? 60 * 60_000;
    this.newBatchId = opts.newBatchId ?? randomBatchId;
  }

  /** Count `amount` units for the account. Returns true when this made the
   *  account due (the host may report early). */
  use(account: string, amount: number, now: number): boolean {
    if (!(amount > 0)) return false;
    let st = this.states.get(account);
    if (!st) {
      st = { pending: 0, spent: 0, lastUseAt: now };
      this.states.set(account, st);
    }
    st.pending += amount;
    st.spent += amount;
    st.lastUseAt = now;
    if (!this.due.has(account) && this.isDue(st, now)) {
      this.due.add(account);
      return true;
    }
    return false;
  }

  /** What the host must do for this account right now. */
  action(account: string): MeterAction {
    const st = this.states.get(account);
    if (!st) return "allow";
    const l = st.lease;
    if (!l) return st.spent >= this.opts.initialGrant ? this.restrict(this.opts.unknownPolicy) : "allow";
    if (l.action !== "allow") return l.action;
    return st.spent >= l.grant ? this.restrict(l.policy) : "allow";
  }

  /** Is an early report worth sending now? (Due accounts, or a failed batch
   *  whose backoff has passed.) */
  hasDue(now: number): boolean {
    if (this.inFlight) return false;
    if (this.retained) return this.retained.retryAt <= now;
    return this.due.size > 0;
  }

  /** The next batch to send: a failed batch first (same id), else the due
   *  accounts ("due") or every account with unreported usage ("all").
   *  undefined when there is nothing to send or a batch is in flight. */
  takeBatch(now: number, mode: "due" | "all"): EdgeBatch | undefined {
    if (this.inFlight) return undefined;
    if (this.retained && now - this.retained.takenAt > this.retryForMs) {
      this.retained = undefined;
      this.droppedBatches++;
    }
    if (this.retained) {
      const b = this.retained;
      this.retained = undefined;
      b.attempts++;
      this.inFlight = b;
      return b;
    }
    const items: EdgeBatch["items"] = [];
    const pick = (account: string, st: AccountState | undefined) => {
      if (!st || st.pending <= 0) return;
      items.push({ account, amount: st.pending });
      st.pending = 0;
      this.due.delete(account);
    };
    for (const a of [...this.due]) {
      if (items.length >= this.maxItems) break;
      const st = this.states.get(a);
      if (!st || st.pending <= 0) this.due.delete(a);
      else pick(a, st);
    }
    if (mode === "all") {
      for (const [a, st] of this.states) {
        if (st.pending <= 0) continue;
        if (items.length >= this.maxItems) {
          this.due.add(a); // the overflow goes in the next early report
          continue;
        }
        pick(a, st);
      }
    }
    if (items.length === 0) return undefined;
    const b: EdgeBatch = { id: this.newBatchId(), items, takenAt: now, attempts: 1, retryAt: now };
    this.inFlight = b;
    return b;
  }

  /** Central answered `batch`. Accounts missing from `leases` keep the lease
   *  they had. */
  settle(batch: EdgeBatch, leases: ReadonlyMap<string, EdgeLease>, now: number): void {
    if (this.inFlight === batch) this.inFlight = undefined;
    this.unreachable = false;
    for (const { account } of batch.items) {
      let st = this.states.get(account);
      if (!st) {
        st = { pending: 0, spent: 0, lastUseAt: now };
        this.states.set(account, st);
      }
      const l = leases.get(account);
      if (l) {
        st.lease = {
          action: l.action,
          grant: Math.max(0, Math.floor(l.grant)),
          policy: l.policy,
          expiresAt: now + Math.max(0, l.ttlMs),
        };
      }
      // The grant is relative to central's total, which includes this batch
      // and nothing used since it was taken.
      st.spent = st.pending;
      if (this.isDue(st, now)) this.due.add(account);
      else this.due.delete(account);
    }
  }

  /** The send failed. `retry`: the network or central failed, so try the same
   *  batch again later; otherwise central refused it and it is dropped. */
  failed(batch: EdgeBatch, now: number, retry: boolean): void {
    if (this.inFlight === batch) this.inFlight = undefined;
    if (!retry) {
      this.droppedBatches++;
      return;
    }
    this.unreachable = true;
    batch.retryAt = now + RETRY_BACKOFF_MS[Math.min(batch.attempts - 1, RETRY_BACKOFF_MS.length - 1)]!;
    this.retained = batch;
  }

  /** Drop idle accounts whose lease lapsed forgetAfterMs ago. */
  prune(now: number): void {
    for (const [a, st] of this.states) {
      if (st.pending > 0 || this.due.has(a)) continue;
      const since = st.lease ? st.lease.expiresAt : st.lastUseAt;
      if (now - since >= this.forgetAfterMs) this.states.delete(a);
    }
  }

  /** Accounts currently restricted (throttle or stop). Diagnostics; O(n). */
  restrictedCount(): number {
    let n = 0;
    for (const a of this.states.keys()) if (this.action(a) !== "allow") n++;
    return n;
  }

  /** Accounts held in memory. */
  size(): number {
    return this.states.size;
  }

  /** The last report failed to reach central. */
  get centralUnreachable(): boolean {
    return this.unreachable;
  }

  private restrict(p: OverAllowancePolicy): MeterAction {
    return p === "allow" || (this.failOpen && this.unreachable) ? "allow" : p;
  }

  private isDue(st: AccountState, now: number): boolean {
    if (st.pending <= 0) return false;
    const l = st.lease;
    if (!l) return true;
    if (l.expiresAt <= now) return true;
    return l.action === "allow" && st.spent >= this.renewAt * l.grant;
  }
}
