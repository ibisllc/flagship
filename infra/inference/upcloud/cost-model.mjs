#!/usr/bin/env node
/**
 * cost-model — what free AI costs on our own GPU, per token, per customer
 * and per month, and what to charge when tokens go on sale.
 *
 *   node infra/inference/upcloud/cost-model.mjs                       # markdown report
 *   node infra/inference/upcloud/cost-model.mjs --set gpu.hourly=2.1 --set users.pctBuild=0.5
 *   node infra/inference/upcloud/cost-model.mjs --config my-assumptions.json --json
 *
 * Every number the report uses is in DEFAULTS below, with where it came
 * from. Change one with --set <dotted.path>=<number>, or several with a
 * JSON file shaped like DEFAULTS (deep-merged). Money is in `currency`
 * (UpCloud bills in EUR); hosted-API benchmarks are USD and converted with
 * `usdPerCurrencyUnit`. Tokens are WEIGHTED like the allowance:
 * input × weights.input + output × weights.output (docs/build-modes.md).
 *
 * The capacity model: a GPU spends (1 − prefixCacheHit) / prefillTokPerSec
 * seconds on each input token (a cached prefix costs ~nothing) and
 * 1 / decodeTokPerSec seconds on each output token, at full batch. That is
 * deliberately simple and a little pessimistic (chunked prefill overlaps the
 * two); measure your own numbers with `vllm bench serve` and put them in.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  currency: "EUR",
  /** EUR→USD for USD API prices and $1 vouchers. UpCloud's own EUR/USD price pairs imply 1.14–1.19. */
  usdPerCurrencyUnit: 1.15,
  hoursPerMonth: 730,

  /**
   * How the GPU is paid for: "always-on" (an hourly server or pod),
   * "serverless" (per second while a worker is up, scale to zero), or
   * "hosted" (rent the same model per token, benchmarks[sameModelBenchmark]).
   */
  mode: "always-on",
  /** Shown in the comparison table (`--compare`). */
  meta: {
    label: "UpCloud L40S, always on",
    whoSeesPrompts: "us only (TLS ends on our box; Cloudflare edge passes the tunnel)",
    eu: "yes (Helsinki)",
    effort: "medium: our cloud-init, tunnel, upgrades",
  },

  /** The GPU server (config.json `plan`). Prices: upcloud.com/pricing, excl. VAT. */
  gpu: {
    label: "UpCloud GPU-8xCPU-64GB-1xL40S (fi-hel2)",
    /** On-demand, excl. VAT (pricing page snapshot 2026-10-07). */
    hourly: 1.11,
    /** A monthly cap on hourly billing, if any; UpCloud states none for GPU plans. */
    monthlyCap: null,
    /** What still bills per hour while STOPPED: GPU plans bill nothing (storage + IP are below). */
    stoppedHourly: 0,
    storageGb: 120,
    /** Standard tier €0.085/GB-month (MaxIOPS is €0.22). */
    storagePerGbMonth: 0.085,
    ipv4Monthly: 3.47,
    /** For providers billing in USD (RunPod): set these instead; converted with usdPerCurrencyUnit. */
    hourlyUsd: null,
    fixedMonthlyUsd: 0,
  },

  /** mode "serverless": per-second workers (RunPod Serverless). Prices in USD. */
  serverless: {
    flexPerSecondUsd: 0,
    activePerSecondUsd: 0,
    /** Always-warm workers (billed every second at the active rate). 0 = scale to zero. */
    activeWorkers: 0,
    /** Seconds a worker stays up after its last request. Must exceed a build's gap between turns. */
    idleTimeoutSeconds: 300,
    /** Seconds from a request hitting a cold endpoint to vLLM answering. Billed. */
    coldStartSeconds: 120,
    /** Network volume holding the weights, per month. */
    storageMonthlyUsd: 0,
  },
  /** Hours a day the GPU runs (24 = always on; a scheduled stop lowers it). */
  onHoursPerDay: 24,

  /**
   * Aggregate throughput of one GPU at full continuous batching, for the
   * recommended model (Qwen3.6-35B-A3B-FP8, thinking off, 64k context) on
   * an L40S. ESTIMATES: no published L40S saturation benchmark exists for it
   * (docs/ai-inference-costs.md §3 has the ranges). Measure and replace.
   */
  throughput: {
    prefillTokPerSec: 8000,
    decodeTokPerSec: 450,
    /** Share of input tokens served from the prefix cache. The build loop re-sends its history every turn. */
    prefixCacheHit: 0.7,
    /**
     * Tokens of context the GPU can keep cached at once (KV room after the
     * weights). A build keeps its context only while it fits; past that the
     * cache thrashes, so this caps concurrent builds. L40S + Qwen3.6-35B-A3B-FP8:
     * ~4.9 GiB KV room at 20 KiB/token, roughly halved by the DeltaNet state
     * checkpoints prefix caching keeps → ~125k (estimate; vLLM logs the real figure).
     */
    kvCacheTokens: 125000,
    /** Hit rate for builds beyond what the KV room retains (only the shared system prompt survives). */
    prefixCacheHitEvicted: 0.1,
  },

  weights: { input: 1, output: 4 },

  /**
   * One app build, from the agent loop's shape (packages/server-daemon/src/buildmodes/buildAgent.ts:
   * up to 24 turns, the whole history re-sent each turn, tool results up to 24k chars).
   */
  build: {
    turns: 14,
    firstPromptTokens: 14000,
    growthPerTurn: 2500,
    outputPerTurn: 900,
    /** Minutes a build holds its context, mostly waiting on its own tool runs (docker builds, test deploys). */
    wallMinutes: 15,
  },

  /** The free allowance (.com AI_PROMO_*). */
  allowance: { starter: 2_000_000, weekly: 500_000, dailyCap: 50_000_000 },

  /** How new owners behave during the promotion. All guesses until we have data: change them. */
  users: {
    /** Share of signups who build at least one app with free AI. */
    pctBuild: 0.6,
    /** Builds in the first week by someone who builds. */
    buildsFirstWeek: 2.5,
    /** Share of builders active again in week 2. */
    pctReturnWeekly: 0.35,
    /** Each later week keeps this share of the previous week's returners. */
    weeklyRetention: 0.85,
    /** Builds in a week by a returning builder (tweaks count as builds). */
    buildsPerActiveWeek: 1.2,
    /** How long the promotion runs for one owner, in weeks. */
    promoWeeks: 12,
  },

  /** Fleet sizing. */
  fleet: {
    /** Busiest hour ÷ average hour. */
    peakToAverage: 3,
    /** Highest utilisation we let a GPU run at before latency hurts. */
    maxUtilisation: 0.7,
    minGpus: 1,
  },
  /** Fixed monthly overhead besides GPUs (Workers Paid plan, monitoring), in `currency`. */
  overheadMonthly: 5,

  /** Utilisation scenarios for the per-token table. */
  scenarios: [
    { name: "idle-heavy", utilisation: 0.03 },
    { name: "light", utilisation: 0.1 },
    { name: "moderate", utilisation: 0.25 },
    { name: "busy", utilisation: 0.5 },
    { name: "saturated", utilisation: 0.7 },
  ],

  /** Selling tokens later in $1 vouchers. */
  sales: {
    /** Utilisation the price is set for. */
    pricingUtilisation: 0.25,
    marginPct: 0.5,
    /** Card fees on a voucher purchase (Stripe-like). */
    paymentFeePct: 0.029,
    paymentFeeFixedUsd: 0.3,
    voucherUsd: 1,
    /** Vouchers bought per purchase (fees are per purchase). */
    vouchersPerPurchase: 10,
  },

  /**
   * Share of input a hosted provider bills at its cached-input price (its own
   * prefix cache; lower than ours: routing across replicas misses).
   */
  hostedCacheHit: 0.5,
  /** Which benchmark serves the SAME model (the honest "rent instead of run" comparison). */
  sameModelBenchmark: 0,
  /** Hosted prices for comparable open coding models, USD per 1M tokens, fetched 2026-10-13 (see the doc). */
  benchmarks: [
    { name: "Qwen3.6-35B-A3B, DeepInfra", inputPerM: 0.1, outputPerM: 0.95 },
    { name: "Qwen3.6-35B-A3B, Alibaba Model Studio (intl)", inputPerM: 0.375, outputPerM: 2.25 },
    { name: "Qwen3-Coder-30B-A3B, OpenRouter (SiliconFlow)", inputPerM: 0.07, outputPerM: 0.28 },
    { name: "gpt-oss-120b, Together / Fireworks / Groq", inputPerM: 0.15, outputPerM: 0.6 },
    { name: "Claude Sonnet 5.5 (frontier reference)", inputPerM: 2, outputPerM: 10 },
  ],

  /** Signup volumes for the monthly-bill table. */
  signupVolumes: [100, 1000, 10000],
};

