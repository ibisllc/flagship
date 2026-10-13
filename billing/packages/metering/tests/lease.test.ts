import { describe, expect, it } from "vitest";
import {
  InMemoryMeterStore,
  meterLease,
  meterReport,
  type MeterCatalog,
  type MeterLeasePolicy,
  type MeterVerdict,
} from "../src/index.js";

const NOW = Date.UTC(2026, 9, 13, 15, 30);
const RESET = Date.UTC(2026, 10, 1);

const POLICY: MeterLeasePolicy = { fraction: 0.25, minGrant: 10, maxGrant: 1_000, ttlMs: 600_000, overTtlMs: 60_000 };

function verdict(used: number, allowance: number, policy: "allow" | "throttle" | "stop", resetsAt: number | null = RESET): MeterVerdict {
  const over = used > allowance;
  return {
    account: "ann",
    resource: "bandwidth",
    plan: "basic",
    period: "2026-10",
    used,
    allowance,
    remaining: Math.max(0, allowance - used),
    over,
    policy,
    action: over ? policy : "allow",
    resetsAt,
  };
}

describe("meterLease — sizing", () => {
  it("grants a fraction of what is left, capped at maxGrant", () => {
    expect(meterLease(verdict(0, 100_000, "throttle"), POLICY, NOW)).toEqual({
      account: "ann",
      resource: "bandwidth",
      action: "allow",
      grant: 1_000,
      policy: "throttle",
      ttlMs: 600_000,
    });
    expect(meterLease(verdict(0, 2_000, "throttle"), POLICY, NOW).grant).toBe(500);
  });

  it("never grants less than minGrant while that much is left, and never more than is left", () => {
    expect(meterLease(verdict(960, 1_000, "stop"), POLICY, NOW).grant).toBe(10);
    expect(meterLease(verdict(995, 1_000, "stop"), POLICY, NOW).grant).toBe(5);
  });

  it("at or past the allowance the lease carries the policy and no grant", () => {
    for (const used of [1_000, 1_500]) {
      expect(meterLease(verdict(used, 1_000, "throttle"), POLICY, NOW)).toMatchObject({
        action: "throttle",
        grant: 0,
        ttlMs: 60_000,
      });
    }
    expect(meterLease(verdict(1_000, 1_000, "stop"), POLICY, NOW).action).toBe("stop");
  });

  it("an allow-policy plan always gets maxGrant, even over", () => {
    expect(meterLease(verdict(5_000, 1_000, "allow"), POLICY, NOW)).toMatchObject({ action: "allow", grant: 1_000 });
  });

  it("never outlives the period", () => {
    expect(meterLease(verdict(0, 100_000, "throttle"), POLICY, RESET - 5_000).ttlMs).toBe(5_000);
    expect(meterLease(verdict(2_000, 1_000, "throttle"), POLICY, RESET - 5_000).ttlMs).toBe(5_000);
    expect(meterLease(verdict(0, 100_000, "throttle", null), POLICY, NOW).ttlMs).toBe(600_000);
  });

  it("rejects a nonsensical policy", () => {
    for (const bad of [{ fraction: 0 }, { fraction: 1.5 }, { minGrant: -1 }, { maxGrant: 5 }, { ttlMs: 0 }]) {
      expect(() => meterLease(verdict(0, 100, "throttle"), { ...POLICY, ...bad }, NOW)).toThrow(RangeError);
    }
  });
});

describe("meterLease — the overshoot bound", () => {
  const catalog: MeterCatalog<"bandwidth", "basic"> = {
    bandwidth: { unit: "bytes", period: "month", plans: { basic: { allowance: 1_000_000, over: "throttle" } } },
  };

  async function drive(edges: number) {
    const store = new InMemoryMeterStore();
    const deps = { catalog, store, planOf: async () => "basic" as const, now: () => NOW };
    const grants = new Array<number>(edges).fill(0);
    let served = 0;
    let n = 0;
    // Every edge serves its whole grant, then reports it and takes the next.
    for (let round = 0; round < 500; round++) {
      for (let e = 0; e < edges; e++) {
        served += grants[e]!;
        const r = await meterReport(deps, {
          batchId: `batch-${String(++n).padStart(12, "0")}`,
          items: [{ account: "ann", resource: "bandwidth", amount: grants[e]! }],
        });
        const lease = meterLease(r.verdicts[0]!, { ...POLICY, minGrant: 1_000, maxGrant: 100_000 }, NOW);
        grants[e] = lease.action === "allow" ? lease.grant : 0;
      }
      if (grants.every((g) => g === 0)) break;
    }
    return served;
  }

  it("one edge stops exactly at the allowance", async () => {
    expect(await drive(1)).toBe(1_000_000);
  });

  it("E edges overshoot by less than (E − 1) × maxGrant", async () => {
    const served = await drive(4);
    expect(served).toBeGreaterThanOrEqual(1_000_000);
    expect(served - 1_000_000).toBeLessThan(3 * 100_000);
  });
});
