// The voucher shop with no account (docs/anonymous-vouchers.md "Voucher links"): a person with only a phone opens
// webapp.<apex>/?shop=buy in the phone's browser, pays by card, and comes back here. The browser unblinds the
// vouchers and offers them as "Load into Flagship" app links (the vouchers ride only in the URL fragment, which no
// server sees), a voucher file and a copy of the links. No username is asked or sent anywhere on this page.

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { tr, trn } from "../lib/i18n.js";
import { controlApex } from "../lib/apex.js";
import { downloadTextFile } from "../lib/keyfileBackup.js";
import {
  buyVouchersSignedOut,
  consumeShopReturn,
  finishSignedOutOrders,
  forgetReadyShopVouchers,
  loadPaymentsConfig,
  pendingShopOrders,
  PlanError,
  readyShopVouchers,
  signedOutShopOrders,
} from "../lib/plan.js";
import { encodeVoucherLinks } from "../lib/voucherLink.js";
import { planErrorText } from "./plan.js";

registerView("view-voucher-shop");

const usd = (n) => `$${n}`;
const apexHost = () => new URL(controlApex()).host;

/** The links, the file and the copy for one paid-out purchase. */
export function readyPurchaseHtml(p, apex) {
  const links = encodeVoucherLinks(p.vouchers, apex);
  const n = p.vouchers.length;
  const id = escapeHtml(p.sessionId);
  return `
    <div class="card stack-sm mt-3" data-testid="voucher-shop-ready" data-session="${id}">
      <p class="weight-600">${escapeHtml(trn(n, "Your {0} voucher ({1}) is ready.", "Your {0} vouchers ({1}) are ready.", usd(n)))}</p>
      ${links
        .map(
          (href, i) =>
            `<a class="btn full-width mt-2" href="${escapeHtml(href)}" data-testid="voucher-shop-load">${escapeHtml(links.length > 1 ? tr("Load into Flagship (part {0} of {1})", i + 1, links.length) : tr("Load into Flagship"))}</a>`,
        )
        .join("")}
      <p class="caption">${escapeHtml(tr("Opens the Flagship app on this phone and adds them to your account's wallet there. Nothing about your account is sent to Flagship when you do."))}</p>
      <div class="row-2">
        <button class="secondary" data-download="${id}" data-testid="voucher-shop-download">${escapeHtml(tr("Download voucher file"))}</button>
        <button class="secondary" data-copy="${id}" data-testid="voucher-shop-copy">${escapeHtml(links.length > 1 ? tr("Copy links") : tr("Copy link"))}</button>
      </div>
      <p class="caption">${escapeHtml(tr("Until you load them or save the file, the vouchers are only in this browser. Anyone with the link or the file can spend them."))}</p>
      <button class="secondary" data-forget="${id}" data-testid="voucher-shop-forget">${escapeHtml(tr("They're loaded: forget them here"))}</button>
    </div>`;
}

export function shopHtml(pc, ready, waiting, apex) {
  const cfg = pc.config;
  return `
    ${ready.map((p) => readyPurchaseHtml(p, apex)).join("")}
    ${waiting > 0 ? `<div class="card mt-3" data-testid="voucher-shop-waiting"><p class="caption">${escapeHtml(tr("Waiting for a payment to go through."))}</p><button class="secondary" id="voucher-shop-check">${escapeHtml(tr("Check again"))}</button></div>` : ""}
    <div class="card mt-3" data-testid="voucher-shop-buy">
      ${
        pc.rails?.stripe
          ? `<p>${escapeHtml(tr("Pay by card with Stripe. You don't need an account on this page: after paying, load the vouchers into the Flagship app, or save them as a file."))}</p>
      <p class="caption">${escapeHtml(tr("Stripe sees your card; Flagship sees that vouchers were bought, never which account they go to."))}</p>
      <div class="row-2">
        ${cfg.packs.map((p) => `<button class="secondary" data-buy="${p}" data-testid="voucher-shop-pack-${p}">${escapeHtml(tr("Buy {0}", usd(p * cfg.unitUsd)))}</button>`).join("")}
      </div>
      <p class="caption">${escapeHtml(tr("Vouchers don't expire and aren't refunded."))}</p>`
          : `<p class="note">${escapeHtml(tr("Card payments aren't available right now."))}</p>`
      }
    </div>`;
}