/* ─────────────────────────── helpers ────────────────────────────────── */

export function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== "object" || over === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function setPath(obj, dotted, raw) {
  const keys = dotted.split(".");
  const out = structuredClone(obj);
  let cur = out;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) throw new Error(`unknown setting ${dotted}`);
    cur = cur[k];
  }
  const last = keys.at(-1);
  if (!(last in cur)) throw new Error(`unknown setting ${dotted}`);
  const n = Number(raw);
  cur[last] = raw === "null" ? null : Number.isFinite(n) ? n : raw;
  return out;
}

/* ─────────────────────────── the model ──────────────────────────────── */

/** Tokens in one build: the loop re-sends its whole history every turn. */
export function buildTokens(a) {
  const { turns, firstPromptTokens, growthPerTurn, outputPerTurn } = a.build;
  const input = turns * firstPromptTokens + growthPerTurn * (turns * (turns - 1)) / 2;
  const output = turns * outputPerTurn;
  return { input, output, weighted: input * a.weights.input + output * a.weights.output };
}

/** Average context a build holds over its turns. */
export function avgContextTokens(a) {
  const { turns, firstPromptTokens, growthPerTurn } = a.build;
  return firstPromptTokens + (growthPerTurn * (turns - 1)) / 2;
}

/** GPU-seconds one build costs at a prefix-cache hit rate. */
export function gpuSecondsPerBuild(a, hit) {
  const b = buildTokens(a);
  const t = a.throughput;
  return (b.input * (1 - hit)) / t.prefillTokPerSec + b.output / t.decodeTokPerSec;
}

