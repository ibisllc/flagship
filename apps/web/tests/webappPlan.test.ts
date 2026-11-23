// Settings → Plan in the webapp (lib/plan.js, views/plan.js) against `.com`'s real voucher handlers
// (control-plane blindVouchers.ts) behind a fake fetch: test vouchers, the sealed wallet's compare-and-set and
// merge, the trickle, the overage block, the Stripe shop (checkout, the return, the paid issue), and the section's
// text (round dollars, never units).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PAYMENTS_CONFIG,
  decapsulateOhttpRequest,
  decodeBhttpRequest,
  encapsulateOhttpResponse,
  encodeBhttpResponse,
  encodeOhttpKeyConfig,
  ohttpGatewayKey,
} from "@flagship/protocol";
import { InMemoryBlindVoucherStorage, InMemoryMeterStorage, InMemoryTierStorage, InMemoryVoucherPaymentStorage } from "@flagship/storage";
import {
  handlePaidIssue,
  handlePaymentsConfig,
  handleStripeVoucherCheckout,
  handleVoucherIssue,
  handleVoucherRedeem,
  railsSummary,
  voucherSigningKeysFromEnv,
  type VoucherRailsDeps,
} from "@flagship/control-plane";

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
  // A stand-in for Stripe's API behind `.com`'s real rail handlers: sessions keep the form's metadata; `paid` flips them.
  const stripe = { sessions: new Map<string, Record<string, unknown>>(), paid: true };
  const rails: VoucherRailsDeps = {
    keys,
    config: DEFAULT_PAYMENTS_CONFIG,
    payments: new InMemoryVoucherPaymentStorage(),
    now,
    stripe: {
      secretKey: "rk_test_webapp",
      livemode: false,
      successUrl: "https://webapp.flagshipserver.test/?shop=stripe&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://webapp.flagshipserver.test/?shop=cancel",
      taxBehavior: "inclusive",
      taxCode: "txcd_10000000",
      fetch: (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const form = new URLSearchParams(String(init.body));
          const id = `cs_test_${String(stripe.sessions.size).padStart(8, "0")}`;
          const units = Number(form.get("line_items[0][quantity]"));
          stripe.sessions.set(id, {
            id,
            livemode: false,
            mode: "payment",
            currency: "usd",
            amount_subtotal: units * 100,
            metadata: Object.fromEntries([...form.entries()].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
          });
          return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }));
        }
        const s = stripe.sessions.get(decodeURIComponent(url.split("/").pop()!));
        if (!s) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ ...s, status: stripe.paid ? "complete" : "open", payment_status: stripe.paid ? "paid" : "unpaid" }));
      }) as typeof fetch,
    },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const raw = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init?.body;
    const body = raw ? JSON.parse(String(raw)) : undefined;
    if (path === "/api/payments/config") {
      const r = handlePaymentsConfig({ config: DEFAULT_PAYMENTS_CONFIG, keys, testIssue: true, rails: railsSummary(rails), now });
      return json(r.status, r.body);
    }
    if (path === "/api/vouchers/stripe/checkout") {
      const r = await handleStripeVoucherCheckout(rails, body);
      return json(r.status, r.body);
    }
    if (path === "/api/vouchers/paid-issue") {
      const r = await handlePaidIssue(rails, body);
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
  return { fetch, readFetch, store, tiers, meter, wallet, calls, stripe, rails };
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

describe("webapp plan: the Stripe shop against .com's rail handlers", () => {
  it("buys a pack: a checkout that names nobody, the return, signatures for the paid session, vouchers in the wallet", async () => {
    const com = fakeCom(now);
    const d = deps(com);
    const { url, sessionId } = await P.buyWithStripe(30, d);
    expect(url).toBe(`https://checkout.stripe.com/c/pay/${sessionId}`);
    const order = com.calls.find((c) => c.path === "/api/vouchers/stripe/checkout")!;
    expect(order.init?.credentials).toBe("omit");
    expect(JSON.stringify(JSON.parse(String(order.init?.body)))).not.toContain(U);
    expect(P.pendingShopOrders(d.store)).toHaveLength(1);

    // Not paid yet: the order waits.
    com.stripe.paid = false;
    expect(await P.finishShopOrders(d)).toMatchObject({ added: 0, refused: [] });
    expect(P.pendingShopOrders(d.store)).toHaveLength(1);

    com.stripe.paid = true;
    const res = await P.finishShopOrders(d);
    expect(res.added).toBe(30);
    expect(res.wallet.wallet.vouchers).toHaveLength(30);
    expect(P.pendingShopOrders(d.store)).toHaveLength(0);
    const issue = com.calls.find((c) => c.path === "/api/vouchers/paid-issue")!;
    expect(issue.init?.credentials).toBe("omit");
    expect(Object.keys(issue.init?.headers as Record<string, string>)).toEqual(["content-type"]);
    // The wallet `.com` holds is sealed and has the 30 vouchers.
    const loaded = await P.loadWallet(DEFAULT_PAYMENTS_CONFIG, d);
    expect(loaded.wallet.vouchers).toHaveLength(30);
  });

  it("drops an order .com refuses for good and keeps another account's orders for that account", async () => {
    const com = fakeCom(now);
    const d = deps(com);
    await P.buyWithStripe(10, d);
    const orders = P.pendingShopOrders(d.store);
    d.store.set("flagship.shop.pending", JSON.stringify([{ ...orders[0], blinded: orders[0].blinded.slice(1) }, { ...orders[0], sessionId: "cs_test_other000", username: "someone-else" }]));
    const res = await P.finishShopOrders(d);
    expect(res).toMatchObject({ added: 0, refused: ["payment-invalid"] });
    expect(P.pendingShopOrders(d.store).map((o: { username: string }) => o.username)).toEqual(["someone-else"]);
  });

  it("notes the return from Stripe and tidies the address", () => {
    const session = new Map<string, string>();
    const ss = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) };
    let replaced = "";
    const hist = { replaceState: (_: unknown, __: string, u: string) => void (replaced = u) };
    expect(P.takeShopReturn({ href: "https://webapp.flagshipserver.com/?shop=stripe&session_id=cs_test_x#plan" }, hist, ss)).toBe("stripe");
    expect(replaced).toBe("/#plan");
    expect(P.consumeShopReturn(ss)).toBe("stripe");
    expect(P.consumeShopReturn(ss)).toBeNull();
    expect(P.takeShopReturn({ href: "https://webapp.flagshipserver.com/?wake=1" }, hist, ss)).toBeNull();
  });

  it("commits to the blinded set exactly as .com does", () => {
    expect(W.voucherOrderCommit("0123456789abcdef", ["AA==", "BB=="])).toBe("696591b0a66965fb43af0cfe2eb68de883fa1a6d1bc42cf739c68157830fb01d");
  });
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

  it("offers the card shop when Stripe is on, the test button only on the gym, and reads only on other devices", () => {
    const m = { config: cfg, wallet: wallet(0, null), planState: { plan: null, paidUntil: 0 }, admin: true, testIssue: true, now: t, rails: { stripe: true, apple: true, google: false } };
    const html = V.planViewHtml(m);
    for (const p of cfg.packs) expect(html).toContain(`data-buy="${p}" data-testid="plan-pack-${p}">Buy $${p}<`);
    expect(html).toContain("never which account they go to");
    expect(html).toContain("In the iPhone and Android apps");
    expect(V.planViewHtml({ ...m, rails: { stripe: false, apple: false, google: false } })).toContain("Card payments aren't available right now.");
    expect(V.planViewHtml({ ...m, pendingOrders: 1 })).toContain('data-testid="plan-shop-waiting"');
    expect(V.planViewHtml({ ...m, admin: false })).toContain('data-testid="plan-pack-30" disabled');
    expect(html).toContain('id="plan-add-test"');
    expect(V.planViewHtml({ ...m, testIssue: false })).not.toContain("plan-add-test");
    const ro = V.planViewHtml({ ...m, admin: false });
    expect(ro).toContain('data-testid="plan-read-only"');
    expect(ro).not.toContain("plan-add-test");
    expect(ro).toMatch(/id="plan-autopay"[^>]*disabled/);
  });

  it("shows the account's data usage from .com, 0 MB when nothing was sent, with no server needed", () => {
    const GiB = 1024 ** 3;
    expect(V.dataAmountText(0)).toBe("0 MB");
    expect(V.dataAmountText(512 * 1024 ** 2 + 900_000)).toBe("512 MB");
    expect(V.dataAmountText(25 * GiB)).toBe("25 GB");
    expect(V.dataAmountText(1.5 * GiB)).toBe("1.5 GB");
    const used = V.dataUsageHtml({ usedBytes: 0, quotaBytes: 25 * GiB, remainingBytes: 25 * GiB });
    expect(used).toContain('data-testid="plan-usage"');
    expect(used).toContain("Data usage");
    expect(used).toContain("0 MB of 25 GB used this month");
    expect(used).toContain('style="width:0%"');
    expect(V.dataUsageHtml(null)).toContain('data-testid="plan-usage-unavailable"');
    const html = V.planViewHtml({ config: cfg, wallet: wallet(0), planState: { plan: null, paidUntil: 0 }, admin: true, testIssue: false, now: t, allowance: { usedBytes: 2 * GiB, quotaBytes: 25 * GiB } });
    expect(html).toContain("2 GB of 25 GB used this month");
    expect(html.indexOf("plan-usage")).toBeLessThan(html.indexOf("plan-balance"));
  });

  it("warns before Pro ends only when a server says apps keep separate lists", () => {
    expect(V.listsWarningHtml(null)).toBe("");
    expect(V.listsWarningHtml("1 app has a separate access list on each server.")).toContain('id="plan-separate-lists-warning"');
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
  it("has a Settings row, a view, a precached module set and the v250 shell", () => {
    expect(read("index.html")).toContain('id="settings-tab-plan"');
    expect(read("index.html")).toContain('id="view-plan"');
    expect(read("app.js")).toContain('wire("settings-tab-plan", enterPlan)');
    expect(read("index.html")).not.toContain("settings-tab-tier");
    expect(read("index.html")).not.toContain("view-tier-status");
    expect(read("index.html")).toContain('id="plan-lists-warning"');
    const sw = read("service-worker.js");
    for (const f of ["/lib/vouchers.js", "/lib/plan.js", "/views/plan.js"]) expect(sw).toContain(`"${f}"`);
    expect(sw).toContain('SHELL_VERSION = "v251"');
  });
});

describe("webapp plan: spends through the private relay (docs/outbound-proxy.md \"Failure handling\")", () => {
  const gw = ohttpGatewayKey(9, new Uint8Array(32).fill(0x44));
  const ohttp = {
    v: 1,
    keyConfigHex: Buffer.from(encodeOhttpKeyConfig(gw)).toString("hex"),
    relays: [{ url: "https://relay.test/flagship", operator: "Test Relay Co", interim: false }],
  };
  function relayed(com: ReturnType<typeof fakeCom>, state: { relay: "up" | "down" }, log: string[]) {
    return async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://relay.test")) {
        if (state.relay === "down") throw new TypeError("Failed to fetch");
        log.push("relay");
        const g = decapsulateOhttpRequest([gw], init!.body as Uint8Array);
        const inner = decodeBhttpRequest(g.request);
        const res = await com.fetch(`https://${inner.authority}${inner.path}`, { method: inner.method, headers: Object.fromEntries(inner.headers), body: inner.body });
        const bh = encodeBhttpResponse({ status: res.status, headers: [["content-type", "application/json"]], body: new Uint8Array(await res.arrayBuffer()) });
        return new Response(encapsulateOhttpResponse(g.context, bh), { status: 200, headers: { "content-type": "message/ohttp-res" } });
      }
      if (new URL(url).pathname === "/api/vouchers/redeem") log.push(`direct#${(init?.headers as Record<string, string>)["x-flagship-relay-fallback"] ?? ""}`);
      return com.fetch(url, init);
    };
  }

  it("relay up, relay down (waits, plan safe), near the lapse goes direct, then back through the relay", async () => {
    const com = fakeCom(now);
    const state = { relay: "up" as "up" | "down" };
    const log: string[] = [];
    const d = deps(com, { fetch: relayed(com, state, log), ohttp });
    await P.addTestVouchers(30, d);
    await P.saveSettings(DEFAULT_PAYMENTS_CONFIG, { plan: "pro" }, d);
    expect((await P.spendTick({ ...d, interactive: true })).planSpent).toBe(1);
    expect(log).toEqual(["relay"]);
    expect(P.relayPrivacyLine(ohttp, P.relayStateOf(d), t).id).toBe("third-party");

    // The relay goes down while the plan is days ahead: nothing is spent, nothing breaks.
    state.relay = "down";
    t += 2 * DAY;
    const waiting = await P.spendTick(d);
    expect(waiting.planSpent).toBe(0);
    expect(waiting.waiting).toBe(true);
    expect(log.filter((x) => x.startsWith("direct"))).toEqual([]);
    expect(P.relayStateOf(d).failures).toBe(1);
    expect(P.relayPrivacyLine(ohttp, P.relayStateOf(d), t).id).toBe("waiting");
    expect((await com.tiers.get(U))?.tier).toBe("hobby");

    // Still down when the plan would lapse within a day (end + grace): the spend goes direct, marked.
    const end = (await com.tiers.get(U))!.currentPeriodEnd!;
    t = end + 72 * 3_600_000 - 12 * 3_600_000;
    const urgent = await P.spendTick(d);
    expect(urgent.planSpent).toBeGreaterThan(0);
    expect(log.at(-1)).toBe("direct#relay-unreachable");
    expect(P.relayPrivacyLine(ohttp, P.relayStateOf(d), t).id).toBe("went-direct");

    // The relay is back: spends go through it again and the line says so.
    state.relay = "up";
    t += 2 * DAY;
    await P.spendTick(d);
    expect(log.at(-1)).toBe("relay");
    expect(P.relayStateOf(d)).toEqual({ failures: 0, retryAt: 0, wentDirect: false });
  });

  it("an interactive start goes direct when the relay is down; no relay at all says so plainly", async () => {
    const com = fakeCom(now);
    const state = { relay: "down" as "up" | "down" };
    const log: string[] = [];
    const d = deps(com, { fetch: relayed(com, state, log), ohttp });
    await P.addTestVouchers(30, d);
    await P.saveSettings(DEFAULT_PAYMENTS_CONFIG, { plan: "pro" }, d);
    expect((await P.spendTick({ ...d, interactive: true })).planSpent).toBe(1);
    expect(log).toEqual(["direct#relay-unreachable"]);
    expect(P.relayPrivacyLine({ v: 1, keyConfigHex: null, relays: [] }, P.relayStateOf(d), t).id).toBe("none");
    expect(P.relayPrivacyLine({ ...ohttp, relays: [{ ...ohttp.relays[0], interim: true }] }, { failures: 0, retryAt: 0, wentDirect: false }, t).id).toBe("interim");
  });
});

