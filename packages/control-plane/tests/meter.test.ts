// Flagship's wiring of @ibisllc/billing-metering: the tier table, lowercased
// usernames and the effective-tier lookup. The core itself (periods, need,
// validation) is tested in billing/packages/metering/tests.
import { describe, expect, it } from "vitest";
import { InMemoryMeterStorage, InMemoryTierStorage, type TierName } from "@flagship/storage";
import { METER_RESOURCES, meterCheck, meterRecord, type MeterDeps, type MeterResourceSpec } from "../src/meter.js";

const GB = 1024 * 1024 * 1024;
const NOW = Date.UTC(2026, 9, 13, 15, 30); // 2026-10-13

async function deps(tier?: TierName, currentPeriodEnd?: number): Promise<MeterDeps & { meter: InMemoryMeterStorage }> {
  const tiers = new InMemoryTierStorage();
  if (tier) await tiers.put({ username: "alice", tier, currentPeriodEnd, updatedAt: 1 });
  return { meter: new InMemoryMeterStorage(), tiers, now: () => NOW };
}

describe("meter — Flagship's tier table", () => {
  it("egress: free 25 GB then throttle; paid tiers keep going and are billed", () => {
    const e = METER_RESOURCES.egress;
    expect(e.period).toBe("month");
    expect(e.plans.free).toEqual({ allowance: 25 * GB, over: "throttle" });
    expect(e.plans.hobby).toEqual({ allowance: 250 * GB, over: "allow" });
    expect(e.plans.maker).toEqual({ allowance: 500 * GB, over: "allow" });
  });

  it("ai-tokens: monthly, and every tier stops issuing when over", () => {
    const t = METER_RESOURCES["ai-tokens"];
    expect(t.period).toBe("month");
    for (const tier of ["free", "hobby", "maker"] as const) expect(t.plans[tier].over).toBe("stop");
  });
});

describe("meter — record and check", () => {
  it("accumulates per (account, resource, period) and lowercases the account", async () => {
    const d = await deps();
    await meterRecord(d, "Alice", "ai-tokens", 300);
    const v = await meterRecord(d, "alice", "ai-tokens", 200);
    expect(v).toMatchObject({ account: "alice", resource: "ai-tokens", period: "2026-10", used: 500, action: "allow", tier: "free", plan: "free" });
    expect((await meterCheck(d, "alice", "egress")).used).toBe(0);
    expect((await d.meter.get("alice", "ai-tokens", "2026-10"))?.amount).toBe(500);
  });

  it("free egress over the allowance ⇒ throttle", async () => {
    const d = await deps();
    const v = await meterRecord(d, "alice", "egress", 25 * GB + 1);
    expect(v).toMatchObject({ tier: "free", over: true, policy: "throttle", action: "throttle", remaining: 0 });
  });

  it("exactly at the allowance is not over", async () => {
    const d = await deps();
    expect((await meterRecord(d, "alice", "egress", 25 * GB)).action).toBe("allow");
  });

  it("paid egress over the allowance is billed, never throttled", async () => {
    const d = await deps("hobby");
    const v = await meterRecord(d, "alice", "egress", 300 * GB);
    expect(v).toMatchObject({ tier: "hobby", over: true, policy: "allow", action: "allow" });
  });

  it("a lapsed paid subscription meters as free", async () => {
    const d = await deps("maker", NOW - 1);
    expect((await meterRecord(d, "alice", "egress", 30 * GB)).action).toBe("throttle");
  });

  it("ai-tokens stop once nothing is left: check(need=1) at the allowance", async () => {
    const d = await deps();
    const cap = METER_RESOURCES["ai-tokens"].plans.free.allowance;
    await meterRecord(d, "alice", "ai-tokens", cap - 1);
    expect((await meterCheck(d, "alice", "ai-tokens", 1)).action).toBe("allow");
    expect((await meterRecord(d, "alice", "ai-tokens", 1)).action).toBe("allow");
    expect((await meterRecord(d, "alice", "ai-tokens", 0, 1)).action).toBe("stop");
    const v = await meterCheck(d, "alice", "ai-tokens", 1);
    expect(v).toMatchObject({ used: cap, remaining: 0, over: true, action: "stop", resetsAt: Date.UTC(2026, 10, 1) });
  });

  it("deps.resources overrides a resource's plan", async () => {
    const tiny: MeterResourceSpec<TierName> = {
      unit: "tokens",
      period: "day",
      plans: {
        free: { allowance: 10, over: "stop" },
        hobby: { allowance: 10, over: "stop" },
        maker: { allowance: 10, over: "stop" },
      },
    };
    const d = { ...(await deps()), resources: { "ai-tokens": tiny } };
    const v = await meterRecord(d, "alice", "ai-tokens", 11);
    expect(v).toMatchObject({ period: "2026-10-13", allowance: 10, action: "stop" });
    expect((await meterRecord(d, "alice", "egress", 1)).allowance).toBe(25 * GB);
  });
});
