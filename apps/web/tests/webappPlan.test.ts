// Settings → Plan in the webapp (lib/plan.js, views/plan.js) against `.com`'s real voucher handlers
// (control-plane blindVouchers.ts) behind a fake fetch: test vouchers, the sealed wallet's compare-and-set and
// merge, the trickle, the overage block, and the section's text (round dollars, never units; not on sale yet).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PAYMENTS_CONFIG } from "@flagship/protocol";
import { InMemoryBlindVoucherStorage, InMemoryMeterStorage, InMemoryTierStorage } from "@flagship/storage";
import { handlePaymentsConfig, handleVoucherIssue, handleVoucherRedeem, voucherSigningKeysFromEnv } from "@flagship/control-plane";

vi.mock("../public/webapp/lib/router.js", () => ({ $: () => null, registerView: () => {}, show: () => {} }));
vi.mock("../public/webapp/lib/toast.js", () => ({ toast: () => {} }));

const P = await import("../public/webapp/lib/plan.js");
const V = await import("../public/webapp/views/plan.js");
const W = await import("../public/webapp/lib/vouchers.js");

const root = join(import.meta.dirname, "..", "..", "..");
const keyFile = JSON.parse(readFileSync(join(root, "packages/protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8"));
const keys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk: keyFile.jwk }]));
const DAY = 86_400_000;
const GB = 1024 ** 3;
const U = "plucky-avocet";

function fakeCom(now: () => number, opts: { remainingBytes?: number } = {}) {
  const store = new InMemoryBlindVoucherStorage();
  const tiers = new InMemoryTierStorage();
  const meter = new InMemoryMeterStorage();
  const wallet: { version: number; blob: unknown | null } = { version: 0, blob: null };
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/api/payments/config") {
      const r = handlePaymentsConfig({ config: DEFAULT_PAYMENTS_CONFIG, keys, testIssue: true, now });
      return json(r.status, r.body);
    }
    if (path === "/api/vouchers/test-issue") {
      const r = handleVoucherIssue({ keys, config: DEFAULT_PAYMENTS_CONFIG, now }, body, 30);
      return json(r.status, r.body);
    }
    if (path === "/api/vouchers/redeem") {
      const r = await handleVoucherRedeem(
        { keys, config: DEFAULT_PAYMENTS_CONFIG, store, tiers, meter, now, usernames: { get: async (u: string) => (u === U ? ({ username: u } as never) : undefined) } },
        body,
      );
      return json(r.status, r.body);
    }
    if (path === `/api/accounts/${U}/voucher-wallet` && init?.method === "PUT") {
      if (!(init.headers as Record<string, string>)["x-flagship-signature"]) return json(403, { code: "forbidden" });
      if (body.version !== wallet.version + 1) return json(409, { code: "version-conflict", wallet: wallet.blob });
      wallet.version = body.version;
      wallet.blob = body;
      return json(200, { ok: true, version: body.version });
    }
    return json(404, { code: "not-found" });
  };
  const readFetch = async (url: string) => {
    const path = new URL(url).pathname;
    if (path === `/api/accounts/${U}/voucher-wallet`) return wallet.blob ? json(200, wallet.blob) : json(404, { code: "not-found" });
    if (path === `/api/users/${U}/plan-attestation`) {
      const t = await tiers.get(U);
      const paid = t && t.tier !== "free" && (t.currentPeriodEnd ?? 0) + 72 * 3_600_000 >= now();
      return json(200, { tier: paid ? t!.tier : "free", paidUntil: paid ? t!.currentPeriodEnd : 0 });
    }
    if (path === `/api/users/${U}/allowance`) return json(200, { remainingBytes: opts.remainingBytes ?? 200 * GB });
    return json(404, {});
  };
  return { fetch, readFetch, store, tiers, meter, wallet, calls };
}

