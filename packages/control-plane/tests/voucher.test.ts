import { describe, expect, it } from "vitest";
import type { TierStorage, TierSubscriptionRecord, VoucherStorage, VoucherRecord } from "@flagship/storage";
import {
  issueVoucher,
  redeemVoucher,
  handleRedeemVoucher,
  handleIssueVoucher,
  mintVoucherCode,
  normalizeVoucherCode,
  type VoucherDeps,
} from "../src/voucher.js";

const NOW = Date.UTC(2026, 5, 14);
const DAY = 24 * 60 * 60 * 1000;

function fakeVouchers(): VoucherStorage & { map: Map<string, VoucherRecord> } {
  const map = new Map<string, VoucherRecord>();
  return {
    map,
    async create(rec) {
      if (map.has(rec.codeHash)) return { ok: false as const, reason: "exists" };
      map.set(rec.codeHash, { ...rec });
      return { ok: true as const };
    },
    async get(h) {
      const v = map.get(h);
      return v ? { ...v } : undefined;
    },
    async redeem(h, username, now) {
      const v = map.get(h);
      if (!v || v.redeemedAt !== undefined) return false;
      v.redeemedAt = now;
      v.redeemedBy = username;
      return true;
    },
  };
}

function fakeTiers(): TierStorage & { rec?: TierSubscriptionRecord } {
  let rec: TierSubscriptionRecord | undefined;
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

function deps(): VoucherDeps & { vouchers: ReturnType<typeof fakeVouchers>; tiers: ReturnType<typeof fakeTiers> } {
  return { vouchers: fakeVouchers(), tiers: fakeTiers(), now: () => NOW };
}

describe("voucher codes", () => {
  it("mints a grouped high-entropy code with the FLAG- prefix", () => {
    const c = mintVoucherCode();
    expect(c).toMatch(/^FLAG-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(mintVoucherCode()).not.toBe(mintVoucherCode()); // random
  });
  it("normalizes to uppercase alphanumerics (dashes/case-insensitive)", () => {
    expect(normalizeVoucherCode("flag-abc12-de34f")).toBe("FLAGABC12DE34F");
    expect(normalizeVoucherCode("FLAG ABC")).toBe("FLAGABC");
  });
});

describe("issueVoucher", () => {
  it("mints + stores a hash and returns the code once", async () => {
    const d = deps();
    const r = await issueVoucher(d, { tier: "hobby", durationDays: 30 });
    expect(r.code).toMatch(/^FLAG-/);
    expect(r.tier).toBe("hobby");
    expect(d.vouchers.map.size).toBe(1);
    // We stored a HASH, never the plaintext.
    const stored = [...d.vouchers.map.keys()][0]!;
    expect(stored).not.toContain(r.code.replace(/-/g, ""));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects a free tier or a bad duration", async () => {
    await expect(issueVoucher(deps(), { tier: "free", durationDays: 30 })).rejects.toThrow(/paid tier/);
    await expect(issueVoucher(deps(), { tier: "hobby", durationDays: 0 })).rejects.toThrow(/durationDays/);
  });
});

describe("redeemVoucher — end to end", () => {
  it("redeems a freshly issued code and grants the tier", async () => {
    const d = deps();
    const { code } = await issueVoucher(d, { tier: "hobby", durationDays: 30 });
    const res = await redeemVoucher(d, { code, username: "alice" });
    expect(res.tier).toBe("hobby");
    expect(res.currentPeriodEnd).toBe(NOW + 30 * DAY);
    expect(d.tiers.rec).toMatchObject({ username: "alice", tier: "hobby" });
  });

  it("redeem accepts the code with different case/dashes", async () => {
    const d = deps();
    const { code } = await issueVoucher(d, { tier: "maker", durationDays: 7 });
    const messy = code.toLowerCase().replace(/-/g, " ");
    const res = await redeemVoucher(d, { code: messy, username: "bob" });
    expect(res.tier).toBe("maker");
  });

  it("a second redemption of the same code fails (single-use)", async () => {
    const d = deps();
    const { code } = await issueVoucher(d, { tier: "hobby", durationDays: 30 });
    await redeemVoucher(d, { code, username: "alice" });
    await expect(redeemVoucher(d, { code, username: "eve" })).rejects.toThrow(/already redeemed/);
  });

  it("an invalid code fails", async () => {
    await expect(redeemVoucher(deps(), { code: "FLAG-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", username: "alice" })).rejects.toThrow(/invalid voucher/);
  });

  it("a bad username fails BEFORE consuming the code (code stays redeemable)", async () => {
    const d = deps();
    const { code } = await issueVoucher(d, { tier: "hobby", durationDays: 30 });
    await expect(redeemVoucher(d, { code, username: "bad name!" })).rejects.toThrow(/username/);
    // The code was NOT burned — a valid redeem still works.
    const res = await redeemVoucher(d, { code, username: "alice" });
    expect(res.tier).toBe("hobby");
  });
});

describe("voucher HTTP handlers", () => {
  it("redeem: 400 on missing fields, 200 on success", async () => {
    const d = deps();
    expect((await handleRedeemVoucher(d, {})).status).toBe(400);
    const { code } = await issueVoucher(d, { tier: "hobby", durationDays: 30 });
    const res = await handleRedeemVoucher(d, { code, username: "alice" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tier: "hobby" });
  });
  it("issue: 400 on missing fields, 200 returns a code", async () => {
    const d = deps();
    expect((await handleIssueVoucher(d, { tier: "hobby" })).status).toBe(400);
    const res = await handleIssueVoucher(d, { tier: "hobby", durationDays: 90 });
    expect(res.status).toBe(200);
    expect((res.body as { code: string }).code).toMatch(/^FLAG-/);
  });
});