describe("webapp: the voucher shop with no account and the voucher link (docs/anonymous-vouchers.md \"Voucher links\")", () => {
  const L = () => import("../public/webapp/lib/voucherLink.js");
  const anon = (com: ReturnType<typeof fakeCom>) => deps(com, { session: null, profile: null, isAdmin: () => false });
  const linksOf = async (vouchers: unknown[]) => (await L()).encodeVoucherLinks(vouchers, "flagshipserver.test");

  async function boughtSignedOut(units = 30) {
    const com = fakeCom(now);
    const d = anon(com);
    await P.buyVouchersSignedOut(units, d);
    const res = await P.finishSignedOutOrders(d);
    expect(res).toMatchObject({ ready: units, waiting: 0, refused: [] });
    return { com, d, vouchers: P.readyShopVouchers(d.store)[0].vouchers };
  }

  it("sells a pack signed out: nothing names an account, the vouchers wait in this browser as one app link", async () => {
    const com = fakeCom(now);
    const d = anon(com);
    com.stripe.paid = false;
    await P.buyVouchersSignedOut(30, d);
    expect(await P.finishSignedOutOrders(d)).toMatchObject({ ready: 0, waiting: 1 });
    expect(P.pendingShopOrders(d.store)).toHaveLength(0);
    com.stripe.paid = true;
    expect(await P.finishSignedOutOrders(d)).toMatchObject({ ready: 30 });
    expect(P.signedOutShopOrders(d.store)).toHaveLength(0);
    const ready = P.readyShopVouchers(d.store);
    expect(ready).toHaveLength(1);
    for (const c of com.calls) {
      expect(c.init?.credentials ?? "omit").toBe("omit");
      expect(String(c.init?.body ?? "")).not.toContain(U);
    }
    const links = await linksOf(ready[0].vouchers);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^https:\/\/flagshipserver\.test\/app\/vouchers#v=[A-Za-z0-9_-]+$/);
    // The vouchers ride only after "#": the part a browser sends to a server is the bare path.
    expect(new URL(links[0]).pathname + new URL(links[0]).search).toBe("/app/vouchers");
    // 120 vouchers are four links, each complete on its own.
    expect(await linksOf([...ready[0].vouchers, ...ready[0].vouchers, ...ready[0].vouchers, ...ready[0].vouchers].map((v, i) => ({ ...v, n: i.toString(16).padStart(64, "0") })))).toHaveLength(4);
    P.forgetReadyShopVouchers(ready[0].sessionId, d.store);
    expect(P.readyShopVouchers(d.store)).toHaveLength(0);
  });

  it("adds a link's vouchers to the wallet, checked here with no network call, and a second open adds nothing", async () => {
    const { com, vouchers } = await boughtSignedOut();
    const [link] = await linksOf(vouchers);
    const d = deps(com);
    await P.loadPaymentsConfig(d);
    expect(P.knownVoucherKeys(d)).toHaveLength(1);
    const current = await P.loadWallet(DEFAULT_PAYMENTS_CONFIG, d);
    const before = com.calls.length;
    const prep = await P.prepareVoucherLink(link, { ...d, current });
    expect(com.calls.length).toBe(before);
    expect(prep).toMatchObject({ outcome: "add", offline: false });
    expect(prep.plan.add).toHaveLength(30);
    const r = await P.commitVoucherLink(prep, d);
    expect(r).toMatchObject({ added: 30, parked: false });
    expect((await P.loadWallet(DEFAULT_PAYMENTS_CONFIG, d)).wallet.vouchers).toHaveLength(30);
    const again = await P.prepareVoucherLink(link, d);
    expect(again.outcome).toBe("already");
    expect(await P.commitVoucherLink(again, d)).toEqual({ added: 0, parked: false });
  });

  it("failure handling: a truncated link, a forged voucher, an already-spent voucher", async () => {
    const { com, vouchers } = await boughtSignedOut(10);
    const d = deps(com);
    await P.loadPaymentsConfig(d);
    const [link] = await linksOf(vouchers);
    expect((await P.prepareVoucherLink(link.slice(0, link.length - 50), d)).outcome).toBe("damaged");
    const forged = vouchers.map((v: { s: string }) => ({ ...v, s: (v.s[0] === "A" ? "B" : "A") + v.s.slice(1) }));
    expect((await P.prepareVoucherLink((await linksOf(forged))[0], d)).outcome).toBe("invalid");
    // Spent from this wallet: its nullifiers are in the wallet's spent list.
    await P.updateWallet(DEFAULT_PAYMENTS_CONFIG, (w: never) => W.markVouchersSpent(w, vouchers.map(W.voucherNullifier)), d);
    expect((await P.prepareVoucherLink(link, d)).outcome).toBe("spent");
  });

  it("failure handling: offline, the vouchers wait in this browser and join the wallet at the next tick", async () => {
    const { com, vouchers } = await boughtSignedOut(10);
    const d = deps(com);
    await P.loadPaymentsConfig(d);
    const [link] = await linksOf(vouchers);
    const offline = { ...d, readFetch: async () => Promise.reject(new TypeError("Failed to fetch")), fetch: async () => Promise.reject(new TypeError("Failed to fetch")) };
    const prep = await P.prepareVoucherLink(link, offline);
    expect(prep).toMatchObject({ outcome: "add", offline: true });
    expect(await P.commitVoucherLink(prep, offline)).toMatchObject({ added: 10, parked: true });
    expect(P.voucherInbox(d)).toHaveLength(10);
    // Opened twice while offline: the inbox already holds them.
    expect((await P.prepareVoucherLink(link, offline)).outcome).toBe("already");
    await expect(P.flushVoucherInbox(offline)).rejects.toBeTruthy();
    expect(P.voucherInbox(d)).toHaveLength(10);
    expect(await P.flushVoucherInbox(d)).toMatchObject({ added: 10 });
    expect(P.voucherInbox(d)).toHaveLength(0);
    expect((await P.loadWallet(DEFAULT_PAYMENTS_CONFIG, d)).wallet.vouchers).toHaveLength(10);
  });

  it("refuses on a device that isn't an admin, while locked, and without the issuer's key", async () => {
    const { com, vouchers } = await boughtSignedOut(10);
    const [link] = await linksOf(vouchers);
    expect((await P.prepareVoucherLink(link, deps(com, { isAdmin: () => false }))).outcome).toBe("not-admin");
    expect((await P.prepareVoucherLink(link, deps(com, { session: { username: U } }))).outcome).toBe("locked");
    expect((await P.prepareVoucherLink(link, deps(com))).outcome).toBe("unknown-key");
  });

  it("says one sentence for every outcome and asks before adding", async () => {
    const LV = await import("../public/webapp/views/voucher-link.js");
    for (const o of ["damaged", "not-a-link", "newer", "already", "spent", "invalid", "unknown-key", "full", "not-admin", "locked"]) {
      expect(LV.voucherLinkOutcomeText(o)).toMatch(/\.$/);
    }
    expect(LV.voucherLinkOutcomeText("add")).toBeNull();
    const html = LV.voucherLinkConfirmHtml({
      link: { part: 2, parts: 4 },
      plan: { add: new Array(30).fill({}), duplicate: 1, spent: 0, invalid: 2, unknownKey: 0 },
      offline: true,
    });
    expect(html).toContain("Add 30 vouchers ($30) to this account's wallet?");
    expect(html).toContain("This is link 2 of 4 from the same purchase.");
    expect(html).toContain("Already in this wallet: 1");
    expect(html).toContain("Not signed by Flagship, left out: 2");
    expect(html).not.toContain("Already spent");
    expect(html).toContain('data-testid="voucher-link-offline"');
  });

  it("with no card rail (production has no Stripe key) the signed-out shop sells nothing and says why", async () => {
    const S = await import("../public/webapp/views/voucher-shop.js");
    for (const rails of [{ stripe: false, apple: true, google: true }, undefined]) {
      const html = S.shopHtml({ config: DEFAULT_PAYMENTS_CONFIG, rails, keys: [] }, [], 0, "flagshipserver.test");
      expect(html).toContain("Card payments aren't available right now.");
      expect(html).not.toContain("data-buy=");
      expect(html).not.toContain("Pay by card with Stripe");
    }
  });

  it("the signed-out shop offers the app link, the file and a copy, and never a username", async () => {
    const { vouchers } = await boughtSignedOut(30);
    const S = await import("../public/webapp/views/voucher-shop.js");
    const pc = { config: DEFAULT_PAYMENTS_CONFIG, rails: { stripe: true }, keys: [] };
    const html = S.shopHtml(pc, [{ sessionId: "cs_test_x", vouchers }], 0, "flagshipserver.test");
    expect(html).toContain('href="https://flagshipserver.test/app/vouchers#v=');
    expect(html).toContain('data-testid="voucher-shop-download"');
    expect(html).toContain('data-testid="voucher-shop-copy"');
    expect(html).toContain("Your 30 vouchers ($30) are ready.");
    expect(html).not.toContain(U);
    const parts = S.readyPurchaseHtml({ sessionId: "cs_test_y", vouchers: [...vouchers, ...vouchers.map((v: { n: string }, i: number) => ({ ...v, n: i.toString(16).padStart(64, "f") }))] }, "flagshipserver.test");
    expect(parts).toContain("Load into Flagship (part 1 of 2)");
    expect(parts).toContain("Load into Flagship (part 2 of 2)");
  });
});
