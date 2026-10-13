import { describe, expect, it } from "vitest";
import { InMemoryMeterStorage, type TierName, type TierSubscriptionRecord, type TierStorage } from "@flagship/storage";
import {
  recordEgress,
  quotaStatus,
  periodFor,
  quotaBytesForTier,
  MONTHLY_EGRESS_QUOTA_BYTES,
  OVERAGE_USD_PER_GB,
  handleUsageReport,
  handleUsageStatus,
  EGRESS_LEASE_POLICY,
  MAX_USAGE_REPORT_ITEMS,
  type MeteringDeps,
  type UsageReportResult,
} from "../src/metering.js";

const GB = 1024 * 1024 * 1024;
const NOW = Date.UTC(2026, 5, 14); // 2026-06-14 → period "2026-06"

function fakeTiers(rec?: TierSubscriptionRecord): TierStorage {
  return { async get() { return rec; }, async put() {} };
}

function deps(rec?: TierSubscriptionRecord): MeteringDeps {
  return { meter: new InMemoryMeterStorage(), tiers: fakeTiers(rec), now: () => NOW };
}

function tier(t: TierName, currentPeriodEnd?: number): TierSubscriptionRecord {
  return { username: "alice", tier: t, currentPeriodEnd, updatedAt: 1 };
}

describe("metering — quota model", () => {
  it("periodFor is the UTC YYYY-MM month", () => {
    expect(periodFor(NOW)).toBe("2026-06");
    expect(periodFor(Date.UTC(2026, 0, 1))).toBe("2026-01");
    expect(periodFor(Date.UTC(2025, 11, 31, 23, 59))).toBe("2025-12");
  });

  it("free = 25 GB, hobby = 250 GB, maker = 500 GB", () => {
    expect(quotaBytesForTier("free")).toBe(25 * GB);
    expect(quotaBytesForTier("hobby")).toBe(250 * GB);
    expect(quotaBytesForTier("maker")).toBe(500 * GB);
    expect(MONTHLY_EGRESS_QUOTA_BYTES.free).toBe(25 * GB);
  });
});

describe("metering — recordEgress accumulates within the period", () => {
  it("adds deltas and tracks remaining", async () => {
    const d = deps(); // no tier record → free
    const free = MONTHLY_EGRESS_QUOTA_BYTES.free;
    const a = await recordEgress(d, "alice", 10 * GB);
    expect(a.usedBytes).toBe(10 * GB);
    expect(a.remainingBytes).toBe(free - 10 * GB);
    const b = await recordEgress(d, "alice", free - 11 * GB);
    expect(b.usedBytes).toBe(free - 1 * GB);
    expect(b.overQuota).toBe(false);
    expect(b.admit).toBe(true);
  });

  it("a negative delta records nothing", async () => {
    const d = deps();
    await recordEgress(d, "alice", 3 * GB);
    const s = await recordEgress(d, "alice", -1 * GB);
    expect(s.usedBytes).toBe(3 * GB);
  });

  it("counts as the core's \"egress\" resource", async () => {
    const d = deps();
    await recordEgress(d, "alice", 2 * GB);
    expect((await d.meter.get("alice", "egress", "2026-06"))?.amount).toBe(2 * GB);
  });

  it("lowercases the username key", async () => {
    const d = deps();
    await recordEgress(d, "Alice", 1 * GB);
    const s = await quotaStatus(d, "alice");
    expect(s.usedBytes).toBe(1 * GB);
  });
});

describe("metering — free tier over quota is throttled", () => {
  it("over 25 GB ⇒ overQuota + admit=false + no overage billing", async () => {
    const d = deps(); // free
    const s = await recordEgress(d, "alice", 26 * GB);
    expect(s.tier).toBe("free");
    expect(s.overQuota).toBe(true);
    expect(s.admit).toBe(false); // the relay slows the account to its speed limit
    expect(s.overageUsd).toBe(0); // free is throttled, not billed
    expect(s.remainingBytes).toBe(0);
  });
});

describe("metering — paid tier bills overage, never throttles", () => {
  it("hobby over 250 GB ⇒ admit=true + overageUsd at $0.05/GB", async () => {
    const d = deps(tier("hobby"));
    const s = await recordEgress(d, "alice", 260 * GB);
    expect(s.tier).toBe("hobby");
    expect(s.overQuota).toBe(true);
    expect(s.admit).toBe(true); // paid is never throttled
    expect(s.overageUsd).toBeCloseTo(10 * OVERAGE_USD_PER_GB, 6); // 10 GB over × $0.05
  });

  it("a LAPSED paid sub falls back to free (throttled over 25 GB)", async () => {
    const d = deps(tier("hobby", NOW - 24 * 3600 * 1000)); // ended yesterday
    const s = await recordEgress(d, "alice", 26 * GB);
    expect(s.tier).toBe("free");
    expect(s.admit).toBe(false);
  });
});