/**
 * What one GPU serves at 100% for the build mix. Builds that fit in its KV
 * room (kvCacheTokens / average context, each held for wallMinutes) get
 * prefixCacheHit; any more still run, but their context is evicted between
 * turns, so they pay prefill again at prefixCacheHitEvicted.
 */
export function gpuCapacity(a) {
  const b = buildTokens(a);
  const t = a.throughput;
  const cached = gpuSecondsPerBuild(a, t.prefixCacheHit);
  const evicted = gpuSecondsPerBuild(a, t.prefixCacheHitEvicted);
  const sessions = t.kvCacheTokens / avgContextTokens(a);
  const kvBuildsPerHour = sessions * (60 / a.build.wallMinutes);
  const computeBuildsPerHour = 3600 / cached;
  const buildsPerHour = computeBuildsPerHour <= kvBuildsPerHour
    ? computeBuildsPerHour
    : kvBuildsPerHour + (3600 - kvBuildsPerHour * cached) / evicted;
  const inputPerSec = (buildsPerHour * b.input) / 3600;
  return {
    weightedPerSec: (buildsPerHour * b.weighted) / 3600,
    inputPerSec,
    outputPerSec: (buildsPerHour * b.output) / 3600,
    buildsPerHour,
    computeBuildsPerHour,
    kvBuildsPerHour,
    concurrentBuilds: sessions,
    limitedBy: computeBuildsPerHour <= kvBuildsPerHour ? "compute" : "kv-cache",
  };
}

/** One GPU's monthly bill, with the scheduled-stop hours. */
export function gpuHourly(a) {
  return a.gpu.hourlyUsd != null ? a.gpu.hourlyUsd / a.usdPerCurrencyUnit : a.gpu.hourly;
}

export function gpuMonthly(a) {
  const g = a.gpu;
  const on = Math.min(24, Math.max(0, a.onHoursPerDay)) / 24;
  let running = gpuHourly(a) * a.hoursPerMonth * on;
  if (g.monthlyCap != null) running = Math.min(running, g.monthlyCap);
  const stopped = g.stoppedHourly * a.hoursPerMonth * (1 - on);
  const fixed = g.storageGb * g.storagePerGbMonth + g.ipv4Monthly + (g.fixedMonthlyUsd ?? 0) / a.usdPerCurrencyUnit;
  return { running, stopped, fixed, total: running + stopped + fixed, onFraction: on };
}

