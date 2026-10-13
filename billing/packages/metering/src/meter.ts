// Metering core: count what each account uses and judge it against its plan.
//
// Every metered resource is a counter keyed by (account, resource, period).
// The host declares a catalog: per resource, the period it resets on and, per
// plan, an allowance and what happens past it. The core only counts and
// judges; the host enforces the verdict's `action`.
//
//   policy      past the allowance the account is…
//   "allow"     still served (the host may bill the overage)
//   "throttle"  served slowly (the host decides how slow)
//   "stop"      refused anything new until the period resets
//
// API:
//   meterRecord(deps, account, resource, amount, need = 0) → MeterVerdict
//       Add a usage delta, then judge the new total (+ need). Use where usage
//       is observed; need = 1 asks "may it consume any more?".
//   meterCheck(deps, account, resource, need = 0) → MeterVerdict
//       Judge without recording: "would `need` more fit?". Use before handing
//       out something that consumes the resource.
//   meterPeriodKey(period, nowMs), meterResetsAt(period, nowMs) — UTC.
//
// The core never alters an account id (normalise it before calling) and the
// store keeps an account id and a number per resource and period, never
// anything about what was metered.

import type { MeterStore } from "./store.js";

export type MeterPeriod = "month" | "week" | "day" | "lifetime";
export type OverAllowancePolicy = "allow" | "throttle" | "stop";
export type MeterAction = OverAllowancePolicy;

export interface MeterPlan {
  /** Included amount per period, in the resource's unit. */
  allowance: number;
  over: OverAllowancePolicy;
}

export interface MeterResourceSpec<Plan extends string = string> {
  /** Display only ("bytes", "tokens", …). */
  unit: string;
  period: MeterPeriod;
  plans: Record<Plan, MeterPlan>;
}

export type MeterCatalog<Resource extends string = string, Plan extends string = string> = Record<
  Resource,
  MeterResourceSpec<Plan>
>;

export interface MeterDeps<Resource extends string = string, Plan extends string = string> {
  catalog: MeterCatalog<Resource, Plan>;
  store: MeterStore;
  /** The account's plan right now (the host's subscription lookup). */
  planOf: (account: string, nowMs: number) => Promise<Plan>;
  now?: () => number;
}

export interface MeterVerdict<Resource extends string = string, Plan extends string = string> {
  account: string;
  resource: Resource;
  plan: Plan;
  /** The counter's period key ("2026-10", "2026-W42", "2026-10-13" or "all"). */
  period: string;
  used: number;
  allowance: number;
  remaining: number;
  /** used (+ need) exceeds the allowance. Not a refusal on its own. */
  over: boolean;
  policy: OverAllowancePolicy;
  /** What the host must do now: "allow" unless over, else the policy. */
  action: MeterAction;
  /** ms since epoch when the counter resets; null for a lifetime counter. */
  resetsAt: number | null;
}

const DAY_MS = 86_400_000;

/** 00:00 UTC on the Monday of the ISO week containing `nowMs`. */
function isoWeekStart(nowMs: number): number {
  const d = new Date(nowMs);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
}

/** ISO 8601 week key, e.g. "2026-W42": weeks start on Monday and belong to
 *  the year that holds their Thursday. */
function isoWeekKey(nowMs: number): string {
  const thursday = new Date(isoWeekStart(nowMs) + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week1Monday = isoWeekStart(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thursday.getTime() - 3 * DAY_MS - week1Monday) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The counter key for a period at `nowMs` (UTC). */
export function meterPeriodKey(period: MeterPeriod, nowMs: number): string {
  if (period === "lifetime") return "all";
  if (period === "week") return isoWeekKey(nowMs);
  const d = new Date(nowMs);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return period === "month" ? ym : `${ym}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** When the period containing `nowMs` ends (UTC); null for lifetime. */
export function meterResetsAt(period: MeterPeriod, nowMs: number): number | null {
  if (period === "lifetime") return null;
  if (period === "week") return isoWeekStart(nowMs) + 7 * DAY_MS;
  const d = new Date(nowMs);
  return period === "month"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function specOf<R extends string, P extends string>(deps: MeterDeps<R, P>, resource: R): MeterResourceSpec<P> {
  const spec = deps.catalog[resource];
  if (!spec) throw new Error(`unknown metered resource: ${resource}`);
  return spec;
}

function wholeNonNegative(n: number, what: string): number {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`${what} must be a finite non-negative number`);
  return Math.floor(n);
}

function judge<R extends string, P extends string>(
  account: string,
  resource: R,
  spec: MeterResourceSpec<P>,
  plan: P,
  nowMs: number,
  used: number,
  need: number,
): MeterVerdict<R, P> {
  const p = spec.plans[plan];
  if (!p) throw new Error(`resource ${resource} has no plan ${plan}`);
  const over = used + need > p.allowance;
  return {
    account,
    resource,
    plan,
    period: meterPeriodKey(spec.period, nowMs),
    used,
    allowance: p.allowance,
    remaining: Math.max(0, p.allowance - used),
    over,
    policy: p.over,
    action: over ? p.over : "allow",
    resetsAt: meterResetsAt(spec.period, nowMs),
  };
}

/** Add `amount` to the account's counter for the current period, then judge
 *  the new total plus `need`. */
export async function meterRecord<R extends string, P extends string>(
  deps: MeterDeps<R, P>,
  account: string,
  resource: R,
  amount: number,
  need = 0,
): Promise<MeterVerdict<R, P>> {
  const spec = specOf(deps, resource);
  const delta = wholeNonNegative(amount, "amount");
  const n = wholeNonNegative(need, "need");
  const now = deps.now ? deps.now() : Date.now();
  const used = await deps.store.add(account, resource, meterPeriodKey(spec.period, now), delta, now);
  return judge(account, resource, spec, await deps.planOf(account, now), now, used, n);
}

/** Judge the account's current usage plus `need` more, without recording. */
export async function meterCheck<R extends string, P extends string>(
  deps: MeterDeps<R, P>,
  account: string,
  resource: R,
  need = 0,
): Promise<MeterVerdict<R, P>> {
  const spec = specOf(deps, resource);
  const n = wholeNonNegative(need, "need");
  const now = deps.now ? deps.now() : Date.now();
  const rec = await deps.store.get(account, resource, meterPeriodKey(spec.period, now));
  return judge(account, resource, spec, await deps.planOf(account, now), now, rec?.amount ?? 0, n);
}
