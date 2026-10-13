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
//   "ai-promo-week" / "ai-promo-starter" / "ai-promo-global" /
//   "ai-promo-input" / "ai-promo-output": the free AI promotion's weekly
//       top-up, one-time starter reserve, all-accounts daily cap and raw
//       token counts. Their allowances come from `.com` config at call time
//       (freeAiCredits.ts passes them as `deps.resources`); the entries here
//       are the defaults.
//
// API (runtime-agnostic; Worker and tests alike):
//   meterRecord(deps, account, resource, amount, need = 0) → MeterVerdict
//       Add a usage delta, then judge the new total (+ need). Use where usage
//       is observed (relay byte reports, the inference shim's token reports);
//       need = 1 asks "may it consume any more?".
//   meterCheck(deps, account, resource, need = 0) → MeterVerdict
//       Judge without recording: "would `need` more fit?". Use before handing
//       out something that consumes the resource.
//   meterReportBatch(deps, { batchId?, items }) → { duplicate, verdicts }
//       Record an edge's batch (the relay's egress report) and judge each
//       account; a batch id is counted at most once (migration 0070).
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
  meterReport as coreReport,
  type MeterCatalog,
  type MeterDeps as CoreDeps,
  type MeterVerdict as CoreVerdict,
} from "@ibisllc/billing-metering";
import type { MeterStorage, TierName, TierStorage, TierSubscriptionRecord } from "@flagship/storage";
import type { MeterPlan, OverAllowancePolicy } from "@ibisllc/billing-metering";

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

export type MeterResource =
  | "egress"
  | "ai-tokens"
  | "ai-promo-week"
  | "ai-promo-starter"
  | "ai-promo-global"
  | "ai-promo-input"
  | "ai-promo-output";

/** Every tier gets the same plan (the promotion isn't tiered). */
export function sameForEveryTier(allowance: number, over: OverAllowancePolicy): Record<TierName, MeterPlan> {
  return { free: { allowance, over }, hobby: { allowance, over }, maker: { allowance, over } };
}

/** "Effectively unlimited": a counter that only records. */
const RECORD_ONLY = Number.MAX_SAFE_INTEGER;

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
  // Weighted tokens (input × input weight + output × output weight).
  "ai-promo-week": { unit: "tokens", period: "week", plans: sameForEveryTier(500_000, "stop") },
  "ai-promo-starter": { unit: "tokens", period: "lifetime", plans: sameForEveryTier(2_000_000, "stop") },
  // One counter for every account (account id "*").
  "ai-promo-global": { unit: "tokens", period: "day", plans: sameForEveryTier(50_000_000, "stop") },
  "ai-promo-input": { unit: "tokens", period: "month", plans: sameForEveryTier(RECORD_ONLY, "allow") },
  "ai-promo-output": { unit: "tokens", period: "month", plans: sameForEveryTier(RECORD_ONLY, "allow") },
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
  return tierFrom(await tiers.get(username.toLowerCase()), nowMsValue);
}

function tierFrom(rec: TierSubscriptionRecord | undefined, nowMsValue: number): TierName {
  if (!rec || rec.tier === "free") return "free";
  if (rec.currentPeriodEnd !== undefined && rec.currentPeriodEnd < nowMsValue) {
    return "free"; // subscription lapsed
  }
  return rec.tier;
}

/** effectiveTierOf for many accounts in one lookup (relay batches). */
async function effectiveTiersOf(
  tiers: TierStorage,
  usernames: string[],
  nowMsValue: number,
): Promise<ReadonlyMap<string, TierName>> {
  if (!tiers.getMany) return new Map();
  const recs = await tiers.getMany(usernames);
  return new Map(usernames.map((u) => [u, tierFrom(recs.get(u), nowMsValue)]));
}

function core(deps: MeterDeps): CoreDeps<MeterResource, TierName> {
  return {
    catalog: { ...METER_RESOURCES, ...deps.resources },
    store: deps.meter,
    planOf: (account, nowMs) => effectiveTierOf(deps.tiers, account, nowMs),
    plansOf: (accounts, nowMs) => effectiveTiersOf(deps.tiers, accounts, nowMs),
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

/** Record a batch of usage reported by an edge (the relay) and judge every
 *  account in it. With a `batchId` the batch is counted at most once (D1
 *  `meter_batches`, migration 0070); without one it is counted as it comes,
 *  for relays that predate batch ids. */
export async function meterReportBatch(
  deps: MeterDeps,
  report: { batchId?: string; items: Array<{ account: string; resource: MeterResource; amount: number }> },
): Promise<{ duplicate: boolean; verdicts: MeterVerdict[] }> {
  const r = await coreReport(core(deps), {
    ...(report.batchId !== undefined ? { batchId: report.batchId } : {}),
    items: report.items.map((it) => ({ ...it, account: it.account.toLowerCase() })),
  });
  return { duplicate: r.duplicate, verdicts: r.verdicts.map(withTier) };
}