/** $/1M weighted tokens per utilisation scenario. */
export function perTokenScenarios(a) {
  const cap = gpuCapacity(a);
  const m = gpuMonthly(a);
  const onSeconds = a.hoursPerMonth * 3600 * m.onFraction;
  return a.scenarios.map((s) => {
    const weightedPerMonth = cap.weightedPerSec * s.utilisation * onSeconds;
    return {
      ...s,
      weightedPerMonth,
      buildsPerMonth: weightedPerMonth / buildTokens(a).weighted,
      costPerMWeighted: m.total / (weightedPerMonth / 1e6),
    };
  });
}

/**
 * Expected weighted tokens one signup uses over the promotion, week by week.
 * A builder's path is followed deterministically (starter reserve spent after
 * the week's top-up, never more than the allowance), then weighted by the
 * chance they're active that week.
 */
export function customerModel(a) {
  const u = a.users;
  const al = a.allowance;
  const perBuild = buildTokens(a).weighted;
  let starterLeft = al.starter;
  const weeks = [];
  for (let k = 1; k <= u.promoWeeks; k += 1) {
    const wanted = (k === 1 ? u.buildsFirstWeek : u.buildsPerActiveWeek) * perBuild;
    const used = Math.min(wanted, al.weekly + starterLeft);
    starterLeft -= Math.max(0, used - al.weekly);
    const pActive = k === 1 ? 1 : u.pctReturnWeekly * u.weeklyRetention ** (k - 2);
    weeks.push({ week: k, usedIfActive: used, pActive, expected: u.pctBuild * pActive * used });
  }
  const lifetime = weeks.reduce((s, w) => s + w.expected, 0);
  const first30d = weeks.slice(0, 4).reduce((s, w) => s + w.expected, 0) + (weeks[4]?.expected ?? 0) * (2 / 7);
  return {
    weeks,
    lifetimeWeighted: lifetime,
    first30dWeighted: first30d,
    ceilingWeighted: al.starter + al.weekly * u.promoWeeks,
    perBuildWeighted: perBuild,
    lifetimeBuilds: lifetime / perBuild,
  };
}

/** GPUs needed for an average weighted-tokens/s, given peaks and the utilisation ceiling. */
export function gpusFor(a, avgWeightedPerSec) {
  const cap = gpuCapacity(a).weightedPerSec * a.fleet.maxUtilisation;
  return Math.max(a.fleet.minGpus, Math.ceil((avgWeightedPerSec * a.fleet.peakToAverage) / cap - 1e-9));
}

/**
 * Serverless workers for a month of served tokens. Builds arrive at random
 * (Poisson, average rate; real traffic is peakier, which means more idle
 * gaps, so this errs high on cost and low on cold starts). A build keeps a
 * worker busy for wallMinutes, then the worker idles idleTimeoutSeconds
 * before scaling down. One worker is up whenever any build is in that
 * window; more workers come up only when load exceeds one worker's capacity.
 */
export function serverlessMonthly(a, servedWeightedPerMonth) {
  const s = a.serverless;
  const fx = a.usdPerCurrencyUnit;
  const hours = a.hoursPerMonth;
  const buildsPerHour = servedWeightedPerMonth / buildTokens(a).weighted / hours;
  const windowHours = (a.build.wallMinutes * 60 + s.idleTimeoutSeconds + s.coldStartSeconds) / 3600;
  const pIdle = Math.exp(-buildsPerHour * windowHours);
  const capacityPerHour = gpuCapacity(a).weightedPerSec * a.fleet.maxUtilisation * 3600;
  const loadWorkerHours = servedWeightedPerMonth / capacityPerHour;
  const workerHours = Math.max((1 - pIdle) * hours, loadWorkerHours);
  const activeHours = s.activeWorkers * hours;
  const flexHours = Math.max(0, workerHours - activeHours);
  const cost = (activeHours * s.activePerSecondUsd * 3600 + flexHours * s.flexPerSecondUsd * 3600 + s.storageMonthlyUsd) / fx;
  const coldStartShare = s.activeWorkers > 0 ? 0 : pIdle;
  return {
    cost,
    workerHours: Math.max(workerHours, activeHours),
    dutyCycle: Math.min(1, Math.max(workerHours, activeHours) / hours),
    coldStartsPerMonth: buildsPerHour * hours * coldStartShare,
    /** Share of builds whose first reply waits coldStartSeconds. */
    coldStartShare,
  };
}

