// The free-AI cost model: the arithmetic the pricing doc quotes.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  buildTokens,
  compare,
  serverlessMonthly,
  customerModel,
  dailyCapView,
  gpuCapacity,
  gpuMonthly,
  gpusFor,
  model,
  monthlyBills,
  parseArgs,
  perTokenScenarios,
  report,
  salesView,
  setPath,
  // @ts-expect-error JavaScript CLI intentionally has no declaration file.
} from "../cost-model.mjs";

const clone = () => structuredClone(DEFAULTS);

describe("build tokens", () => {
  it("re-sends the growing history every turn", () => {
    const a = clone();
    a.build = { turns: 3, firstPromptTokens: 1000, growthPerTurn: 100, outputPerTurn: 50 };
    // 1000 + 1100 + 1200 in, 150 out, output ×4
    expect(buildTokens(a)).toEqual({ input: 3300, output: 150, weighted: 3300 + 600 });
  });
});

describe("GPU", () => {
  it("bills only storage and IP for stopped hours", () => {
    const a = clone();
    a.onHoursPerDay = 12;
    const m = gpuMonthly(a);
    expect(m.running).toBeCloseTo(a.gpu.hourly * a.hoursPerMonth / 2);
    expect(m.stopped).toBe(0);
    expect(m.fixed).toBeCloseTo(a.gpu.storageGb * a.gpu.storagePerGbMonth + a.gpu.ipv4Monthly);
  });

  it("applies a monthly cap when the provider has one", () => {
    const a = clone();
    a.gpu.monthlyCap = 500;
    expect(gpuMonthly(a).running).toBe(500);
  });

  it("is bounded by prefill and decode together", () => {
    const a = clone();
    const base = gpuCapacity(a).weightedPerSec;
    a.throughput.decodeTokPerSec *= 2;
    expect(gpuCapacity(a).weightedPerSec).toBeGreaterThan(base);
    a.throughput.prefixCacheHit = 0;
    expect(gpuCapacity(a).weightedPerSec).toBeLessThan(base * 2);
  });

  it("costs less per token the busier it is", () => {
    const s = perTokenScenarios(clone());
    for (let i = 1; i < s.length; i += 1) expect(s[i].costPerMWeighted).toBeLessThan(s[i - 1].costPerMWeighted);
    // cost × tokens = the monthly bill
    expect((s[0].costPerMWeighted * s[0].weightedPerMonth) / 1e6).toBeCloseTo(gpuMonthly(clone()).total);
  });
});

describe("customers", () => {
  it("never uses more than the allowance", () => {
    const a = clone();
    a.users = { ...a.users, pctBuild: 1, pctReturnWeekly: 1, weeklyRetention: 1, buildsFirstWeek: 100, buildsPerActiveWeek: 100 };
    const c = customerModel(a);
    expect(c.lifetimeWeighted).toBeCloseTo(c.ceilingWeighted);
    expect(c.weeks[0].usedIfActive).toBe(a.allowance.starter + a.allowance.weekly);
    expect(c.weeks[1].usedIfActive).toBe(a.allowance.weekly);
  });

  it("is zero when nobody builds", () => {
    const a = clone();
    a.users.pctBuild = 0;
    expect(customerModel(a).lifetimeWeighted).toBe(0);
  });
});

describe("fleet and bills", () => {
  it("adds GPUs only past the utilisation ceiling at the peak", () => {
    const a = clone();
    const cap = gpuCapacity(a).weightedPerSec * a.fleet.maxUtilisation;
    expect(gpusFor(a, 0)).toBe(1);
    expect(gpusFor(a, cap / a.fleet.peakToAverage)).toBe(1);
    expect(gpusFor(a, (cap / a.fleet.peakToAverage) * 1.01)).toBe(2);
  });

  it("serves no more than the daily cap and says how much it refused", () => {
    const a = clone();
    a.signupVolumes = [1_000_000];
    const [b] = monthlyBills(a);
    expect(b.servedWeighted).toBeCloseTo(a.allowance.dailyCap * (a.hoursPerMonth / 24));
    expect(b.refusedShare).toBeGreaterThan(0.9);
  });

  it("relates the daily cap to one GPU", () => {
    const d = dailyCapView(clone());
    expect(d.shareOfOneGpu).toBeCloseTo(DEFAULTS.allowance.dailyCap / (gpuCapacity(clone()).weightedPerSec * 86400));
  });
});

