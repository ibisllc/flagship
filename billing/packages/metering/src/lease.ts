// Budget leases (spec/report-and-lease-v1.md), the central side.
//
// Instead of an edge asking about every batch, central answers each report
// with a lease per account: "you may serve `grant` more units, beyond what I
// have counted, before you report again; this answer is good for `ttlMs`".
// The edge enforces locally and reports early to renew. A throttle or stop
// is a lease with `grant` 0 and that action.
//
// Grants are sized from what is left: a `fraction` of the remaining
// allowance, within [minGrant, maxGrant], and never more than what is left.
// One edge therefore cannot carry an account past its allowance on a lease;
// E edges holding leases at once can together overshoot by at most the sum
// of their grants (≤ (E − 1) × maxGrant, and shrinking with what is left).
// A plan whose policy is "allow" (billed, never limited) gets `maxGrant`.

import type { MeterAction, MeterVerdict, OverAllowancePolicy } from "./meter.js";

export interface MeterLeasePolicy {
  /** Share of the remaining allowance one lease may grant, in (0, 1]. */
  fraction: number;
  /** Smallest grant while anything is left (fewer renewals near the end). */
  minGrant: number;
  /** Largest grant; also what an "allow"-policy plan gets. Bounds what an
   *  edge can lose on a crash for one account. */
  maxGrant: number;
  /** Lifetime of a lease that allows. */
  ttlMs: number;
  /** Lifetime of a lease that throttles or stops (how soon an upgrade or a
   *  new period is noticed while the account stays active). */
  overTtlMs: number;
}

export interface MeterLease<Resource extends string = string> {
  account: string;
  resource: Resource;
  /** What the edge must do now. */
  action: MeterAction;
  /** Units the edge may serve, beyond what central had counted when it
   *  answered, before it needs a new lease; 0 unless `action` is "allow". */
  grant: number;
  /** What to do if the grant runs out before a renewal arrives: the plan's
   *  over-allowance policy ("allow" = keep going, the plan is billed). */
  policy: OverAllowancePolicy;
  /** How long the answer stands. Relative, so edge and central clocks need
   *  not agree. Never past the end of the period. */
  ttlMs: number;
}

export function assertLeasePolicy(p: MeterLeasePolicy): void {
  if (!(p.fraction > 0 && p.fraction <= 1)) throw new RangeError("fraction must be in (0, 1]");
  if (!(Number.isFinite(p.minGrant) && p.minGrant >= 0)) throw new RangeError("minGrant must be ≥ 0");
  if (!(Number.isFinite(p.maxGrant) && p.maxGrant >= p.minGrant)) throw new RangeError("maxGrant must be ≥ minGrant");
  if (!(p.ttlMs > 0 && p.overTtlMs > 0)) throw new RangeError("ttlMs and overTtlMs must be positive");
}

/** The lease for a verdict (normally the one a report just produced). */
export function meterLease<R extends string>(
  v: MeterVerdict<R, string>,
  p: MeterLeasePolicy,
  nowMs: number,
): MeterLease<R> {
  assertLeasePolicy(p);
  const untilReset = v.resetsAt === null ? Infinity : Math.max(1, v.resetsAt - nowMs);
  const base = { account: v.account, resource: v.resource, policy: v.policy };
  if (v.policy === "allow") {
    return { ...base, action: "allow", grant: Math.floor(p.maxGrant), ttlMs: Math.min(p.ttlMs, untilReset) };
  }
  if (v.action !== "allow" || v.remaining <= 0) {
    return { ...base, action: v.policy, grant: 0, ttlMs: Math.min(p.overTtlMs, untilReset) };
  }
  const sized = Math.max(p.minGrant, Math.min(p.maxGrant, v.remaining * p.fraction));
  return {
    ...base,
    action: "allow",
    grant: Math.floor(Math.min(v.remaining, sized)),
    ttlMs: Math.min(p.ttlMs, untilReset),
  };
}