/** The monthly bill at N signups a month (steady state) and for a one-off cohort's first month. */
export function monthlyBills(a) {
  const c = customerModel(a);
  const secondsPerMonth = a.hoursPerMonth * 3600;
  const gpu = gpuMonthly(a).total;
  const capPerMonth = a.allowance.dailyCap * (a.hoursPerMonth / 24);
  return a.signupVolumes.map((n) => {
    const steady = n * c.lifetimeWeighted; // Little's law: arrivals × tokens per arrival
    const served = Math.min(steady, capPerMonth);
    const cohortFirstMonth = Math.min(n * c.first30dWeighted, capPerMonth);
    const hosted = (served / 1e6) * benchmarkPerMWeighted(a, a.benchmarks[a.sameModelBenchmark]) + a.overheadMonthly;
    const sl = a.mode === "serverless" ? serverlessMonthly(a, served) : null;
    const gpus = a.mode === "always-on" ? gpusFor(a, served / secondsPerMonth) : 0;
    const bill = a.mode === "hosted" ? hosted : sl ? sl.cost + a.overheadMonthly : gpus * gpu + a.overheadMonthly;
    return {
      ...(sl ? { serverless: sl } : {}),
      hostedBill: hosted,
      signupsPerMonth: n,
      demandWeighted: steady,
      servedWeighted: served,
      refusedShare: steady > 0 ? 1 - served / steady : 0,
      gpus,
      bill,
      perSignup: bill / n,
      marginalPerSignup: (c.lifetimeWeighted / 1e6) * marginalCostPerMWeighted(a),
      cohortFirstMonthWeighted: cohortFirstMonth,
      utilisation: gpus > 0 ? served / secondsPerMonth / (gpus * gpuCapacity(a).weightedPerSec) : null,
    };
  });
}

/** Cost per 1M weighted tokens when a GPU runs at maxUtilisation: the floor of what a token can cost us. */
export function marginalCostPerMWeighted(a) {
  const cap = gpuCapacity(a).weightedPerSec * a.fleet.maxUtilisation;
  const perSecond = gpuMonthly(a).total / (a.hoursPerMonth * 3600 * gpuMonthly(a).onFraction);
  return (perSecond / cap) * 1e6;
}

/** What the daily cap means in GPUs. */
export function dailyCapView(a) {
  const capPerSec = a.allowance.dailyCap / 86400;
  const oneGpuDay = gpuCapacity(a).weightedPerSec * 86400;
  return {
    dailyCap: a.allowance.dailyCap,
    oneGpuDayAt100: oneGpuDay,
    shareOfOneGpu: a.allowance.dailyCap / oneGpuDay,
    gpusToServeCapAtPeak: gpusFor(a, capPerSec),
    buildsPerDayAtCap: a.allowance.dailyCap / buildTokens(a).weighted,
    /** Weighted tokens/day that fill one GPU to maxUtilisation at the peak hour. */
    capThatFillsOneGpu: (gpuCapacity(a).weightedPerSec * a.fleet.maxUtilisation * 86400) / a.fleet.peakToAverage,
  };
}

/**
 * Hosted-API price of the same mix, per 1M weighted tokens, in `currency`.
 * A benchmark may set `cachedInputPerM` (applied to hostedCacheHit of the
 * input), `feePct` (e.g. a credit-purchase fee) and `currency` (default USD; a price in the model's own currency
 * is taken as is).
 */
export function benchmarkPerMWeighted(a, bm) {
  const b = buildTokens(a);
  const hit = bm.cachedInputPerM != null ? a.hostedCacheHit : 0;
  const inputPrice = (1 - hit) * bm.inputPerM + hit * (bm.cachedInputPerM ?? bm.inputPerM);
  const price = ((b.input * inputPrice + b.output * bm.outputPerM) / b.weighted) * (1 + (bm.feePct ?? 0));
  return bm.currency === a.currency ? price : price / a.usdPerCurrencyUnit;
}

