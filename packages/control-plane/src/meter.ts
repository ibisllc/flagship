// Metering core — the one place `.com` counts what an account costs us.
//
// Every metered resource is a counter keyed by (account, resource, period),
// held in MeterStorage (D1 `meter_counters`, migration 0069). Each resource
// declares the window it resets on, a per-tier allowance, and what happens
// once an account is over it. The core only counts and judges; callers
// enforce the verdict:
//
//   resource     unit    period  over the allowance
//   "egress"     bytes   month   free: throttle (the .services relay slows the
//                                account to 256 kbit/s); paid: bill overage
//   "ai-tokens"  tokens  month   stop (no new AI-promo credential until reset)
//
// API (runtime-agnostic; Worker and tests alike):
//   meterRecord(deps, account, resource, amount, need = 0) → MeterVerdict
//       Add a usage delta, then judge the new total (+ need). Use where usage
//       is observed (relay byte reports, the inference shim's token reports);
//       need = 1 asks "may it consume any more?".
//   meterCheck(deps, account, resource, need = 0) → MeterVerdict
//       Judge without recording: "would `need` more fit?" Use before handing
//       out something that consumes the resource (need = 1 ⇒ is anything left).
//   meterPeriodKey(period, nowMs), meterResetsAt(period, nowMs)
//   METER_RESOURCES — the resource table; deps.resources overrides it (tests,
//       future tuning).
//   MeterVerdict.action — "allow" | "throttle" | "stop": what the caller must
//       do right now. `over` alone is not a refusal (paid egress is over but
//       allowed, and billed).
//
// Accounts are lowercased usernames. Tier is the account's effective tier (a
// lapsed paid subscription counts as free).
//
// Privacy: the meter stores an account name and a number per resource and
// period. Never content, prompts, hosts, IPs or anything else a request
// carried.

import type { MeterStorage, TierName, TierStorage } from "@flagship/storage";

const GB = 1024 * 1024 * 1024;

export type MeterResource = "egress" | "ai-tokens";
export type MeterPeriod = "month" | "day" | "lifetime";
/** What an over-allowance account gets: slowed, refused new grants, or served
 *  and billed for the overage. */
export type OverAllowancePolicy = "throttle" | "stop" | "bill";
export type MeterAction = "allow" | "throttle" | "stop";

export interface MeterPlan {
  /** Included amount per period, in the resource's unit. */
  allowance: number;
  over: OverAllowancePolicy;
}

export interface MeterResourceSpec {
  unit: "bytes" | "tokens";
  period: MeterPeriod;
  tiers: Record<TierName, MeterPlan>;
}

export const METER_RESOURCES: Readonly<Record<MeterResource, MeterResourceSpec>> = {
  // Free worst case = 25 GB × Fly egress (~$0.02/GB) ≈ $0.50/mo per account.
  egress: {
    unit: "bytes",
    period: "month",
    tiers: {
      free: { allowance: 25 * GB, over: "throttle" },
      hobby: { allowance: 250 * GB, over: "bill" },
      maker: { allowance: 500 * GB, over: "bill" },
    },
  },
  // True tokens (input + output) served by the in-house model, as reported by
  // its metering shim. Placeholder allowances pending the owner's numbers.
  "ai-tokens": {
    unit: "tokens",
    period: "month",
    tiers: {
      free: { allowance: 1_000_000, over: "stop" },
      hobby: { allowance: 5_000_000, over: "stop" },
      maker: { allowance: 20_000_000, over: "stop" },
    },
  },
};

export interface MeterDeps {
  meter: MeterStorage;
  tiers: TierStorage;
  now?: () => number;
  resources?: Partial<Record<MeterResource, MeterResourceSpec>>;
}

export interface MeterVerdict {
  account: string;
  resource: MeterResource;
  tier: TierName;
  /** The period key the counter lives under ("2026-10", "2026-10-13", "all"). */
  period: string;
  used: number;
  allowance: number;
  remaining: number;
  /** used (+ need, for a check) exceeds the allowance. */
  over: boolean;
  policy: OverAllowancePolicy;
  action: MeterAction;
  /** ms since epoch when the counter resets; null for a lifetime counter. */
  resetsAt: number | null;
}

/** The counter key for a period at `nowMs` (UTC). */
export function meterPeriodKey(period: MeterPeriod, nowMs: number): string {
  if (period === "lifetime") return "all";
  const d = new Date(nowMs);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return period === "month" ? ym : `${ym}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** When the period containing `nowMs` ends (UTC); null for lifetime. */
export function meterResetsAt(period: MeterPeriod, nowMs: number): number | null {
  if (period === "lifetime") return null;
  const d = new Date(nowMs);
  return period === "month"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Effective tier for an account: a lapsed paid sub falls back to free. The
 *  one definition of "paid right now" — metering and custom domains share it. */
export async function effectiveTierOf(
  tiers: TierStorage,
  username: string,
  nowMsValue: number,
): Promise<TierName> {
  const rec = await tiers.get(username.toLowerCase());
  if (!rec || rec.tier === "free") return "free";
  if (rec.currentPeriodEnd !== undefined && rec.currentPeriodEnd < nowMsValue) {
    return "free"; // subscription lapsed
  }
  return rec.tier;
}

export function meterSpec(deps: Pick<MeterDeps, "resources">, resource: MeterResource): MeterResourceSpec {
  const spec = deps.resources?.[resource] ?? METER_RESOURCES[resource];
  if (!spec) throw new Error(`unknown metered resource: ${resource}`);
  return spec;
}

function judge(
  account: string,
  resource: MeterResource,
  spec: MeterResourceSpec,
  tier: TierName,
  nowMs: number,
  used: number,
  need: number,
): MeterVerdict {
  const plan = spec.tiers[tier] ?? spec.tiers.free;
  const over = used + need > plan.allowance;
  return {
    account,
    resource,
    tier,
    period: meterPeriodKey(spec.period, nowMs),
    used,
    allowance: plan.allowance,
    remaining: Math.max(0, plan.allowance - used),
    over,
    policy: plan.over,
    action: !over || plan.over === "bill" ? "allow" : plan.over,
    resetsAt: meterResetsAt(spec.period, nowMs),
  };
}

function wholeNonNegative(n: number, what: string): number {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`${what} must be a finite non-negative number`);
  return Math.floor(n);
}

/** Add `amount` to the account's counter for the current period, then judge
 *  the new total plus `need`. */
export async function meterRecord(
  deps: MeterDeps,
  account: string,
  resource: MeterResource,
  amount: number,
  need = 0,
): Promise<MeterVerdict> {
  const spec = meterSpec(deps, resource);
  const delta = wholeNonNegative(amount, "amount");
  const n = wholeNonNegative(need, "need");
  const now = deps.now ? deps.now() : Date.now();
  const a = account.toLowerCase();
  const used = await deps.meter.add(a, resource, meterPeriodKey(spec.period, now), delta, now);
  return judge(a, resource, spec, await effectiveTierOf(deps.tiers, a, now), now, used, n);
}

/** Judge the account's current usage plus `need` more, without recording. */
export async function meterCheck(
  deps: MeterDeps,
  account: string,
  resource: MeterResource,
  need = 0,
): Promise<MeterVerdict> {
  const spec = meterSpec(deps, resource);
  const n = wholeNonNegative(need, "need");
  const now = deps.now ? deps.now() : Date.now();
  const a = account.toLowerCase();
  const rec = await deps.meter.get(a, resource, meterPeriodKey(spec.period, now));
  return judge(a, resource, spec, await effectiveTierOf(deps.tiers, a, now), now, rec?.amount ?? 0, n);
}
