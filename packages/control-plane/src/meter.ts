// Flagship's wiring of the metering core (`@ibisllc/billing-metering`,
// billing/packages/metering; model in billing/docs/spec/metering-v1.md).
//
// The core counts (account, resource, period) and judges usage against a
// plan; this file supplies what is Flagship's: the resources and the tier
// table, the effective-tier lookup, lowercased usernames as account ids, and
// the D1/InMemory stores from @flagship/storage (D1 `meter_counters`,
// migration 0069).
//
//   resource     unit    period  over the allowance
//   "egress"     bytes   month   free: throttle (the .services relay slows the
//                                account to 256 kbit/s); paid: allow, billed
//   "ai-tokens"  tokens  month   stop (no new AI-promo credential until reset)
//
// API (runtime-agnostic; Worker and tests alike):
//   meterRecord(deps, account, resource, amount, need = 0) → MeterVerdict
//       Add a usage delta, then judge the new total (+ need). Use where usage
//       is observed (relay byte reports, the inference shim's token reports);
//       need = 1 asks "may it consume any more?".
//   meterCheck(deps, account, resource, need = 0) → MeterVerdict
//       Judge without recording: "would `need` more fit?". Use before handing
//       out something that consumes the resource.
//   METER_RESOURCES — the tier table; deps.resources overrides it (tests,
//       future tuning).
//   MeterVerdict.action — "allow" | "throttle" | "stop": what the caller must
//       do right now. `over` alone is not a refusal (paid egress is over but
//       allowed, and billed).
//
// Privacy: the meter stores an account name and a number per resource and
// period. Never content, prompts, hosts, IPs or anything else a request
// carried.

import {
  meterCheck as coreCheck,
  meterRecord as coreRecord,
  type MeterCatalog,
  type MeterDeps as CoreDeps,
  type MeterVerdict as CoreVerdict,
} from "@ibisllc/billing-metering";
import type { MeterStorage, TierName, TierStorage } from "@flagship/storage";

export {
  meterPeriodKey,
  meterResetsAt,
  type MeterAction,
  type MeterPeriod,
  type MeterPlan,
  type MeterResourceSpec,
  type OverAllowancePolicy,
} from "@ibisllc/billing-metering";

const GB = 1024 * 1024 * 1024;

export type MeterResource = "egress" | "ai-tokens";

export const METER_RESOURCES: Readonly<MeterCatalog<MeterResource, TierName>> = {
  // Free worst case = 25 GB × Fly egress (~$0.02/GB) ≈ $0.50/mo per account.
  egress: {
    unit: "bytes",
    period: "month",
    plans: {
      free: { allowance: 25 * GB, over: "throttle" },
      hobby: { allowance: 250 * GB, over: "allow" },
      maker: { allowance: 500 * GB, over: "allow" },
    },
  },
  // True tokens (input + output) served by the in-house model, as reported by
  // its metering shim. Placeholder allowances pending the owner's numbers.
  "ai-tokens": {
    unit: "tokens",
    period: "month",
    plans: {
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
  resources?: Partial<MeterCatalog<MeterResource, TierName>>;
}

/** The core's verdict, with the plan also under Flagship's name for it. */
export type MeterVerdict = CoreVerdict<MeterResource, TierName> & { tier: TierName };

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

function core(deps: MeterDeps): CoreDeps<MeterResource, TierName> {
  return {
    catalog: { ...METER_RESOURCES, ...deps.resources },
    store: deps.meter,
    planOf: (account, nowMs) => effectiveTierOf(deps.tiers, account, nowMs),
    now: deps.now,
  };
}

function withTier(v: CoreVerdict<MeterResource, TierName>): MeterVerdict {
  return { ...v, tier: v.plan };
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
  return withTier(await coreRecord(core(deps), account.toLowerCase(), resource, amount, need));
}

/** Judge the account's current usage plus `need` more, without recording. */
export async function meterCheck(
  deps: MeterDeps,
  account: string,
  resource: MeterResource,
  need = 0,
): Promise<MeterVerdict> {
  return withTier(await coreCheck(core(deps), account.toLowerCase(), resource, need));
}