/** Selling tokens: break-even and target prices, and tokens per $1 voucher. */
export function salesView(a) {
  const s = a.sales;
  const scen = perTokenScenarios(a);
  const costAt = (u) => gpuMonthly(a).total / ((gpuCapacity(a).weightedPerSec * u * a.hoursPerMonth * 3600 * gpuMonthly(a).onFraction) / 1e6);
  const costPerM = costAt(s.pricingUtilisation); // currency per 1M weighted
  const costPerMUsd = costPerM * a.usdPerCurrencyUnit;
  const netPerVoucherUsd = s.voucherUsd * (1 - s.paymentFeePct) - s.paymentFeeFixedUsd / s.vouchersPerPurchase;
  const breakEvenTokensPerVoucher = (netPerVoucherUsd / costPerMUsd) * 1e6;
  const targetTokensPerVoucher = breakEvenTokensPerVoucher * (1 - s.marginPct);
  const priceUsdPerM = s.voucherUsd / (targetTokensPerVoucher / 1e6);
  const hostedUsd = a.benchmarks.map((bm) => ({ name: bm.name, usdPerMWeighted: benchmarkPerMWeighted(a, bm) * a.usdPerCurrencyUnit }));
  const sameModel = hostedUsd[a.sameModelBenchmark];
  // Utilisation at which our GPU matches renting the same model by the token.
  // Serverless: the share of a worker's up-time it must spend busy.
  const crossoverUtilisation = a.mode === "serverless"
    ? (a.serverless.flexPerSecondUsd * 3600) / ((sameModel.usdPerMWeighted / 1e6) * gpuCapacity(a).weightedPerSec * 3600)
    : (gpuMonthly(a).total * a.usdPerCurrencyUnit) /
      ((sameModel.usdPerMWeighted / 1e6) * gpuCapacity(a).weightedPerSec * a.hoursPerMonth * 3600 * gpuMonthly(a).onFraction);
  const crossoverWeightedPerMonth = (gpuMonthly(a).total * a.usdPerCurrencyUnit) / (sameModel.usdPerMWeighted / 1e6);
  return {
    pricingUtilisation: s.pricingUtilisation,
    costPerM,
    costPerMUsd,
    netPerVoucherUsd,
    breakEvenTokensPerVoucher,
    targetTokensPerVoucher,
    priceUsdPerM,
    hostedUsd,
    sameModel,
    crossoverUtilisation,
    crossoverWeightedPerMonth,
    scenarios: scen,
  };
}

export function model(assumptions = DEFAULTS) {
  const a = assumptions;
  return {
    assumptions: a,
    build: buildTokens(a),
    capacity: gpuCapacity(a),
    gpuMonthly: gpuMonthly(a),
    perToken: perTokenScenarios(a),
    customer: customerModel(a),
    bills: monthlyBills(a),
    dailyCap: dailyCapView(a),
    sales: salesView(a),
  };
}

/* ─────────────────────────── comparison ─────────────────────────────── */

/** One row per option (each a DEFAULTS override), all in `currency`. */
export function compare(overrides, base = DEFAULTS) {
  return overrides.map((o) => {
    const a = deepMerge(base, o);
    const r = model(a);
    return {
      label: a.meta.label,
      mode: a.mode,
      bills: r.bills.map((b) => ({
        signupsPerMonth: b.signupsPerMonth,
        bill: b.bill,
        perSignup: b.perSignup,
        ...(b.serverless ? { dutyCycle: b.serverless.dutyCycle, coldStartShare: b.serverless.coldStartShare } : {}),
      })),
      breakEvenUtilisation: a.mode === "hosted" ? null : r.sales.crossoverUtilisation,
      perMWeighted: a.mode === "hosted" ? benchmarkPerMWeighted(a, a.benchmarks[a.sameModelBenchmark]) : null,
      coldStartSeconds: a.mode === "serverless" && a.serverless.activeWorkers === 0 ? a.serverless.coldStartSeconds : 0,
      whoSeesPrompts: a.meta.whoSeesPrompts,
      eu: a.meta.eu,
      effort: a.meta.effort,
    };
  });
}

