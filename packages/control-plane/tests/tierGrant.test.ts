import { describe, expect, it } from "vitest";
import type { TierStorage, TierSubscriptionRecord } from "@flagship/storage";
import {
  grantTier,
  handleAdminTierGrant,
  GRANTABLE_TIERS,
  MAX_GRANT_DAYS,
  type TierGrantDeps,
} from "../src/tierGrant.js";

const NOW = Date.UTC(2026, 5, 14);
const DAY = 24 * 60 * 60 * 1000;

function fakeTiers(seed?: TierSubscriptionRecord): TierStorage & { rec?: TierSubscriptionRecord } {
  let rec = seed;
  return {
    async get() {
      return rec;
    },
    async put(r) {
      rec = r;
    },
    get rec() {
      return rec;
    },
  } as TierStorage & { rec?: TierSubscriptionRecord };
}

function deps(seed?: TierSubscriptionRecord): TierGrantDeps & { tiers: ReturnType<typeof fakeTiers> } {
  return { tiers: fakeTiers(seed), now: () => NOW };
}

describe("grantTier — happy path", () => {
  it("grants a paid tier for N days from now and writes the record", async () => {
    const d = deps();
    const res = await grantTier(d, { username: "alice", tier: "hobby", durationDays: 30 });
    expect(res.tier).toBe("hobby");
    expect(res.currentPeriodEnd).toBe(NOW + 30 * DAY);
    expect(d.tiers.rec).toMatchObject({ username: "alice", tier: "hobby", currentPeriodEnd: NOW + 30 * DAY });
  });

  it("lowercases/normalizes the username", async () => {
    const d = deps();
    const res = await grantTier(d, { username: "  Alice  ", tier: "maker", durationDays: 7 });
    expect(res.username).toBe("alice");
  });
});

describe("grantTier — Stripe paths (#11)", () => {
  it("absolutePeriodEnd sets the period exactly (ignores durationDays/extend)", async () => {
    const future = NOW + 10 * DAY;
    const d = deps({ username: "alice", tier: "hobby", currentPeriodEnd: future, updatedAt: NOW - DAY });
    const end = NOW + 27 * DAY;
    const res = await grantTier(d, { username: "alice", tier: "hobby", durationDays: 99, absolutePeriodEnd: end });
    expect(res.currentPeriodEnd).toBe(end); // pinned, NOT extended from `future`
  });

  it("rejects an absolutePeriodEnd in the past or absurdly far out", async () => {
    await expect(
      grantTier(deps(), { username: "alice", tier: "hobby", durationDays: 0, absolutePeriodEnd: NOW - DAY }),
    ).rejects.toThrow(/absolutePeriodEnd/);
    await expect(
      grantTier(deps(), { username: "alice", tier: "hobby", durationDays: 0, absolutePeriodEnd: NOW + (MAX_GRANT_DAYS + 5) * DAY }),
    ).rejects.toThrow(/absolutePeriodEnd/);
  });

  it("persists Stripe ids on a paid grant and drops them on downgrade to free", async () => {
    const d = deps();
    await grantTier(d, {
      username: "alice",
      tier: "hobby",
      durationDays: 31,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });
    expect(d.tiers.rec).toMatchObject({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
    await grantTier(d, { username: "alice", tier: "free", durationDays: 0 });
    expect(d.tiers.rec!.stripeCustomerId).toBeUndefined();
    expect(d.tiers.rec!.stripeSubscriptionId).toBeUndefined();
  });
});

describe("grantTier — extend vs reset", () => {
  it("re-granting the SAME active tier EXTENDS from the existing period end", async () => {
    const future = NOW + 10 * DAY;
    const d = deps({ username: "alice", tier: "hobby", currentPeriodEnd: future, updatedAt: NOW - DAY });
    const res = await grantTier(d, { username: "alice", tier: "hobby", durationDays: 30 });
    expect(res.currentPeriodEnd).toBe(future + 30 * DAY); // added, not truncated
  });

  it("granting a DIFFERENT tier resets the period from now", async () => {
    const future = NOW + 10 * DAY;
    const d = deps({ username: "alice", tier: "hobby", currentPeriodEnd: future, updatedAt: NOW - DAY });
    const res = await grantTier(d, { username: "alice", tier: "maker", durationDays: 30 });
    expect(res.currentPeriodEnd).toBe(NOW + 30 * DAY); // from now, not the old hobby end
  });

  it("an EXPIRED same-tier period restarts from now (no negative carry)", async () => {
    const past = NOW - 5 * DAY;
    const d = deps({ username: "alice", tier: "hobby", currentPeriodEnd: past, updatedAt: NOW - 40 * DAY });
    const res = await grantTier(d, { username: "alice", tier: "hobby", durationDays: 30 });
    expect(res.currentPeriodEnd).toBe(NOW + 30 * DAY);
  });
});

describe("grantTier — downgrade to free", () => {
  it("clears the paid period (refund/downgrade)", async () => {
    const d = deps({ username: "alice", tier: "maker", currentPeriodEnd: NOW + 100 * DAY, updatedAt: NOW });
    const res = await grantTier(d, { username: "alice", tier: "free", durationDays: 0 });
    expect(res.tier).toBe("free");
    expect(res.currentPeriodEnd).toBeUndefined();
    expect(d.tiers.rec).toMatchObject({ tier: "free", currentPeriodEnd: undefined });
  });
});

describe("grantTier — validation", () => {
  it("rejects a bad username", async () => {
    await expect(grantTier(deps(), { username: "a b!", tier: "hobby", durationDays: 30 })).rejects.toThrow(/username/i);
  });
  it("rejects an unknown tier", async () => {
    await expect(grantTier(deps(), { username: "alice", tier: "platinum" as never, durationDays: 30 })).rejects.toThrow(/tier/i);
  });
  it("rejects non-positive / over-ceiling durations for a paid tier", async () => {
    await expect(grantTier(deps(), { username: "alice", tier: "hobby", durationDays: 0 })).rejects.toThrow(/durationDays/);
    await expect(grantTier(deps(), { username: "alice", tier: "hobby", durationDays: MAX_GRANT_DAYS + 1 })).rejects.toThrow(/durationDays/);
  });
  it("GRANTABLE_TIERS is the closed set free/hobby/maker", () => {
    expect([...GRANTABLE_TIERS].sort()).toEqual(["free", "hobby", "maker"]);
  });
});

describe("handleAdminTierGrant — HTTP shape", () => {
  it("400 on missing fields", async () => {
    expect((await handleAdminTierGrant(deps(), {})).status).toBe(400);
    expect((await handleAdminTierGrant(deps(), { username: "alice" })).status).toBe(400);
  });
  it("200 + the granted record on success", async () => {
    const res = await handleAdminTierGrant(deps(), { username: "alice", tier: "hobby", durationDays: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, username: "alice", tier: "hobby", currentPeriodEnd: NOW + 30 * DAY });
  });
  it("400 (not a throw) on an invalid grant", async () => {
    const res = await handleAdminTierGrant(deps(), { username: "alice", tier: "nope", durationDays: 30 });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/tier/i);
  });
});