let t = Date.UTC(2026, 10, 17, 12);
const now = () => t;
const umk = new Uint8Array(32).fill(7);
const deps = (com: ReturnType<typeof fakeCom>, extra: Record<string, unknown> = {}) => {
  const mem = new Map<string, string>();
  return {
    fetch: com.fetch,
    readFetch: com.readFetch,
    now,
    rand: () => 0.5,
    apex: "https://flagshipserver.test",
    session: { username: U, umk },
    profile: { accountId: U, deviceId: "ab".repeat(16) },
    deviceSeed: new Uint8Array(32).fill(9),
    isAdmin: () => true,
    store: { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) },
    ...extra,
  };
};

beforeEach(() => {
  t = Date.UTC(2026, 10, 17, 12);
});

describe("webapp plan: wallet, trickle and overage against .com's handlers", () => {
  it("adds test vouchers, sealed, and starts Pro at once with a catch-up spend", async () => {
    const com = fakeCom(now);
    const d = deps(com);
    const saved = await P.addTestVouchers(30, d);
    expect(saved.wallet.vouchers).toHaveLength(30);
    expect(com.wallet.version).toBe(1);
    expect(JSON.stringify(com.wallet.blob)).not.toContain(saved.wallet.vouchers[0]!.n);
    const cfg = DEFAULT_PAYMENTS_CONFIG;
    await P.saveSettings(cfg, { plan: "pro" }, d);
    const tick = await P.spendTick(d);
    expect(tick.planSpent).toBe(1);
    const tier = await com.tiers.get(U);
    expect(tier?.tier).toBe("hobby");
    expect(tier?.currentPeriodEnd).toBe(t + 3 * DAY);
    const back = await P.loadWallet(cfg, d);
    expect(back.wallet.vouchers).toHaveLength(29);
    expect(back.wallet.spent).toHaveLength(1);
    const redeemCall = com.calls.find((c) => c.path === "/api/vouchers/redeem")!;
    expect(redeemCall.init?.credentials).toBe("omit");
    expect(Object.keys((redeemCall.init?.headers ?? {}) as object)).toEqual(["content-type"]);
  });

  it("trickles one voucher when due and never spends past the high water", async () => {
    const com = fakeCom(now);
    const d = deps(com);
    await P.addTestVouchers(30, d);
    await P.saveSettings(DEFAULT_PAYMENTS_CONFIG, { plan: "pro" }, d);
    await P.spendTick(d);
    const first = (await P.spendTick(d)).planSpent;
    expect(first).toBe(0);
    t += 2 * DAY;
    expect((await P.spendTick(d)).planSpent).toBe(1);
    for (let i = 0; i < 20; i++) {
      t += DAY / 2;
      await P.spendTick(d);
    }
    const end = (await com.tiers.get(U))!.currentPeriodEnd!;
    expect(end - t).toBeLessThanOrEqual(10 * DAY + 3 * DAY);
  });

  it("with the random start, spends nothing before it", async () => {
    const com = fakeCom(now);
    const d = deps(com);
    await P.addTestVouchers(10, d);
    const s = await P.saveSettings(DEFAULT_PAYMENTS_CONFIG, { plan: "pro", delayStart: true }, d);
    expect(s.wallet.settings.startAt).toBe(t + 12 * 3_600_000);
    expect((await P.spendTick(d)).planSpent).toBe(0);
    t += 13 * 3_600_000;
    expect((await P.spendTick(d)).planSpent).toBe(1);
  });

  it("buys one overage block when the month runs low, within the cap", async () => {
    const com = fakeCom(now, { remainingBytes: 2 * GB });
    const d = deps(com);
    await P.addTestVouchers(30, d);
    await P.saveSettings(DEFAULT_PAYMENTS_CONFIG, { plan: "pro", overageCapUnits: 5 }, d);
    const a = await P.spendTick(d);
    expect(a.overageSpent).toBe(5);
    expect(a.wallet.wallet.overage.units).toBe(5);
    const b = await P.spendTick(d);
    expect(b.overageSpent).toBe(0);
  });

  it("merges when another device saved first, and drops vouchers .com says are spent", async () => {
    const com = fakeCom(now);
    const d = deps(com);
    await P.addTestVouchers(5, d);
    const stale = await P.loadWallet(DEFAULT_PAYMENTS_CONFIG, d);
    await P.addTestVouchers(5, d);
    const merged = await P.updateWallet(DEFAULT_PAYMENTS_CONFIG, (w: never) => w, { ...d, current: stale });
    expect(merged.wallet.vouchers).toHaveLength(10);
    const v = merged.wallet.vouchers.slice(0, 1);
    await P.redeemVouchers(U, "pro", v, d);
    await expect(P.redeemVouchers(U, "pro", v, d)).rejects.toMatchObject({ code: "voucher-spent" });
  });

  it("does nothing on a device that isn't an admin, or while locked", async () => {
    const com = fakeCom(now);
    expect(await P.spendTick(deps(com, { isAdmin: () => false }))).toEqual({ skipped: "not-admin" });
    expect(await P.spendTick(deps(com, { session: { username: U } }))).toEqual({ skipped: "locked" });
    await expect(P.addTestVouchers(1, deps(com, { session: { username: U } }))).rejects.toMatchObject({ code: "locked" });
  });
});