let pc = null;

async function paint() {
  const root = $("voucher-shop-content");
  if (!root) return;
  pc = pc ?? (await loadPaymentsConfig());
  const ready = readyShopVouchers();
  root.innerHTML = shopHtml(pc, ready, signedOutShopOrders().length, apexHost());
  root.querySelectorAll("[data-buy]").forEach((el) => el.addEventListener("click", () => buy(Number(el.dataset.buy))));
  $("voucher-shop-check")?.addEventListener("click", () => void finishAndPaint(true));
  const find = (id) => ready.find((p) => p.sessionId === id);
  root.querySelectorAll("[data-download]").forEach((el) =>
    el.addEventListener("click", async () => {
      const p = find(el.dataset.download);
      if (!p) return;
      const { voucherFilesOf } = await import("../lib/orgPlan.js");
      for (const f of voucherFilesOf(p.vouchers, p.vouchers.length)) downloadTextFile(f.name, f.text);
    }),
  );
  root.querySelectorAll("[data-copy]").forEach((el) =>
    el.addEventListener("click", async () => {
      const p = find(el.dataset.copy);
      if (!p) return;
      try {
        await navigator.clipboard.writeText(encodeVoucherLinks(p.vouchers, apexHost()).join("\n"));
        toast(tr("Copied."), "ok");
      } catch {
        toast(tr("Couldn't copy. Use the voucher file instead."), "err");
      }
    }),
  );
  root.querySelectorAll("[data-forget]").forEach((el) =>
    el.addEventListener("click", () => {
      if (!globalThis.confirm(tr("Forget these vouchers in this browser? Only do this once they are in the app or saved as a file."))) return;
      forgetReadyShopVouchers(el.dataset.forget);
      void paint();
    }),
  );
}

async function buy(units) {
  try {
    const { url } = await buyVouchersSignedOut(units, { paymentsConfig: pc ?? undefined });
    globalThis.location.assign(url);
  } catch (e) {
    toast(planErrorText(e instanceof PlanError ? e.code : "failed"), "err");
  }
}

async function finishAndPaint(say) {
  try {
    const res = await finishSignedOutOrders({ paymentsConfig: pc ?? undefined });
    for (const code of res.refused) toast(planErrorText(code), "err");
    if (say && res.ready === 0 && res.waiting > 0) toast(planErrorText("payment-unpaid"));
  } catch {
    if (say) toast(planErrorText("failed"), "err");
  }
  await paint();
}

/** True when this load should open the signed-out shop: `?shop=buy`, or back from Stripe for a signed-out order. */
export function wantsVoucherShop(loc = globalThis.location, hist = globalThis.history, back = null) {
  try {
    const u = new URL(loc.href);
    if (u.searchParams.get("shop") === "buy") {
      u.searchParams.delete("shop");
      hist?.replaceState({}, "", u.pathname + (u.search === "?" ? "" : u.search) + u.hash);
      return true;
    }
  } catch {
    /* not a shop link */
  }
  return back !== null && (signedOutShopOrders().length > 0 || readyShopVouchers().length > 0);
}

/** Opens the shop; `back` is the Stripe return ("stripe" | "cancel") this load carried, if any. */
export async function enterVoucherShop(back = null) {
  show("view-voucher-shop");
  // A return that only signed-out orders were waiting for is this page's: the signed-in Plan mustn't also read it.
  if (back && pendingShopOrders().length === 0) consumeShopReturn();
  if (back === "cancel") toast(tr("Payment cancelled. Nothing was charged."));
  await finishAndPaint(back === "stripe");
}
