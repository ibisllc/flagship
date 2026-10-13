import { describe, expect, it } from "vitest";
import {
  InMemoryMeterStore,
  meterCheck,
  meterPeriodKey,
  meterRecord,
  meterResetsAt,
  type MeterCatalog,
  type MeterDeps,
} from "../src/index.js";

type Plan = "basic" | "pro";
type Resource = "bandwidth" | "tokens" | "seats";

const NOW = Date.UTC(2026, 9, 13, 15, 30); // 2026-10-13

const CATALOG: MeterCatalog<Resource, Plan> = {
  bandwidth: {
    unit: "bytes",
    period: "month",
    plans: { basic: { allowance: 100, over: "throttle" }, pro: { allowance: 1000, over: "allow" } },
  },
  tokens: {
    unit: "tokens",
    period: "day",
    plans: { basic: { allowance: 10, over: "stop" }, pro: { allowance: 50, over: "stop" } },
  },
  seats: {
    unit: "seats",
    period: "lifetime",
    plans: { basic: { allowance: 1, over: "stop" }, pro: { allowance: 5, over: "stop" } },
  },
};

function deps(plans: Record<string, Plan> = {}, now = NOW): MeterDeps<Resource, Plan> & { store: InMemoryMeterStore } {
  return {
    catalog: CATALOG,
    store: new InMemoryMeterStore(),
    planOf: async (account) => plans[account] ?? "basic",
    now: () => now,
  };
}

describe("periods", () => {
  it("keys month, day and lifetime counters in UTC", () => {
    expect(meterPeriodKey("month", NOW)).toBe("2026-10");
    expect(meterPeriodKey("day", NOW)).toBe("2026-10-13");
    expect(meterPeriodKey("lifetime", NOW)).toBe("all");
    expect(meterPeriodKey("day", Date.UTC(2025, 11, 31, 23, 59))).toBe("2025-12-31");
  });

  it("reports when each period resets", () => {
    expect(meterResetsAt("month", NOW)).toBe(Date.UTC(2026, 10, 1));
    expect(meterResetsAt("day", NOW)).toBe(Date.UTC(2026, 9, 14));
    expect(meterResetsAt("month", Date.UTC(2026, 11, 31))).toBe(Date.UTC(2027, 0, 1));
    expect(meterResetsAt("lifetime", NOW)).toBeNull();
  });
});

describe("record and check", () => {
  it("accumulates per (account, resource, period) and leaves the account id alone", async () => {
    const d = deps();
    await meterRecord(d, "Ann", "bandwidth", 30);
    const v = await meterRecord(d, "Ann", "bandwidth", 20);
    expect(v).toMatchObject({ account: "Ann", resource: "bandwidth", plan: "basic", period: "2026-10", used: 50, remaining: 50, action: "allow" });
    expect((await meterCheck(d, "ann", "bandwidth")).used).toBe(0);
    expect((await meterCheck(d, "Ann", "tokens")).used).toBe(0);
  });

  it("check never records", async () => {
    const d = deps();
    await meterCheck(d, "ann", "bandwidth", 5);
    expect(await d.store.get("ann", "bandwidth", "2026-10")).toBeUndefined();
  });

  it("exactly at the allowance is not over; one past is", async () => {
    const d = deps();
    expect((await meterRecord(d, "ann", "bandwidth", 100)).action).toBe("allow");
    expect(await meterRecord(d, "ann", "bandwidth", 1)).toMatchObject({ over: true, policy: "throttle", action: "throttle", remaining: 0 });
  });

  it("an 'allow' policy stays allowed past the allowance, but reports over", async () => {
    const d = deps({ ann: "pro" });
    expect(await meterRecord(d, "ann", "bandwidth", 5000)).toMatchObject({ plan: "pro", over: true, policy: "allow", action: "allow" });
  });

  it("need asks whether more would fit: stop once nothing is left", async () => {
    const d = deps();
    await meterRecord(d, "ann", "tokens", 9);
    expect((await meterCheck(d, "ann", "tokens", 1)).action).toBe("allow");
    expect((await meterRecord(d, "ann", "tokens", 1)).action).toBe("allow");
    expect(await meterRecord(d, "ann", "tokens", 0, 1)).toMatchObject({ used: 10, action: "stop", resetsAt: Date.UTC(2026, 9, 14) });
    expect((await meterCheck(d, "ann", "tokens", 1)).action).toBe("stop");
  });

  it("the plan is looked up per call (an upgrade applies at once)", async () => {
    const plans: Record<string, Plan> = {};
    const d = deps(plans);
    await meterRecord(d, "ann", "tokens", 20);
    expect((await meterCheck(d, "ann", "tokens", 1)).action).toBe("stop");
    plans.ann = "pro";
    expect((await meterCheck(d, "ann", "tokens", 1)).action).toBe("allow");
  });

  it("a new period starts from zero; lifetime never resets", async () => {
    const d = deps();
    await meterRecord(d, "ann", "bandwidth", 500);
    await meterRecord(d, "ann", "seats", 1);
    const next = { ...d, now: () => Date.UTC(2026, 10, 1) };
    expect(await meterCheck(next, "ann", "bandwidth")).toMatchObject({ period: "2026-11", used: 0, action: "allow" });
    expect(await meterCheck(next, "ann", "seats", 1)).toMatchObject({ period: "all", used: 1, action: "stop", resetsAt: null });
  });

  it("rejects a negative or non-finite amount or need", async () => {
    const d = deps();
    await expect(meterRecord(d, "ann", "bandwidth", -1)).rejects.toThrow(RangeError);
    await expect(meterRecord(d, "ann", "bandwidth", Number.NaN)).rejects.toThrow(RangeError);
    await expect(meterCheck(d, "ann", "bandwidth", Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
  });

  it("fails loudly on a resource or plan missing from the catalog", async () => {
    const d = deps();
    await expect(meterCheck(d, "ann", "nope" as Resource)).rejects.toThrow(/unknown metered resource/);
    const badPlan = { ...d, planOf: async () => "gold" as Plan };
    await expect(meterCheck(badPlan, "ann", "bandwidth")).rejects.toThrow(/no plan gold/);
  });
});