describe("sales", () => {
  it("keeps the margin and the card fees out of the voucher", () => {
    const s = salesView(clone());
    expect(s.targetTokensPerVoucher).toBeCloseTo(s.breakEvenTokensPerVoucher * (1 - DEFAULTS.sales.marginPct));
    expect(s.netPerVoucherUsd).toBeLessThan(DEFAULTS.sales.voucherUsd);
    expect(s.priceUsdPerM).toBeGreaterThan(s.costPerMUsd);
  });
});

describe("CLI", () => {
  it("overrides one number and refuses unknown settings", () => {
    const { assumptions } = parseArgs(["--set", "gpu.hourly=2.5", "--set", "gpu.monthlyCap=null"]);
    expect(assumptions.gpu.hourly).toBe(2.5);
    expect(assumptions.gpu.monthlyCap).toBeNull();
    expect(DEFAULTS.gpu.hourly).not.toBe(2.5);
    expect(() => setPath(DEFAULTS, "gpu.nope", "1")).toThrow(/unknown setting/);
  });

  it("renders every section", () => {
    const text = report(model(clone()));
    for (const h of ["Cost per 1M weighted tokens", "One new customer", "Monthly bill", "The daily cap", "Selling tokens"]) {
      expect(text).toContain(h);
    }
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
  });
});

describe("RunPod and other options", () => {
  it("converts USD hourly prices", () => {
    const a = clone();
    a.gpu.hourlyUsd = a.usdPerCurrencyUnit * 2;
    expect(gpuMonthly(a).running).toBeCloseTo(2 * a.hoursPerMonth);
  });

  it("bills serverless for up-time, more cold starts the quieter it is", () => {
    const a = clone();
    a.mode = "serverless";
    a.serverless = { ...a.serverless, flexPerSecondUsd: 0.0005, storageMonthlyUsd: 0 };
    const quiet = serverlessMonthly(a, 1e8);
    const busy = serverlessMonthly(a, 1e9);
    expect(quiet.cost).toBeLessThan(busy.cost);
    expect(quiet.coldStartShare).toBeGreaterThan(busy.coldStartShare);
    expect(quiet.cost).toBeCloseTo((quiet.workerHours * 0.0005 * 3600) / a.usdPerCurrencyUnit);
    expect(serverlessMonthly(a, 0).cost).toBe(0);
    a.serverless.activeWorkers = 1;
    a.serverless.activePerSecondUsd = 0.0004;
    expect(serverlessMonthly(a, 0).cost).toBeCloseTo((a.hoursPerMonth * 0.0004 * 3600) / a.usdPerCurrencyUnit);
    expect(serverlessMonthly(a, 1e8).coldStartShare).toBe(0);
  });

  it("compares every shipped preset with no gaps", () => {
    const dir = fileURLToPath(new URL("../cost-presets", import.meta.url));
    const presets = readdirSync(dir).filter((f: string) => f.endsWith(".json")).map((f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    const rows = compare(presets);
    expect(rows.map((r: { mode: string }) => r.mode)).toEqual(expect.arrayContaining(["always-on", "serverless", "hosted"]));
    for (const r of rows) {
      expect(r.whoSeesPrompts && r.eu && r.effort).toBeTruthy();
      for (const b of r.bills) expect(Number.isFinite(b.bill) && b.bill > 0).toBe(true);
    }
    const hosted = rows.find((r: { mode: string }) => r.mode === "hosted");
    expect(hosted.breakEvenUtilisation).toBeNull();
  });
});
