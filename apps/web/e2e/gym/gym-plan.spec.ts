/**
 * Settings → Plan on the webapp with a mocked `.com` (docs/payments-privacy-and-rails.md "As built"): the gym's
 * test vouchers are signed by the real issuer code with the vectors' test key, the wallet is kept sealed by the
 * mock exactly as `.com` keeps it (ciphertext only), and choosing Pro spends one voucher with nothing that names
 * the caller. The shop sells packs by card through Stripe Checkout (§11): `.com`'s real rail handlers behind the mock,
 * Stripe's API faked in the test, Stripe's page answered with 204 so the app stays put, then the return.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_PAYMENTS_CONFIG } from "@flagship/protocol";
import { InMemoryVoucherPaymentStorage } from "@flagship/storage";
import {
  handlePaidIssue,
  handlePaymentsConfig,
  handleStripeVoucherCheckout,
  handleVoucherIssue,
  railsSummary,
  voucherSigningKeysFromEnv,
  type VoucherRailsDeps,
} from "@flagship/control-plane";
import { freshUnlock, HOME, livePod, mock, reachHome, sawToast, shot, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const keyFile = JSON.parse(readFileSync(join(root, "packages/protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8"));
const keys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk: keyFile.jwk }]));

/** `.com`'s voucher routes: the config (gym test issue on), the issuer, a compare-and-set wallet, and redeem. */
function payments(m: Mock, opts: { stripe?: boolean } = {}): { wallet: { version: number; blob: unknown }; paidUntil: () => number } {
  const wallet: { version: number; blob: unknown } = { version: 0, blob: null };
  let until = 0;
  // Stripe's API, faked: a session keeps the form's metadata and reads back paid.
  const sessions = new Map<string, Record<string, unknown>>();
  const rails: VoucherRailsDeps = {
    keys,
    config: DEFAULT_PAYMENTS_CONFIG,
    payments: new InMemoryVoucherPaymentStorage(),
    ...(opts.stripe
      ? {
          stripe: {
            secretKey: "rk_test_gym",
            livemode: false,
            successUrl: "https://webapp.gym.flagshipserver.com/?shop=stripe&session_id={CHECKOUT_SESSION_ID}",
            cancelUrl: "https://webapp.gym.flagshipserver.com/?shop=cancel",
            taxBehavior: "inclusive" as const,
            taxCode: "txcd_10000000",
            fetch: (async (url: string, init?: RequestInit) => {
              if (init?.method === "POST") {
                const form = new URLSearchParams(String(init.body));
                const id = `cs_test_gym${String(sessions.size).padStart(6, "0")}`;
                sessions.set(id, {
                  id,
                  livemode: false,
                  mode: "payment",
                  status: "complete",
                  payment_status: "paid",
                  currency: "usd",
                  amount_subtotal: Number(form.get("line_items[0][quantity]")) * 100,
                  metadata: Object.fromEntries([...form.entries()].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
                });
                return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }));
              }
              const sess = sessions.get(decodeURIComponent(url.split("/").pop()!));
              return sess ? new Response(JSON.stringify(sess)) : new Response("{}", { status: 404 });
            }) as typeof fetch,
          },
        }
      : {}),
  };
  m.get("/api/payments/config", () => {
    const r = handlePaymentsConfig({ config: DEFAULT_PAYMENTS_CONFIG, keys, testIssue: true, rails: railsSummary(rails) });
    return { status: r.status, json: r.body };
  });
  m.post("/api/vouchers/stripe/checkout", async (c) => {
    const r = await handleStripeVoucherCheckout(rails, c.body);
    return { status: r.status, json: r.body };
  });
  m.post("/api/vouchers/paid-issue", async (c) => {
    const r = await handlePaidIssue(rails, c.body);
    return { status: r.status, json: r.body };
  });
  m.post("/api/vouchers/test-issue", (c) => {
    const r = handleVoucherIssue({ keys, config: DEFAULT_PAYMENTS_CONFIG }, c.body, 30);
    return { status: r.status, json: r.body };
  });
  m.on("PUT", "/api/accounts/smoketest/voucher-wallet", (c) => {
    const b = c.body as { version: number };
    if (b.version !== wallet.version + 1) return { status: 409, json: { code: "version-conflict", wallet: wallet.blob } };
    wallet.version = b.version;
    wallet.blob = b;
    return { json: { ok: true, version: b.version } };
  });
  m.get("/api/accounts/smoketest/voucher-wallet", () => (wallet.blob ? { json: wallet.blob } : { status: 404, json: { code: "not-found" } }));
  m.get("/api/users/smoketest/plan-attestation", () => ({ json: { tier: until > Date.now() ? "hobby" : "free", paidUntil: until } }));
  m.get("/api/users/smoketest/allowance", { remainingBytes: 200 * 1024 ** 3 });
  m.post("/api/vouchers/redeem", (c) => {
    const b = c.body as { vouchers: unknown[] };
    until = Math.max(until, Date.now()) + b.vouchers.length * 3 * 86_400_000;
    return { json: { ok: true, for: "pro", credited: b.vouchers.length, spent: [], plan: "pro", paidUntil: until } };
  });
  return { wallet, paidUntil: () => until };
}

