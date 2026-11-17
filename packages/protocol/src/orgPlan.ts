/**
 * The Business plan for an org (docs/plans-and-backup-offer.md §3, §3.4, §6 and "As built"). An org pays per seat in
 * the same $1 vouchers as a personal plan, from its own wallet (orgWallet.ts). Every number comes from
 * `PaymentsConfig.business`. Shared vectors: packages/protocol/test-vectors/org-plan/.
 *
 *   terms     {trialEndsAt, trialSeats, paidSeats, paidUntil}: what `.com` keeps on the org row
 *   status    trial   now < trialEndsAt (the trial's seats, or the paid seats if more)
 *             paid    paidSeats > 0 and now <= paidUntil + grace
 *             lapsed  neither: no new seats, no role raises, no new servers, no new connectors; every existing seat,
 *                     approval, offboarding, export and app keeps working, and nothing is ever wiped
 *   spend     n vouchers for `seats` seats buy n × orgSeatUnitMs(seats). Paid time starts when the trial ends (a
 *             trial is never shortened by paying early). Inside the grace a spend continues from the old end; a
 *             different seat count converts the time left at the ratio of the two unit lengths, as a plan switch
 *             does (value is kept, never created).
 *
 * The trickle and overage rules are the personal wallet's (`trickleStep`, `overageStep`), fed with the org's numbers.
 */
import { orgSeatUnitMs, type PaymentsConfig } from "./paymentsConfig.js";
import { trickleStep } from "./voucherWallet.js";

export type OrgPlanStatus = "trial" | "paid" | "lapsed";
export const ORG_PLAN_STATUSES: readonly OrgPlanStatus[] = ["trial", "paid", "lapsed"];

export interface OrgPlanTerms {
  trialEndsAt: number;
  trialSeats: number;
  /** Seats the vouchers spent so far pay for (0: none yet). */
  paidSeats: number;
  /** End of the paid time, epoch ms (0: none yet). */
  paidUntil: number;
}

export interface OrgPlanState extends OrgPlanTerms {
  status: OrgPlanStatus;
  /** How many live seats the org may hold now (new seats past it are refused). */
  seatLimit: number;
  /** The later of the trial's end and the paid end: when the org lapses if nothing more is spent. */
  coveredUntil: number;
}

const graceMsOf = (cfg: PaymentsConfig) => cfg.graceHours * 3_600_000;

/** The org's plan right now. */
export function orgPlanState(cfg: PaymentsConfig, t: OrgPlanTerms, now: number): OrgPlanState {
  const inTrial = now < t.trialEndsAt;
  const paid = t.paidSeats > 0 && t.paidUntil > 0 && now <= t.paidUntil + graceMsOf(cfg);
  const status: OrgPlanStatus = inTrial ? "trial" : paid ? "paid" : "lapsed";
  const seatLimit = inTrial ? Math.max(t.trialSeats, t.paidSeats) : t.paidSeats > 0 ? t.paidSeats : t.trialSeats;
  const coveredUntil = Math.max(t.trialEndsAt, t.paidSeats > 0 ? t.paidUntil : 0);
  return { ...t, status, seatLimit, coveredUntil };
}

/** The org's new paid end after `n` vouchers for `seats` seats (n = 0: where a spend would start). */
export function orgPaidUntilAfterSpend(cfg: PaymentsConfig, t: OrgPlanTerms, seats: number, n: number, now: number): number {
  const unit = orgSeatUnitMs(cfg, seats);
  const start = Math.max(now, t.trialEndsAt);
  let base = start;
  if (t.paidSeats > 0 && t.paidUntil > 0 && t.paidUntil + graceMsOf(cfg) >= now) {
    if (t.paidSeats === seats) base = t.paidUntil;
    else if (t.paidUntil > start) base = start + Math.floor(((t.paidUntil - start) * unit) / orgSeatUnitMs(cfg, t.paidSeats));
  }
  return base + n * unit;
}

/** How far ahead the org is covered for `seats` seats, the trial included (negative inside the grace). */
export function orgAheadMs(cfg: PaymentsConfig, t: OrgPlanTerms, seats: number, now: number): number {
  return orgPaidUntilAfterSpend(cfg, t, seats, 0, now) - now;
}

export interface OrgTrickleInput {
  now: number;
  /** Auto-pay is on in the org wallet. */
  enabled: boolean;
  balance: number;
  terms: OrgPlanTerms;
  /** The seat count the org wallet pays for. */
  seats: number;
  nextSpendAt: number;
}

/** One tick of the org wallet's trickle: `trickleStep` with the org's unit length and lead. */
export function orgTrickleStep(cfg: PaymentsConfig, o: OrgTrickleInput, rand: number): { spend: number; nextSpendAt: number } {
  const DAY = 86_400_000;
  return trickleStep(
    {
      now: o.now,
      enabled: o.enabled,
      balance: o.balance,
      aheadMs: orgAheadMs(cfg, o.terms, o.seats, o.now),
      startAt: 0,
      nextSpendAt: o.nextSpendAt,
      unitMs: orgSeatUnitMs(cfg, o.seats),
      lowWaterMs: cfg.trickle.lowWaterDays * DAY,
      highWaterMs: cfg.trickle.highWaterDays * DAY,
      maxPerRequest: cfg.maxPerRequest,
    },
    rand,
  );
}

/** The org's pooled public egress allowance in GB while it is on trial or paid (lapsed: null, the Free allowance). */
export function orgEgressGb(cfg: PaymentsConfig, st: Pick<OrgPlanState, "status" | "seatLimit">): number | null {
  return st.status === "lapsed" ? null : st.seatLimit * cfg.business.egressGbPerSeat;
}

/** The trial's terms for an org created at `now`. */
export function orgTrialTerms(cfg: PaymentsConfig, now: number): OrgPlanTerms {
  return { trialEndsAt: now + cfg.business.trialDays * 86_400_000, trialSeats: cfg.business.trialSeats, paidSeats: 0, paidUntil: 0 };
}
