/**
 * Every payment number in one place (docs/payments-privacy-and-rails.md "As built"). `.com` serves the live copy at
 * `GET /api/payments/config` (its `PAYMENTS_CONFIG` setting overrides these defaults field by field), and every client
 * reads its prices, plans and spending rules from that answer, so a price or a cap changes without a code change.
 *
 * Owner decisions 2026-11-17 (provisional where marked): $1 vouchers are the only currency; Pro 10 and Pro Max 20 a
 * month everywhere (store fee absorbed, provisional); overage in prepaid 5-unit blocks of 100 GB, default cap 10 a
 * month, then slowed (provisional); a trickle of one-unit spends ahead of need; a grace period so timing never lapses a
 * plan; activation at once with an optional random delay up to 24 h; round packs in the UI, units hidden.
 */

export type PaidPlan = "pro" | "pro-max";
export const PAID_PLANS: readonly PaidPlan[] = ["pro", "pro-max"];

/** The `.com` tier each plan writes (TierStorage names). */
export const PLAN_TIER: Readonly<Record<PaidPlan, "hobby" | "maker">> = { pro: "hobby", "pro-max": "maker" };

export interface PaymentsConfig {
  v: 1;
  /** USD per voucher. */
  unitUsd: number;
  /** Days one month of a plan buys. */
  monthDays: number;
  plans: Record<PaidPlan, { unitsPerMonth: number; includedGb: number }>;
  overage: { blockUnits: number; blockGb: number; defaultCapUnits: number; maxCapUnits: number; buyBelowGb: number };
  /** A lapsed plan keeps its tier this long, and a spend inside it continues from the old end (no gap, no free time).
   *  Not overridable: the metering reads the default. */
  graceHours: number;
  /** `.com` refuses a plan spend that would put the plan more than this far ahead (two devices can't both overpay). */
  maxAheadDays: number;
  /** The trickle keeps the plan between these leads: below `lowWaterDays` it spends at once, above `highWaterDays` never. */
  trickle: { lowWaterDays: number; highWaterDays: number };
  /** The optional privacy delay on a first activation. */
  activationDelayMaxHours: number;
  /** Round packs the apps offer, in units. */
  packs: number[];
  /** Max vouchers in one issue or redeem request. */
  maxPerRequest: number;
}

export const DEFAULT_PAYMENTS_CONFIG: PaymentsConfig = {
  v: 1,
  unitUsd: 1,
  monthDays: 30,
  plans: { pro: { unitsPerMonth: 10, includedGb: 250 }, "pro-max": { unitsPerMonth: 20, includedGb: 500 } },
  overage: { blockUnits: 5, blockGb: 100, defaultCapUnits: 10, maxCapUnits: 100, buyBelowGb: 10 },
  graceHours: 72,
  maxAheadDays: 35,
  trickle: { lowWaterDays: 3, highWaterDays: 10 },
  activationDelayMaxHours: 24,
  packs: [10, 30, 120],
  maxPerRequest: 30,
};

const DAY_MS = 86_400_000;

const isPosInt = (v: unknown, max = 1_000_000): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The defaults with any valid overrides from `raw` (a JSON object or its text); invalid fields keep the default. */
export function mergePaymentsConfig(raw: unknown): PaymentsConfig {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return DEFAULT_PAYMENTS_CONFIG;
    }
  }
  const d = DEFAULT_PAYMENTS_CONFIG;
  if (!isObj(o)) return d;
  const num = (v: unknown, fallback: number, max?: number) => (isPosInt(v, max) ? v : fallback);
  const plans = isObj(o.plans) ? o.plans : {};
  const plan = (p: PaidPlan) => {
    const x = isObj(plans[p]) ? (plans[p] as Record<string, unknown>) : {};
    return { unitsPerMonth: num(x.unitsPerMonth, d.plans[p].unitsPerMonth, 1000), includedGb: num(x.includedGb, d.plans[p].includedGb) };
  };
  const ov = isObj(o.overage) ? o.overage : {};
  const tr = isObj(o.trickle) ? o.trickle : {};
  const packs = Array.isArray(o.packs) && o.packs.length > 0 && o.packs.length <= 6 && o.packs.every((p) => isPosInt(p, 1000)) ? (o.packs as number[]) : d.packs;
  const out: PaymentsConfig = {
    v: 1,
    unitUsd: num(o.unitUsd, d.unitUsd, 100),
    monthDays: num(o.monthDays, d.monthDays, 31),
    plans: { pro: plan("pro"), "pro-max": plan("pro-max") },
    overage: {
      blockUnits: num(ov.blockUnits, d.overage.blockUnits, 100),
      blockGb: num(ov.blockGb, d.overage.blockGb),
      defaultCapUnits: num(ov.defaultCapUnits, d.overage.defaultCapUnits, 1000),
      maxCapUnits: num(ov.maxCapUnits, d.overage.maxCapUnits, 10_000),
      buyBelowGb: num(ov.buyBelowGb, d.overage.buyBelowGb),
    },
    // Fixed: `.com`'s metering reads the default (control-plane meter.ts PLAN_GRACE_MS).
    graceHours: d.graceHours,
    maxAheadDays: num(o.maxAheadDays, d.maxAheadDays, 400),
    trickle: { lowWaterDays: num(tr.lowWaterDays, d.trickle.lowWaterDays, 60), highWaterDays: num(tr.highWaterDays, d.trickle.highWaterDays, 120) },
    activationDelayMaxHours: num(o.activationDelayMaxHours, d.activationDelayMaxHours, 24 * 7),
    packs: [...packs].sort((a, b) => a - b),
    maxPerRequest: num(o.maxPerRequest, d.maxPerRequest, 200),
  };
  if (out.trickle.highWaterDays <= out.trickle.lowWaterDays || out.maxAheadDays <= out.trickle.highWaterDays) out.trickle = d.trickle;
  if (out.maxAheadDays <= out.trickle.highWaterDays) out.maxAheadDays = d.maxAheadDays;
  return out;
}

/** How long one voucher keeps `plan` running: a month's days over its units (Pro 3 days, Pro Max 36 hours). */
export function planUnitMs(cfg: PaymentsConfig, plan: PaidPlan): number {
  return Math.floor((cfg.monthDays * DAY_MS) / cfg.plans[plan].unitsPerMonth);
}

export function isPaidPlan(v: unknown): v is PaidPlan {
  return v === "pro" || v === "pro-max";
}

/** The plan name for a `.com` tier (hobby = Pro, maker = Pro Max), or null for free. */
export function planOfTier(tier: string): PaidPlan | null {
  return tier === "hobby" ? "pro" : tier === "maker" ? "pro-max" : null;
}
