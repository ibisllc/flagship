import { describe, expect, it } from "vitest";
import { InMemoryMeterStorage, InMemoryTierStorage, type TierName } from "@flagship/storage";
import {
  METER_RESOURCES,
  meterCheck,
  meterPeriodKey,
  meterRecord,
  meterResetsAt,
  type MeterDeps,
  type MeterResourceSpec,
} from "../src/meter.js";

const GB = 1024 * 1024 * 1024;
const NOW = Date.UTC(2026, 9, 13, 15, 30); // 2026-10-13

async function deps(tier?: TierName, currentPeriodEnd?: number): Promise<MeterDeps & { meter: InMemoryMeterStorage }> {
  const tiers = new InMemoryTierStorage();
  if (tier) await tiers.put({ username: "alice", tier, currentPeriodEnd, updatedAt: 1 });
  return { meter: new InMemoryMeterStorage(), tiers, now: () => NOW };
}

describe("meter — periods", () => {
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

describe("meter — resource table", () => {
  it("egress: free 25 GB then throttle; paid tiers bill", () => {
    const e = METER_RESOURCES.egress;
    expect(e.period).toBe("month");
    expect(e.tiers.free).toEqual({ allowance: 25 * GB, over: "throttle" });
    expect(e.tiers.hobby).toEqual({ allowance: 250 * GB, over: "bill" });
    expect(e.tiers.maker).toEqual({ allowance: 500 * GB, over: "bill" });
  });

  it("ai-tokens: monthly, and every tier stops issuing when over", () => {
    const t = METER_RESOURCES["ai-tokens"];
    expect(t.period).toBe("month");
    for (const tier of ["free", "hobby", "maker"] as const) expect(t.tiers[tier].over).toBe("stop");
  });
});

describe("meter — record and check", () => {
  it("accumulates per (account, resource, period) and lowercases the account", async () => {
    const d = await deps();
    await meterRecord(d, "Alice", "ai-tokens", 300);
    const v = await meterRecord(d, "alice", "ai-tokens", 200);
    expect(v).toMatchObject({ account: "alice", resource: "ai-tokens", period: "2026-10", used: 500, action: "allow" });
    expect((await meterCheck(d, "alice", "egress")).used).toBe(0);
    expect((await d.meter.get("alice", "ai-tokens", "2026-10"))?.amount).toBe(500);
  });

  it("check never records", async () => {
    const d = await deps();
    await meterCheck(d, "alice", "egress", 5);
    expect(await d.meter.get("alice", "egress", "2026-10")).toBeUndefined();
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
    expect(v).toMatchObject({ tier: "hobby", over: true, policy: "bill", action: "allow" });
  });

  it("a lapsed paid subscription meters as free", async () => {
    const d = await deps("maker", NOW - 1);
    expect((await meterRecord(d, "alice", "egress", 30 * GB)).action).toBe("throttle");
  });

  it("ai-tokens stop once nothing is left: check(need=1) at the allowance", async () => {
    const d = await deps();
    const cap = METER_RESOURCES["ai-tokens"].tiers.free.allowance;
    await meterRecord(d, "alice", "ai-tokens", cap - 1);
    expect((await meterCheck(d, "alice", "ai-tokens", 1)).action).toBe("allow");
    await meterRecord(d, "alice", "ai-tokens", 1);
    const v = await meterCheck(d, "alice", "ai-tokens", 1);
    expect(v).toMatchObject({ used: cap, remaining: 0, over: true, action: "stop", resetsAt: Date.UTC(2026, 10, 1) });
  });

  it("a new period starts from zero", async () => {
    const d = await deps();
    await meterRecord(d, "alice", "egress", 30 * GB);
    const next = { ...d, now: () => Date.UTC(2026, 10, 1) };
    expect(await meterCheck(next, "alice", "egress")).toMatchObject({ period: "2026-11", used: 0, action: "allow" });
  });

  it("deps.resources overrides a resource's plan", async () => {
    const tiny: MeterResourceSpec = {
      unit: "tokens",
      period: "day",
      tiers: {
        free: { allowance: 10, over: "stop" },
        hobby: { allowance: 10, over: "stop" },
        maker: { allowance: 10, over: "stop" },
      },
    };
    const d = { ...(await deps()), resources: { "ai-tokens": tiny } };
    const v = await meterRecord(d, "alice", "ai-tokens", 11);
    expect(v).toMatchObject({ period: "2026-10-13", allowance: 10, action: "stop" });
  });

  it("rejects a negative or non-finite amount", async () => {
    const d = await deps();
    await expect(meterRecord(d, "alice", "egress", -1)).rejects.toThrow(RangeError);
    await expect(meterRecord(d, "alice", "egress", Number.NaN)).rejects.toThrow(RangeError);
    await expect(meterCheck(d, "alice", "egress", Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
  });
});

describe("meter — record with need", () => {
  it("judges the new total plus need (\"may it consume any more?\")", async () => {
    const d = await deps();
    const cap = METER_RESOURCES["ai-tokens"].tiers.free.allowance;
    expect((await meterRecord(d, "alice", "ai-tokens", cap)).action).toBe("allow");
    expect((await meterRecord(d, "alice", "ai-tokens", 0, 1)).action).toBe("stop");
  });
});