describe("metering — HTTP handlers (relay shared-secret auth)", () => {
  const SECRET = "s3cret";

  it("report: 401 on wrong secret, 503 when unconfigured, 200 on valid batch", async () => {
    const d = deps();
    expect((await handleUsageReport(d, "nope", SECRET, { items: [] })).status).toBe(401);
    expect((await handleUsageReport(d, SECRET, undefined, { items: [] })).status).toBe(503);

    const res = await handleUsageReport(d, SECRET, SECRET, {
      items: [{ username: "alice", bytes: 26 * GB }, { username: "bob", bytes: 1 * GB }],
    });
    expect(res.status).toBe(200);
    const body = res.body as { results: Array<{ username: string; admit: boolean }> };
    expect(body.results.find((r) => r.username === "alice")!.admit).toBe(false); // over free cap
    expect(body.results.find((r) => r.username === "bob")!.admit).toBe(true);
  });

  it("report: 400 on malformed items", async () => {
    const d = deps();
    expect((await handleUsageReport(d, SECRET, SECRET, {})).status).toBe(400);
    expect((await handleUsageReport(d, SECRET, SECRET, { items: [{ username: "a" }] })).status).toBe(400);
  });

  it("status: reads without recording, gated by the secret", async () => {
    const d = deps();
    await recordEgress(d, "alice", 5 * GB);
    expect((await handleUsageStatus(d, "bad", SECRET, "alice")).status).toBe(401);
    const res = await handleUsageStatus(d, SECRET, SECRET, "alice");
    expect(res.status).toBe(200);
    expect((res.body as { usedBytes: number }).usedBytes).toBe(5 * GB);
  });
});

describe("metering — idempotent batches and budget leases", () => {
  const SECRET = "s3cret";
  const ID = "0123456789abcdef0123456789abcdef";
  const MiB = 1024 * 1024;
  const results = (body: unknown) => (body as { results: UsageReportResult[] }).results;

  it("a retried batch id is counted once and answers duplicate:true with the same totals", async () => {
    const d = deps();
    const body = { batchId: ID, items: [{ username: "Alice", bytes: 2 * GB }] };
    const first = await handleUsageReport(d, SECRET, SECRET, body);
    const again = await handleUsageReport(d, SECRET, SECRET, body);
    expect((first.body as { duplicate: boolean }).duplicate).toBe(false);
    expect((again.body as { duplicate: boolean }).duplicate).toBe(true);
    expect(results(again.body)[0]!.usedBytes).toBe(2 * GB);
    expect((await quotaStatus(d, "alice")).usedBytes).toBe(2 * GB);
  });

  it("the pre-batch-id wire is still accepted (counted every time)", async () => {
    const d = deps();
    const body = { items: [{ username: "alice", bytes: 1 * GB }] };
    await handleUsageReport(d, SECRET, SECRET, body);
    const r = await handleUsageReport(d, SECRET, SECRET, body);
    expect(results(r.body)[0]!.usedBytes).toBe(2 * GB);
    expect(results(r.body)[0]!.admit).toBe(true);
  });

  it("refuses a malformed batch id and an oversized batch", async () => {
    const d = deps();
    for (const batchId of ["short", 7, `${ID}/x`]) {
      expect((await handleUsageReport(d, SECRET, SECRET, { batchId, items: [] })).status).toBe(400);
    }
    const items = Array.from({ length: MAX_USAGE_REPORT_ITEMS + 1 }, (_, i) => ({ username: `u${i}`, bytes: 1 }));
    expect((await handleUsageReport(d, SECRET, SECRET, { batchId: ID, items })).status).toBe(400);
  });

  it("free, far from the cap: a maxGrant lease to allow", async () => {
    const r = await handleUsageReport(deps(), SECRET, SECRET, { batchId: ID, items: [{ username: "alice", bytes: 1 * GB }] });
    expect(results(r.body)[0]!.lease).toEqual({
      action: "allow",
      grantBytes: EGRESS_LEASE_POLICY.maxGrant,
      policy: "throttle",
      ttlMs: EGRESS_LEASE_POLICY.ttlMs,
    });
  });

  it("free, near the cap: a quarter of what is left, never past it", async () => {
    const r = await handleUsageReport(deps(), SECRET, SECRET, {
      batchId: ID,
      items: [{ username: "alice", bytes: 25 * GB - 100 * MiB }],
    });
    expect(results(r.body)[0]!.lease).toMatchObject({ action: "allow", grantBytes: 25 * MiB });
  });

  it("free, at or over the cap: a throttle lease with no grant", async () => {
    for (const bytes of [25 * GB, 26 * GB]) {
      const r = await handleUsageReport(deps(), SECRET, SECRET, { batchId: ID, items: [{ username: "alice", bytes }] });
      expect(results(r.body)[0]!.lease).toEqual({
        action: "throttle",
        grantBytes: 0,
        policy: "throttle",
        ttlMs: EGRESS_LEASE_POLICY.overTtlMs,
      });
    }
  });

  it("paid, over its allowance: still allowed, billed, with a maxGrant lease", async () => {
    const r = await handleUsageReport(deps(tier("hobby")), SECRET, SECRET, {
      batchId: ID,
      items: [{ username: "alice", bytes: 300 * GB }],
    });
    expect(results(r.body)[0]!).toMatchObject({
      admit: true,
      lease: { action: "allow", grantBytes: EGRESS_LEASE_POLICY.maxGrant, policy: "allow" },
    });
  });

  it("a lease never outlives the month", async () => {
    const d = { ...deps(), now: () => Date.UTC(2026, 6, 1) - 5_000 };
    const r = await handleUsageReport(d, SECRET, SECRET, { batchId: ID, items: [{ username: "alice", bytes: 26 * GB }] });
    expect(results(r.body)[0]!.lease.ttlMs).toBe(5_000);
  });

  it("sums repeated usernames into one result", async () => {
    const r = await handleUsageReport(deps(), SECRET, SECRET, {
      batchId: ID,
      items: [{ username: "alice", bytes: 1 }, { username: "ALICE", bytes: 2 }],
    });
    expect(results(r.body)).toHaveLength(1);
    expect(results(r.body)[0]!.usedBytes).toBe(3);
  });
});