export function compareReport(rows, a = DEFAULTS) {
  const cur = a.currency;
  const vols = a.signupVolumes;
  const L = [];
  L.push(`| option | ${vols.map((n) => `${n.toLocaleString("en-US")}/mo: bill (per signup)`).join(" | ")} | break-even utilisation | who can see prompts | EU hosting | operational effort |`);
  L.push(`|---|${vols.map(() => "---").join("|")}|---|---|---|---|`);
  for (const r of rows) {
    const cells = r.bills.map((b) => {
      const extra = b.dutyCycle != null
        ? `; up ${pct(b.dutyCycle)}${b.coldStartShare > 0.005 ? `, ${pct(b.coldStartShare)} cold` : ""}`
        : "";
      return `${money(b.bill, cur)} (${money(b.perSignup, cur)}${extra})`;
    });
    const be = r.breakEvenUtilisation == null
      ? `n/a: ${money(r.perMWeighted, cur)} per 1M weighted`
      : r.mode === "serverless" ? `${pct(r.breakEvenUtilisation)} of up-time busy` : pct(r.breakEvenUtilisation);
    L.push(`| ${r.label} | ${cells.join(" | ")} | ${be} | ${r.whoSeesPrompts} | ${r.eu} | ${r.effort} |`);
  }
  return L.join("\n");
}

/* ─────────────────────────── report ─────────────────────────────────── */

const M = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : n.toFixed(0));
const money = (n, cur) => `${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n >= 1 ? 2 : 3)} ${cur}`;
const pct = (n) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