describe("webapp plan: the section", () => {
  const cfg = W.DEFAULT_PAYMENTS_CONFIG;
  const wallet = (n: number, plan: string | null = "pro") => ({ ...W.emptyVoucherWallet(10), vouchers: Array.from({ length: n }, () => ({})), settings: { ...W.emptyVoucherWallet(10).settings, plan } });

  it("shows round dollars and months, never units", () => {
    expect(V.balanceText(cfg, wallet(30))).toEqual({ amount: "$30", detail: "About 3 months of Pro" });
    expect(V.balanceText(cfg, wallet(20, "pro-max")).detail).toBe("About 1 month of Pro Max");
    expect(V.balanceText(cfg, wallet(0)).detail).toBe("No prepaid balance");
    const html = V.planViewHtml({ config: cfg, wallet: wallet(30), planState: { plan: "pro", paidUntil: t + 12 * DAY }, admin: true, testIssue: false, now: t });
    expect(html).not.toMatch(/units?\b/i);
    expect(html).toContain("Paid until");
    expect(html).toContain("(12 days left)");
    expect(html).toContain("$10 a month, 250 GB");
    expect(html).toContain("$20 a month, 500 GB");
  });

  it("offers the shop disabled, the test button only on the gym, and reads only on other devices", () => {
    const m = { config: cfg, wallet: wallet(0, null), planState: { plan: null, paidUntil: 0 }, admin: true, testIssue: true, now: t };
    const html = V.planViewHtml(m);
    expect(html).toContain("Not on sale yet.");
    for (const p of cfg.packs) expect(html).toMatch(new RegExp(`disabled data-testid="plan-pack-${p}"`));
    expect(html).toContain("In the iPhone and Android apps");
    expect(html).toContain('id="plan-add-test"');
    expect(V.planViewHtml({ ...m, testIssue: false })).not.toContain("plan-add-test");
    const ro = V.planViewHtml({ ...m, admin: false });
    expect(ro).toContain('data-testid="plan-read-only"');
    expect(ro).not.toContain("plan-add-test");
    expect(ro).toMatch(/id="plan-autopay"[^>]*disabled/);
  });

  it("caps overage in dollars and GB, off first", () => {
    const opts = V.overageCapOptions(cfg);
    expect(opts[0]).toEqual({ units: 0, label: "Off: slow down past the plan" });
    expect(opts[2]).toEqual({ units: 10, label: "Up to $10 a month (200 GB more)" });
    expect(opts.length).toBe(11);
  });
});

describe("webapp plan: wiring", () => {
  const read = (p: string) => readFileSync(join(root, "apps/web/public/webapp", p), "utf8");
  it("has a Settings row, a view, a precached module set and the v230 shell", () => {
    expect(read("index.html")).toContain('id="settings-tab-plan"');
    expect(read("index.html")).toContain('id="view-plan"');
    expect(read("app.js")).toContain('wire("settings-tab-plan", enterPlan)');
    const sw = read("service-worker.js");
    for (const f of ["/lib/vouchers.js", "/lib/plan.js", "/views/plan.js"]) expect(sw).toContain(`"${f}"`);
    expect(sw).toContain('SHELL_VERSION = "v230"');
  });
});
