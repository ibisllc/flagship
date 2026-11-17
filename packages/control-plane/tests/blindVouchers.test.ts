// Blind vouchers at .com (docs/payments-privacy-and-rails.md "As built"): issue, redeem into plan time and overage,
// double-spend refusal, the grace, plan switches, and the sealed wallet's compare-and-set.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENTS_CONFIG,
  finalizeVoucher,
  newVoucherRequest,
  planUnitMs,
  voucherNullifier,
  type Voucher,
} from "@flagship/protocol";
import { InMemoryBlindVoucherStorage, InMemoryMeterStorage, InMemoryTierStorage } from "@flagship/storage";
import {
  handlePaymentsConfig,
  handleVoucherIssue,
  handleVoucherRedeem,
  handleVoucherWalletPut,
  planEndAfterSpend,
  voucherSigningKeysFromEnv,
  type VoucherRedeemDeps,
} from "../src/blindVouchers.js";
import { isOhttpTargetAllowed } from "../src/ohttpGateway.js";

const here = dirname(fileURLToPath(import.meta.url));
const keyFile = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8"));
const keys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk: keyFile.jwk }]));
const key = keys[0]!.pub;
const cfg = DEFAULT_PAYMENTS_CONFIG;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17, 12);
const PRO = planUnitMs(cfg, "pro");
const MAX = planUnitMs(cfg, "pro-max");

function mint(n: number): Voucher[] {
  const reqs = Array.from({ length: n }, () => newVoucherRequest(key));
  const r = handleVoucherIssue({ keys, config: cfg }, { k: key.keyId, blinded: reqs.map((q) => q.blinded) });
  expect(r.status).toBe(200);
  const sigs = (r.body as { sigs: string[] }).sigs;
  return reqs.map((q, i) => finalizeVoucher(key, q.pending, sigs[i]!));
}

function deps(now = NOW): VoucherRedeemDeps & { store: InMemoryBlindVoucherStorage; tiers: InMemoryTierStorage } {
  return {
    keys,
    config: cfg,
    store: new InMemoryBlindVoucherStorage(),
    tiers: new InMemoryTierStorage(),
    usernames: { async get(u: string) { return u === "plucky-avocet" ? ({ username: u } as never) : undefined; } },
    meter: new InMemoryMeterStorage(),
    now: () => now,
  };
}

const redeem = (d: VoucherRedeemDeps, vouchers: Voucher[], what = "pro", username = "plucky-avocet") =>
  handleVoucherRedeem(d, { v: 1, username, for: what, vouchers });

describe("payments config and issuing", () => {
  it("publishes the numbers and the keys, not the private halves", () => {
    const r = handlePaymentsConfig({ config: cfg, keys, testIssue: false, now: () => NOW });
    const body = r.body as { config: unknown; keys: Array<Record<string, unknown>>; testIssue: boolean };
    expect(body.config).toEqual(cfg);
    expect(body.keys).toEqual([{ ...key, issueUntil: 0, acceptUntil: 0, issuing: true }]);
    expect(JSON.stringify(body)).not.toContain(keyFile.jwk.d);
  });

  it("refuses an unknown key, too many requests and a retired key", () => {
    expect(handleVoucherIssue({ keys, config: cfg }, { k: "0".repeat(16), blinded: ["AA=="] }).status).toBe(409);
    const many = Array.from({ length: 31 }, () => newVoucherRequest(key).blinded);
    expect(handleVoucherIssue({ keys, config: cfg }, { k: key.keyId, blinded: many }).status).toBe(400);
    expect(handleVoucherIssue({ keys, config: cfg }, { k: key.keyId, blinded: many.slice(0, 11) }, 10).status).toBe(400);
    const retired = [{ ...keys[0]!, issueUntil: NOW - 1 }];
    expect(handleVoucherIssue({ keys: retired, config: cfg, now: () => NOW }, { k: key.keyId, blinded: [many[0]] }).status).toBe(409);
  });
});