export function report(r) {
  const a = r.assumptions;
  const cur = a.currency;
  const L = [];
  L.push(`# Free AI on our own GPU: cost model`, ``);
  L.push(`Option: **${a.meta.label}** (mode ${a.mode}).`);
  L.push(`GPU: ${a.gpu.label}, ${money(gpuHourly(a), cur)}/h, on ${a.onHoursPerDay} h/day → ` +
    `**${money(r.gpuMonthly.total, cur)}/month** (running ${money(r.gpuMonthly.running, cur)}, stopped ${money(r.gpuMonthly.stopped, cur)}, disk+IP ${money(r.gpuMonthly.fixed, cur)}).`);
  L.push(`One build: ${M(r.build.input)} input + ${M(r.build.output)} output = **${M(r.build.weighted)} weighted**.`);
  L.push(`One GPU at 100%: ${M(r.capacity.weightedPerSec)} weighted tok/s ≈ **${r.capacity.buildsPerHour.toFixed(0)} builds/hour**, ` +
    (r.capacity.limitedBy === "kv-cache"
      ? `KV-bound: ~${r.capacity.concurrentBuilds.toFixed(1)} builds stay cached at once (${r.capacity.kvBuildsPerHour.toFixed(0)}/h); ` +
        `past that builds re-read their context (with room for all, compute would allow ${r.capacity.computeBuildsPerHour.toFixed(0)}/h).`
      : `compute-bound (the KV room would keep ${r.capacity.kvBuildsPerHour.toFixed(0)} builds/h cached).`), ``);

  L.push(`## Cost per 1M weighted tokens by utilisation`, ``);
  L.push(`| scenario | utilisation | weighted tokens/month | builds/month | ${cur} per 1M weighted |`);
  L.push(`|---|---|---|---|---|`);
  for (const s of r.perToken) {
    L.push(`| ${s.name} | ${pct(s.utilisation)} | ${M(s.weightedPerMonth)} | ${M(s.buildsPerMonth)} | ${money(s.costPerMWeighted, cur)} |`);
  }
  L.push(``);

  const c = r.customer;
  L.push(`## One new customer`, ``);
  L.push(`Expected use over a ${a.users.promoWeeks}-week promotion: **${M(c.lifetimeWeighted)} weighted** ` +
    `(${c.lifetimeBuilds.toFixed(1)} builds; first 30 days ${M(c.first30dWeighted)}). ` +
    `Ceiling if they use everything: ${M(c.ceilingWeighted)}.`);
  L.push(`Marginal GPU cost of that use (GPU at ${pct(a.fleet.maxUtilisation)}): ` +
    `**${money((c.lifetimeWeighted / 1e6) * marginalCostPerMWeighted(a), cur)}**; ` +
    `at the ceiling: ${money((c.ceilingWeighted / 1e6) * marginalCostPerMWeighted(a), cur)}.`, ``);

  L.push(`## Monthly bill (steady state: N signups every month)`, ``);
  L.push(`| signups/month | demand (weighted) | refused by daily cap | GPUs | bill/month | per signup (fully loaded) | GPU utilisation | same tokens rented (${a.benchmarks[a.sameModelBenchmark].name}) |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const b of r.bills) {
    L.push(`| ${b.signupsPerMonth.toLocaleString("en-US")} | ${M(b.demandWeighted)} | ${pct(b.refusedShare)} | ${b.gpus || "—"} | ${money(b.bill, cur)} | ${money(b.perSignup, cur)} | ${b.utilisation == null ? (b.serverless ? `worker up ${pct(b.serverless.dutyCycle)}` : "—") : pct(b.utilisation)} | ${money(b.hostedBill, cur)} |`);
  }
  L.push(``);

  const d = r.dailyCap;
  L.push(`## The daily cap`, ``);
  L.push(`${M(d.dailyCap)} weighted/day ≈ ${d.buildsPerDayAtCap.toFixed(0)} builds/day = ${pct(d.shareOfOneGpu)} of one GPU's 24 h at 100%. ` +
    `Serving the whole cap with a ${a.fleet.peakToAverage}× peak needs ${d.gpusToServeCapAtPeak} GPU(s). ` +
    `The cap that just fills one GPU at peak: ${M(d.capThatFillsOneGpu)}/day.`, ``);

  const s = r.sales;
  L.push(`## Selling tokens`, ``);
  L.push(`Priced for ${pct(s.pricingUtilisation)} utilisation: cost ${money(s.costPerM, cur)} ($${s.costPerMUsd.toFixed(3)}) per 1M weighted.`);
  L.push(`A $${a.sales.voucherUsd} voucher nets $${s.netPerVoucherUsd.toFixed(3)} after fees → break-even **${M(s.breakEvenTokensPerVoucher)} weighted tokens per $1**; ` +
    `with a ${pct(a.sales.marginPct)} margin: **${M(s.targetTokensPerVoucher)} per $1** = $${s.priceUsdPerM.toFixed(2)} per 1M weighted.`);
  L.push(``, `| hosted benchmark | USD per 1M weighted (same mix) |`, `|---|---|`);
  for (const h of s.hostedUsd) L.push(`| ${h.name} | $${h.usdPerMWeighted.toFixed(3)} |`);
  L.push(``, `Our GPU matches renting the same model (${s.sameModel.name}) at **${pct(s.crossoverUtilisation)} utilisation** ` +
    `(${M(s.crossoverWeightedPerMonth)} weighted tokens a month); below that, renting is cheaper per token.`);
  return L.join("\n");
}

/* ─────────────────────────── CLI ────────────────────────────────────── */

export function parseArgs(argv, base = DEFAULTS) {
  let a = structuredClone(base);
  let json = false;
  let compareDir = null;
  const rest = [...argv];
  while (rest.length) {
    const f = rest.shift();
    if (f === "--json") json = true;
    else if (f === "--compare") compareDir = rest[0] && !rest[0].startsWith("--") ? rest.shift() : join(HERE, "cost-presets");
    else if (f === "--set") {
      const kv = rest.shift() ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error("--set needs path=value");
      a = setPath(a, kv.slice(0, eq), kv.slice(eq + 1));
    } else if (f === "--config") {
      const p = rest.shift();
      if (!p) throw new Error("--config needs a path");
      a = deepMerge(a, JSON.parse(readFileSync(p, "utf8")));
    } else throw new Error(`unknown flag: ${f}`);
  }
  return { assumptions: a, json, compareDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { assumptions, json, compareDir } = parseArgs(process.argv.slice(2));
    if (compareDir) {
      const files = readdirSync(compareDir).filter((f) => f.endsWith(".json")).sort();
      const rows = compare(files.map((f) => JSON.parse(readFileSync(join(compareDir, f), "utf8"))), assumptions);
      console.log(json ? JSON.stringify(rows, null, 2) : compareReport(rows, assumptions));
    } else {
      const r = model(assumptions);
      console.log(json ? JSON.stringify(r, null, 2) : report(r));
    }
  } catch (e) {
    console.error(`cost-model: ${e.message}`);
    process.exitCode = 1;
  }
}
