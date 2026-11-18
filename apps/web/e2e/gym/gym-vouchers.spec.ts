/**
 * The voucher shop with no account and the "Load into Flagship" voucher link (docs/anonymous-vouchers.md
 * "Voucher links"), with a mocked `.com`: the real rail handlers and issuer code behind it, the vectors' test key,
 * Stripe's API faked and Stripe's page answered with 204.
 *
 *   1. A browser with no account buys a pack on ?shop=buy, comes back from Stripe and gets the vouchers as an app
 *      link (vouchers only in the fragment), a file and a copy; nothing it sends names an account.
 *   2. Opened with no app, the link reaches the webapp, which keeps it for after the unlock and clears the address.
 *   3. In a signed-in webapp the link asks, then adds; the same link again adds nothing; a truncated one is refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_PAYMENTS_CONFIG } from "@flagship/protocol";
import { InMemoryVoucherPaymentStorage } from "@flagship/storage";
import { handlePaidIssue, handlePaymentsConfig, handleStripeVoucherCheckout, railsSummary, voucherSigningKeysFromEnv, type VoucherRailsDeps } from "@flagship/control-plane";
import { HOME, livePod, mock, reachHome, sawToast, shot, watchToasts, type Mock } from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const keyFile = JSON.parse(readFileSync(join(root, "packages/protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8"));
const LINKS = JSON.parse(readFileSync(join(root, "packages/protocol/test-vectors/voucher-link/vectors.json"), "utf8"));
const keys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk: keyFile.jwk }]));
const leaks = (c: { headers: Record<string, string> }) =>
  Object.keys(c.headers).filter((h) => h.startsWith("x-flagship") || h === "authorization" || h === "cookie");

function shop(m: Mock): { wallet: { version: number; blob: unknown } } {
  const wallet: { version: number; blob: unknown } = { version: 0, blob: null };
  const sessions = new Map<string, Record<string, unknown>>();
  const rails: VoucherRailsDeps = {
    keys,
    config: DEFAULT_PAYMENTS_CONFIG,
    payments: new InMemoryVoucherPaymentStorage(),
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
        const s = sessions.get(decodeURIComponent(url.split("/").pop()!));
        return s ? new Response(JSON.stringify(s)) : new Response("{}", { status: 404 });
      }) as typeof fetch,
    },
  };
  m.get("/api/payments/config", () => {
    const r = handlePaymentsConfig({ config: DEFAULT_PAYMENTS_CONFIG, keys, testIssue: false, rails: railsSummary(rails) });
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
  m.on("PUT", "/api/accounts/smoketest/voucher-wallet", (c) => {
    const b = c.body as { version: number };
    if (b.version !== wallet.version + 1) return { status: 409, json: { code: "version-conflict", wallet: wallet.blob } };
    wallet.version = b.version;
    wallet.blob = b;
    return { json: { ok: true, version: b.version } };
  });
  m.get("/api/accounts/smoketest/voucher-wallet", () => (wallet.blob ? { json: wallet.blob } : { status: 404, json: { code: "not-found" } }));
  m.get("/api/users/smoketest/plan-attestation", { tier: "free", paidUntil: 0 });
  m.get("/api/users/smoketest/allowance", { remainingBytes: 200 * 1024 ** 3 });
  return { wallet };
}

async function openPlan(page: Page): Promise<void> {
  await page.click('[data-tab-target="settings"]');
  await page.click("#settings-tab-plan");
  await expect(page.locator("#view-plan")).toBeVisible();
}

async function openLink(page: Page, link: string): Promise<void> {
  await page.evaluate((l) => import(new URL("views/voucher-link.js", document.baseURI).href).then((v) => v.enterVoucherLink(l)), link);
  await expect(page.locator("#view-voucher-link")).toBeVisible();
}

test.describe("gym webapp vouchers", () => {
  test("gym vouchers a browser with no account buys a pack and gets a Load into Flagship link, unlinked", async ({ page }, testInfo) => {
    await watchToasts(page);
    const m = await mock(page);
    shop(m);
    let stripePage = "";
    await page.route("https://checkout.stripe.com/**", (route) => {
      stripePage = route.request().url();
      return route.fulfill({ status: 204, body: "" });
    });
    await page.goto("/index.html?shop=buy");
    await expect(page.locator("#view-voucher-shop")).toBeVisible();
    await expect(page.locator("[data-testid=voucher-shop-buy]")).toContainText("You don't need an account on this page");
    expect(new URL(page.url()).search).toBe("");
    await shot(page, testInfo, "shop-signed-out");
    await page.click("[data-testid=voucher-shop-pack-10]");
    await expect.poll(() => stripePage).toContain("https://checkout.stripe.com/c/pay/cs_test_gym");

    // Back from Stripe: the browser asks for the signatures and offers the vouchers.
    await page.goto(`/index.html?shop=stripe&session_id=${stripePage.split("/").pop()}`);
    await expect(page.locator("[data-testid=voucher-shop-ready]")).toContainText("Your 10 vouchers ($10) are ready.");
    const href = await page.locator("[data-testid=voucher-shop-load]").getAttribute("href");
    expect(href).toMatch(/^https:\/\/[^/]+\/app\/vouchers#v=[A-Za-z0-9_-]+$/);
    await expect(page.locator("[data-testid=voucher-shop-download]")).toBeVisible();
    await expect(page.locator("[data-testid=voucher-shop-copy]")).toBeVisible();
    for (const c of m.calls.filter((c) => c.url.pathname.startsWith("/api/"))) {
      expect(leaks(c)).toEqual([]);
      expect(JSON.stringify(c.body ?? "")).not.toContain("smoketest");
    }
    await shot(page, testInfo, "shop-ready");

    // The app isn't installed: the open-in-app page hands the whole link to the webapp, which keeps it for after the unlock.
    const fragment = href!.split("#")[1]!;
    await page.goto(`/app/vouchers#${fragment}`);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    expect(new URL(page.url()).hash).toBe("");
    expect(await page.evaluate(() => sessionStorage.getItem("flagship.voucherLink.pending"))).toContain(`#${fragment}`);
  });

  test("gym vouchers a voucher link adds once, the second open adds nothing, a truncated one is refused", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    const pay = shop(m);
    // Plan once: the browser keeps the voucher keys it read, which a link is checked against later.
    await openPlan(page);
    await expect(page.locator("#plan-balance-amount")).toHaveText("$0");
    const link = LINKS.links.single[0] as string;

    const calls = m.calls.length;
    await openLink(page, link);
    await expect(page.locator("[data-testid=voucher-link-title]")).toHaveText("Add 3 vouchers ($3) to this account's wallet?");
    // Checking the link read the wallet and nothing else: no voucher went anywhere.
    expect(m.calls.slice(calls).filter((c) => c.url.pathname.startsWith("/api/vouchers/"))).toEqual([]);
    await shot(page, testInfo, "link-confirm");
    await page.click("[data-testid=voucher-link-add]");
    await sawToast(page, "Added $3 to your balance.");
    await expect(page.locator("#plan-balance-amount")).toHaveText("$3");
    expect(JSON.stringify(pay.wallet.blob)).not.toContain('"vouchers"');

    await openLink(page, link);
    await expect(page.locator("[data-testid=voucher-link-outcome]")).toHaveText("These vouchers are already in this wallet. Nothing was added.");
    await openLink(page, link.slice(0, link.length - 60));
    await expect(page.locator("[data-testid=voucher-link-outcome]")).toHaveText(
      "This voucher link is incomplete or damaged. Open the whole link again, or use the voucher file.",
    );
    expect(m.sent("/api/vouchers/redeem").length).toBe(0);
    await shot(page, testInfo, "link-damaged");
  });
});