async function openPlan(page: Page): Promise<void> {
  await page.click('[data-tab-target="settings"]');
  await expect(page.locator("#view-settings-tab")).toBeVisible();
  await page.click("#settings-tab-plan");
  await expect(page.locator("#view-plan")).toBeVisible();
}

test.describe("gym webapp plan", () => {
  test("gym plan test vouchers fill the balance and choosing Pro spends one, unlinked", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    const pay = payments(m);
    await openPlan(page);
    await expect(page.locator("#plan-current-name")).toHaveText("Free");
    await expect(page.locator("#plan-balance-amount")).toHaveText("$0");
    await expect(page.locator("[data-testid=plan-shop]")).toContainText("Card payments aren't available right now.");
    await expect(page.locator("[data-testid=plan-pack-30]")).toHaveCount(0);
    await shot(page, testInfo, "plan-empty");

    await page.click("#plan-add-test");
    await sawToast(page, "Added 30 test vouchers.");
    await expect(page.locator("#plan-balance-amount")).toHaveText("$30");
    await expect(page.locator("#plan-balance-detail")).toHaveText("About 3 months of Pro");
    expect(JSON.stringify(pay.wallet.blob)).not.toContain('"vouchers"');

    await page.check('[data-testid=plan-choice-pro] input');
    await freshUnlock(page, "Start Pro?");
    const redeem = await m.waitFor("/api/vouchers/redeem");
    expect(Object.keys(redeem.headers).filter((h) => h.startsWith("x-flagship") || h === "authorization" || h === "cookie")).toEqual([]);
    expect((redeem.body as { username: string; for: string }).for).toBe("pro");
    await expect(page.locator("#plan-current-name")).toHaveText("Pro");
    await expect(page.locator("#plan-balance-amount")).toHaveText("$29");
    await expect(page.locator("#plan-time-left")).toContainText("Paid until");
    await shot(page, testInfo, "plan-pro");
  });

  test("gym plan buying a pack by card goes through Stripe Checkout and fills the balance, unlinked", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    const pay = payments(m, { stripe: true });
    // Stripe's hosted page: a 204 keeps the app where it is, as if the buyer had paid and come straight back.
    let stripePage = "";
    await page.route("https://checkout.stripe.com/**", (route) => {
      stripePage = route.request().url();
      return route.fulfill({ status: 204, body: "" });
    });
    await openPlan(page);
    await expect(page.locator("[data-testid=plan-shop]")).toContainText("never which account they go to");
    await shot(page, testInfo, "plan-shop");
    await page.click("[data-testid=plan-pack-30]");
    const checkout = await m.waitFor("/api/vouchers/stripe/checkout");
    expect(JSON.stringify(checkout.body)).not.toContain("smoketest");
    expect(Object.keys(checkout.headers).filter((h) => h.startsWith("x-flagship") || h === "authorization" || h === "cookie")).toEqual([]);
    await expect.poll(() => stripePage).toContain("https://checkout.stripe.com/c/pay/cs_test_gym");

    // Back from Stripe: the next open of Plan asks for the signatures and adds the vouchers.
    await page.evaluate(() => sessionStorage.setItem("flagship.shop.return", "stripe"));
    // (What the next unlocked Home or Plan visit runs: views/plan.js planTick, here by opening Plan again.)
    await page.evaluate(() => import(new URL("views/plan.js", document.baseURI).href).then((v) => v.enterPlan()));
    const issue = await m.waitFor("/api/vouchers/paid-issue");
    expect(Object.keys(issue.headers).filter((h) => h.startsWith("x-flagship") || h === "authorization" || h === "cookie")).toEqual([]);
    expect((issue.body as { rail: string }).rail).toBe("stripe");
    await sawToast(page, "Added $30 to your balance.");
    await expect(page.locator("#plan-balance-amount")).toHaveText("$30");
    expect(JSON.stringify(pay.wallet.blob)).not.toContain('"vouchers"');
    await shot(page, testInfo, "plan-bought");
  });

  test("gym plan a device that isn't an admin reads the plan and changes nothing", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    payments(m);
    await openPlan(page);
    await expect(page.locator("[data-testid=plan-read-only]")).toBeVisible();
    await expect(page.locator("#plan-autopay")).toBeDisabled();
    await expect(page.locator("#plan-add-test")).toHaveCount(0);
    expect(m.sent("/api/vouchers/").length).toBe(0);
    await shot(page, testInfo, "plan-read-only");
  });
});
