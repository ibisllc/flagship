import { describe, expect, it } from "vitest";
import type { TierName, TierSubscriptionRecord, UsageStorage, TierStorage } from "@flagship/storage";
import {
  recordEgress,
  quotaStatus,
  periodFor,
  quotaBytesForTier,
  MONTHLY_EGRESS_QUOTA_BYTES,
  OVERAGE_USD_PER_GB,
  handleUsageReport,
  handleUsageStatus,
  handleUserAllowance,
  allowanceViewFrom,
  type MeteringDeps,
} from "../src/metering.js";

const GB = 1024 * 1024 * 1024;
const NOW = Date.UTC(2026, 5, 14); // 2026-06-14 → period "2026-06"

function fakeUsage(): UsageStorage & { raw: Map<string, number> } {
  const m = new Map<string, number>();
  return {
    raw: m,
    async addEgress(u, p, bytes, _now) {
      const k = `${u}|${p}`;
      const next = (m.get(k) ?? 0) + Math.max(0, Math.floor(bytes));
      m.set(k, next);
      return next;
    },
    async get(u, p) {
      const k = `${u}|${p}`;
      return m.has(k) ? { username: u, period: p, bytesEgress: m.get(k)!, updatedAt: 1 } : undefined;
    },
  };
}

function fakeTiers(rec?: TierSubscriptionRecord): TierStorage {
  return { async get() { return rec; }, async put() {} };
}

function deps(rec?: TierSubscriptionRecord): MeteringDeps {
  return { usage: fakeUsage(), tiers: fakeTiers(rec), now: () => NOW };
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

  it("free = 50 GB, hobby = 250 GB, maker = 1 TB", () => {
    expect(quotaBytesForTier("free")).toBe(50 * GB);
    expect(quotaBytesForTier("hobby")).toBe(250 * GB);
    expect(quotaBytesForTier("maker")).toBe(1024 * GB);
    expect(MONTHLY_EGRESS_QUOTA_BYTES.free).toBe(50 * GB);
  });
});

describe("metering — recordEgress accumulates within the period", () => {
  it("adds deltas and tracks remaining", async () => {
    const d = deps(); // no tier record → free
    const a = await recordEgress(d, "alice", 10 * GB);
    expect(a.usedBytes).toBe(10 * GB);
    expect(a.remainingBytes).toBe(40 * GB);
    const b = await recordEgress(d, "alice", 15 * GB);
    expect(b.usedBytes).toBe(25 * GB);
    expect(b.overQuota).toBe(false);
    expect(b.admit).toBe(true);
  });

  it("lowercases the username key", async () => {
    const d = deps();
    await recordEgress(d, "Alice", 1 * GB);
    const s = await quotaStatus(d, "alice");
    expect(s.usedBytes).toBe(1 * GB);
  });
});

describe("metering — free tier is a HARD CAP", () => {
  it("over 50 GB ⇒ overQuota + admit=false + no overage billing", async () => {
    const d = deps(); // free
    const s = await recordEgress(d, "alice", 51 * GB);
    expect(s.tier).toBe("free");
    expect(s.overQuota).toBe(true);
    expect(s.admit).toBe(false); // relay stops carrying new public traffic
    expect(s.overageUsd).toBe(0); // free is capped, not billed
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

  it("a LAPSED paid sub falls back to free (hard cap)", async () => {
    const d = deps(tier("hobby", NOW - 24 * 3600 * 1000)); // ended yesterday
    const s = await recordEgress(d, "alice", 51 * GB);
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
      items: [{ username: "alice", bytes: 51 * GB }, { username: "bob", bytes: 1 * GB }],
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

describe("allowance view (#6/#7 dashboard + alert)", () => {
  it("classifies state by used fraction (ok <80% · approaching ≥80% · over >100%)", async () => {
    const ok = allowanceViewFrom("alice", await quotaStatus(deps(), "alice")); // 0 used
    expect(ok.state).toBe("ok");
    expect(ok.usedFraction).toBe(0);

    const approaching = await (async () => {
      const d = deps();
      await recordEgress(d, "alice", 40 * GB); // 80% of free 50 GB
      return allowanceViewFrom("alice", await quotaStatus(d, "alice"));
    })();
    expect(approaching.state).toBe("approaching");
    expect(approaching.usedFraction).toBeCloseTo(0.8, 5);

    const over = await (async () => {
      const d = deps();
      await recordEgress(d, "alice", 60 * GB); // over free 50 GB
      return allowanceViewFrom("alice", await quotaStatus(d, "alice"));
    })();
    expect(over.state).toBe("over");
    expect(over.usedFraction).toBe(1); // clamped
    expect(over.hardCapped).toBe(true); // free + over = hard cap
  });

  it("a paid tier over quota is 'over' but NOT hard-capped (bills overage)", async () => {
    const d = deps(tier("hobby", NOW + 30 * 24 * 3600 * 1000));
    await recordEgress(d, "alice", 300 * GB); // over hobby 250 GB
    const v = allowanceViewFrom("alice", await quotaStatus(d, "alice"));
    expect(v.state).toBe("over");
    expect(v.hardCapped).toBe(false);
    expect(v.overageUsd).toBeGreaterThan(0);
  });

  it("handleUserAllowance: 400 on a bad username, 200 with the dashboard body", async () => {
    const d = deps();
    expect((await handleUserAllowance(d, "no")).status).toBe(400);
    expect((await handleUserAllowance(d, "bad name!")).status).toBe(400);
    await recordEgress(d, "alice", 5 * GB);
    const res = await handleUserAllowance(d, "Alice"); // case-insensitive
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, username: "alice", tier: "free", usedBytes: 5 * GB, state: "ok" });
  });

  it("an unknown username reads as free / zero (no existence oracle)", async () => {
    const res = await handleUserAllowance(deps(), "nobody123");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tier: "free", usedBytes: 0, quotaBytes: 50 * GB, state: "ok" });
  });
});