describe("redeeming", () => {
  it("buys one unit of plan time per voucher and refuses a second spend", async () => {
    const d = deps();
    const vs = mint(3);
    const r = await redeem(d, vs);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ credited: 3, spent: [], plan: "pro", paidUntil: NOW + 3 * PRO });
    expect((await d.tiers.get("plucky-avocet"))?.tier).toBe("hobby");
    const again = await redeem(d, vs);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "voucher-spent", spent: vs.map(voucherNullifier) });
    const mixed = await redeem(d, [...vs.slice(0, 1), ...mint(1)]);
    expect(mixed.body).toMatchObject({ credited: 1, spent: [voucherNullifier(vs[0]!)], paidUntil: NOW + 4 * PRO });
  });

  it("stores no account in the spent table", async () => {
    const d = deps();
    await redeem(d, mint(1));
    expect(JSON.stringify([...d.store.spent.values()])).not.toContain("plucky");
    expect([...d.store.spent.values()][0]).toEqual({ keyId: key.keyId, day: "2026-11-17" });
  });

  it("refuses forged, duplicated and malformed vouchers without spending", async () => {
    const d = deps();
    const [v] = mint(1);
    const forged = { ...v!, n: "ab".repeat(32) };
    expect((await redeem(d, [forged])).body).toMatchObject({ code: "bad-voucher" });
    expect((await redeem(d, [v!, v!])).status).toBe(400);
    expect((await redeem(d, [v!], "gold")).status).toBe(400);
    expect((await redeem(d, [v!], "pro", "nobody")).status).toBe(404);
    expect(d.store.spent.size).toBe(0);
  });

  it("continues from the old end inside the grace, from now after it", async () => {
    const d = deps();
    await d.tiers.put({ username: "plucky-avocet", tier: "hobby", currentPeriodEnd: NOW - DAY, updatedAt: 1 });
    expect((await redeem(d, mint(1))).body).toMatchObject({ paidUntil: NOW - DAY + PRO });
    const e = deps();
    await e.tiers.put({ username: "plucky-avocet", tier: "hobby", currentPeriodEnd: NOW - 4 * DAY, updatedAt: 1 });
    expect((await redeem(e, mint(1))).body).toMatchObject({ paidUntil: NOW + PRO });
  });

  it("converts the time left on a plan switch", async () => {
    const d = deps();
    await d.tiers.put({ username: "plucky-avocet", tier: "hobby", currentPeriodEnd: NOW + 6 * DAY, updatedAt: 1 });
    expect((await redeem(d, mint(1), "pro-max")).body).toMatchObject({ plan: "pro-max", paidUntil: NOW + 3 * DAY + MAX });
    expect((await d.tiers.get("plucky-avocet"))?.tier).toBe("maker");
    expect(planEndAfterSpend(cfg, { plan: "pro-max", paidUntil: NOW + 3 * DAY }, "pro", 0, NOW)).toBe(NOW + 6 * DAY);
  });

  it("refuses to pay more than the lead allows, spending nothing", async () => {
    const d = deps();
    await d.tiers.put({ username: "plucky-avocet", tier: "hobby", currentPeriodEnd: NOW + 36 * DAY, updatedAt: 1 });
    const r = await redeem(d, mint(1));
    expect(r.body).toMatchObject({ code: "plan-paid-ahead" });
    expect(d.store.spent.size).toBe(0);
  });

  it("buys an overage block only on a paid plan, all or nothing", async () => {
    const d = deps();
    expect((await redeem(d, mint(5), "overage")).body).toMatchObject({ code: "overage-needs-plan" });
    await d.tiers.put({ username: "plucky-avocet", tier: "hobby", currentPeriodEnd: NOW + 10 * DAY, updatedAt: 1 });
    expect((await redeem(d, mint(4), "overage")).body).toMatchObject({ code: "overage-block-size" });
    const block = mint(5);
    const ok = await redeem(d, block, "overage");
    expect(ok.body).toMatchObject({ credited: 5, topUpBytes: 100 * 1024 ** 3 });
    const partial = await redeem(d, [block[0]!, ...mint(4)], "overage");
    expect(partial.body).toMatchObject({ code: "voucher-spent" });
    expect(d.store.spent.size).toBe(5);
  });

  it("is a request the OHTTP relay may carry", () => {
    expect(isOhttpTargetAllowed("POST", "flagshipserver.com", "/api/vouchers/redeem", "flagshipserver.com", "boot.flagshipserver.com")).toBe(true);
    expect(isOhttpTargetAllowed("POST", "flagshipserver.com", "/api/vouchers/test-issue", "flagshipserver.com", "boot.flagshipserver.com")).toBe(false);
  });
});

describe("the sealed wallet", () => {
  it("refuses an unsigned write and a malformed body", async () => {
    const store = new InMemoryBlindVoucherStorage();
    const directory = { identities: { get: async () => null } as never, nonces: { claim: async () => true } as never };
    const body = JSON.stringify({ version: 1, nonce: "00".repeat(12), ct: "AAAA" });
    expect((await handleVoucherWalletPut({ store, directory }, "plucky-avocet", undefined, body)).status).toBe(403);
    expect((await handleVoucherWalletPut({ store, directory }, "plucky-avocet", undefined, "x".repeat(1024 * 1024 + 1))).status).toBe(413);
  });

  it("compare-and-sets on the version", async () => {
    const store = new InMemoryBlindVoucherStorage();
    expect(await store.putWallet("a", 1, "x", 0)).toBe(true);
    expect(await store.putWallet("a", 1, "y", 0)).toBe(false);
    expect(await store.putWallet("a", 2, "y", 0)).toBe(true);
    expect((await store.getWallet("a"))?.blob).toBe("y");
  });
});
