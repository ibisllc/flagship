// Settings → Plan (docs/payments-privacy-and-rails.md §6 and "As built"): the account's plan and time left, the
// prepaid balance shown as round dollars, the plan choice, auto-pay, the random start, the monthly overage cap and
// the shop (cards through Stripe Checkout, §11; Monero comes later; the phone apps sell through their stores). Only an
// admin device of the account changes anything, buys or spends; every other device reads.

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { confirmFreshUnlock } from "../lib/freshUnlock.js";
import { canSignAdminOrders } from "../lib/addServerGate.js";
import { dateLocale, tr, trn } from "../lib/i18n.js";
import {
  addTestVouchers,
  buyWithStripe,
  consumeShopReturn,
  finishShopOrders,
  loadPaymentsConfig,
  loadPlanState,
  loadWallet,
  pendingShopOrders,
  PlanError,
  relayPrivacyLine,
  relayStateOf,
  saveSettings,
  spendTick,
} from "../lib/plan.js";
import { isPaidPlan, monthsOfPlan } from "../lib/vouchers.js";

registerView("view-plan");

const DAY_MS = 86_400_000;

export const planName = (plan) => (plan === "pro" ? tr("Pro") : plan === "pro-max" ? tr("Pro Max") : tr("Free"));
const usd = (n) => `$${n}`;

/** The sentence for a refusal code from `.com` or this module. */
export function planErrorText(code) {
  switch (code) {
    case "locked":
      return tr("Unlock this device first.");
    case "wallet-unreadable":
      return tr("This device can't open the account's balance.");
    case "wallet-conflict":
      return tr("Another device changed the balance at the same time. Try again.");
    case "issue-off":
    case "no-key":
      return tr("Test vouchers aren't available here.");
    case "rate-limited":
      return tr("Too many tries. Try again in a few minutes.");
    case "rail-off":
      return tr("Card payments aren't available right now.");
    case "payment-unpaid":
      return tr("The payment hasn't gone through yet. Your vouchers will appear once it does.");
    case "payment-refunded":
      return tr("That payment was refunded or disputed, so it added nothing.");
    case "payment-used":
    case "payment-invalid":
    case "wrong-count":
      return tr("That payment couldn't be added to this balance.");
    case "rail-unreachable":
      return tr("The payment service didn't answer. Your purchase is kept; try again in a moment.");
    default:
      return tr("Something went wrong. Try again.");
  }
}

/** "Paid until 3 Dec (12 days left)", or the Free line. */
export function timeLeftText(state, now) {
  if (!isPaidPlan(state.plan) || !state.paidUntil) return tr("Free: 25 GB a month, then slowed.");
  const date = new Date(state.paidUntil).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
  if (state.paidUntil <= now) return tr("Renewing: paid until {0}", date);
  const days = Math.max(1, Math.floor((state.paidUntil - now) / DAY_MS));
  return trn(days, "Paid until {1} ({0} day left)", "Paid until {1} ({0} days left)", date);
}

/** "$30", with "about 3 months of Pro" when a plan is chosen. */
export function balanceText(cfg, wallet) {
  const n = wallet.vouchers.length;
  if (n === 0) return { amount: usd(0), detail: tr("No prepaid balance") };
  const plan = isPaidPlan(wallet.settings.plan) ? wallet.settings.plan : "pro";
  const months = monthsOfPlan(cfg, plan, n);
  const detail = months >= 1 ? trn(months, "About {0} month of {1}", "About {0} months of {1}", planName(plan)) : tr("Less than a month of {0}", planName(plan));
  return { amount: usd(n * cfg.unitUsd), detail };
}

/** The overage cap choices: off, then one block at a time up to the most a month allows (at most ten choices). */
export function overageCapOptions(cfg) {
  const step = cfg.overage.blockUnits;
  const out = [{ units: 0, label: tr("Off: slow down past the plan") }];
  for (let u = step; u <= cfg.overage.maxCapUnits && out.length < 11; u += step) {
    out.push({ units: u, label: tr("Up to {0} a month ({1} GB more)", usd(u * cfg.unitUsd), (u / step) * cfg.overage.blockGb) });
  }
  return out;
}

/** The section's HTML for a model; pure so tests can read it. */
export function planViewHtml(m) {
  const { config: cfg, wallet, planState, admin, testIssue, now } = m;
  const rails = m.rails ?? { stripe: false, apple: false, google: false };
  const waiting = m.pendingOrders ?? 0;
  const s = wallet.settings;
  const dis = admin ? "" : " disabled";
  const bal = balanceText(cfg, wallet);
  const choice = (plan, label, price) =>
    `<label class="fs-row" data-testid="plan-choice-${plan}"><input type="radio" name="plan-choice" value="${plan}"${(s.plan ?? "free") === plan ? " checked" : ""}${dis} /> <span class="fs-row-body"><span class="fs-row-title">${escapeHtml(label)}</span><span class="caption">${escapeHtml(price)}</span></span></label>`;
  const caps = overageCapOptions(cfg);
  const capUnits = caps.some((c) => c.units === s.overageCapUnits) ? s.overageCapUnits : caps[0].units;
  return `
    <div class="card" data-testid="plan-current">
      <div class="row"><span class="label">${escapeHtml(tr("Plan"))}</span><span class="value" id="plan-current-name">${escapeHtml(planName(planState.plan))}</span></div>
      <p class="caption" id="plan-time-left">${escapeHtml(timeLeftText(planState, now))}</p>
    </div>
    <div class="card mt-3" data-testid="plan-balance">
      <div class="row"><span class="label">${escapeHtml(tr("Prepaid balance"))}</span><span class="value" id="plan-balance-amount">${escapeHtml(bal.amount)}</span></div>
      <p class="caption" id="plan-balance-detail">${escapeHtml(bal.detail)}</p>
      <p class="caption">${escapeHtml(tr("Your balance stays on your devices. Flagship sees when time is added to your plan, never what paid for it."))}</p>
      ${(() => {
        const line = relayPrivacyLine(m.ohttp, m.relay ?? { failures: 0, retryAt: 0, wentDirect: false }, now);
        return `<p class="caption" id="plan-relay-line" data-relay="${line.id}">${escapeHtml(line.text)}</p>`;
      })()}
    </div>
    ${admin ? "" : `<div class="card mt-3 warn" data-testid="plan-read-only"><p class="note">${escapeHtml(tr("Only an admin device of this account can change the plan or spend the balance."))}</p></div>`}
    <h2 class="mt-4">${escapeHtml(tr("Choose a plan"))}</h2>
    <div class="card" id="plan-choices">
      ${choice("free", tr("Free"), tr("25 GB a month"))}
      ${choice("pro", tr("Pro"), tr("{0} a month, {1} GB", usd(cfg.plans.pro.unitsPerMonth * cfg.unitUsd), cfg.plans.pro.includedGb))}
      ${choice("pro-max", tr("Pro Max"), tr("{0} a month, {1} GB", usd(cfg.plans["pro-max"].unitsPerMonth * cfg.unitUsd), cfg.plans["pro-max"].includedGb))}
    </div>
    <div class="card mt-3">
      <label class="caption"><input type="checkbox" role="switch" id="plan-autopay"${s.autoPay ? " checked" : ""}${dis} /> ${escapeHtml(tr("Pay automatically from the balance"))}</label>
      <label class="caption"><input type="checkbox" role="switch" id="plan-delay-start"${s.delayStart ? " checked" : ""}${dis} /> ${escapeHtml(tr("Start at a random time in the next {0} hours", cfg.activationDelayMaxHours))}</label>
      <p class="caption">${escapeHtml(tr("Starting at once shows that a purchase and an upgrade happened close together. A random start hides that."))}</p>
    </div>
    <h2 class="mt-4">${escapeHtml(tr("More data"))}</h2>
    <div class="card">
      <label class="caption" for="plan-overage-cap">${escapeHtml(tr("When the month's data runs low, buy more from the balance, up to:"))}</label>
      <select id="plan-overage-cap"${dis}>
        ${caps.map((c) => `<option value="${c.units}"${c.units === capUnits ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
      </select>
    </div>
    <h2 class="mt-4">${escapeHtml(tr("Add to your balance"))}</h2>
    <div class="card" data-testid="plan-shop">
      ${
        rails.stripe
          ? `<p class="caption">${escapeHtml(tr("Pay by card with Stripe. Stripe sees your card; Flagship sees that vouchers were bought, never which account they go to."))}</p>
      <div class="row-2">
        ${cfg.packs.map((p) => `<button class="secondary" id="plan-buy-${p}" data-buy="${p}" data-testid="plan-pack-${p}"${dis}>${escapeHtml(tr("Buy {0}", usd(p * cfg.unitUsd)))}</button>`).join("")}
      </div>
      <p class="caption">${escapeHtml(tr("Vouchers don't expire and aren't refunded."))}</p>`
          : `<p class="note">${escapeHtml(tr("Card payments aren't available right now."))}</p>`
      }
      ${waiting > 0 ? `<p class="caption" data-testid="plan-shop-waiting">${escapeHtml(tr("Waiting for a payment to go through."))}</p>` : ""}
      <div class="row"><span class="label">${escapeHtml(tr("Monero"))}</span><span class="pill">${escapeHtml(tr("Coming soon"))}</span></div>
      <div class="row"><span class="label">${escapeHtml(tr("In the iPhone and Android apps"))}</span><span class="pill">${escapeHtml(rails.apple || rails.google ? tr("Available") : tr("Coming soon"))}</span></div>
    </div>
    ${testIssue && admin ? `<div class="card mt-3" data-testid="plan-test"><button class="secondary" id="plan-add-test">${escapeHtml(tr("Add 30 test vouchers"))}</button><p class="caption">${escapeHtml(tr("Test server only: free vouchers for trying the plans."))}</p></div>` : ""}
  `;
}

let model = null;

async function loadModel() {
  const pc = await loadPaymentsConfig();
  const [planState, cur] = await Promise.all([loadPlanState().catch(() => ({ plan: null, paidUntil: 0 })), loadWallet(pc.config)]);
  return {
    ...pc,
    planState,
    cur,
    wallet: cur.wallet,
    admin: canSignAdminOrders(),
    now: Date.now(),
    pendingOrders: pendingShopOrders().length,
    relay: relayStateOf(),
  };
}

function paint() {
  const root = $("plan-content");
  if (!root || !model) return;
  root.innerHTML = planViewHtml(model);
  if (!model.admin) return;
  root.querySelectorAll('input[name="plan-choice"]').forEach((el) => el.addEventListener("change", () => choosePlan(el.value)));
  $("plan-autopay")?.addEventListener("change", (e) => change({ autoPay: e.target.checked }));
  $("plan-delay-start")?.addEventListener("change", (e) => change({ delayStart: e.target.checked }));
  $("plan-overage-cap")?.addEventListener("change", (e) => change({ overageCapUnits: Number(e.target.value) }));
  $("plan-add-test")?.addEventListener("click", () => addTest());
  root.querySelectorAll("[data-buy]").forEach((el) => el.addEventListener("click", () => buy(Number(el.dataset.buy))));
}

async function buy(units) {
  try {
    const { url } = await buyWithStripe(units, { paymentsConfig: model });
    globalThis.location.assign(url);
  } catch (e) {
    toast(planErrorText(e instanceof PlanError ? e.code : "failed"), "err");
  }
}

/** Pays out orders this browser bought, then says how it went if we just came back from Stripe. */
async function finishOrders() {
  const back = consumeShopReturn();
  let res = { added: 0, refused: [] };
  try {
    res = await finishShopOrders();
  } catch (e) {
    if (back) toast(planErrorText(e instanceof PlanError ? e.code : "failed"), "err");
    return { back, added: 0 };
  }
  if (res.added > 0) toast(tr("Added {0} to your balance.", usd(res.added)), "ok");
  for (const code of res.refused) toast(planErrorText(code), "err");
  if (back === "cancel") toast(tr("Payment cancelled. Nothing was charged."));
  else if (back === "stripe" && res.added === 0 && res.refused.length === 0) toast(planErrorText("payment-unpaid"));
  return { back, added: res.added };
}

async function run(work) {
  try {
    await work();
  } catch (e) {
    toast(planErrorText(e instanceof PlanError ? e.code : "failed"), "err");
  }
  await renderPlan();
}

async function change(patch, { interactive = false } = {}) {
  await run(async () => {
    model.cur = await saveSettings(model.config, patch, { current: model.cur });
    // A plan the owner just chose (and is waiting for) may go directly if the private relay is down.
    await spendTick({ paymentsConfig: model, current: model.cur, interactive });
  });
}

async function choosePlan(value) {
  const plan = value === "pro" || value === "pro-max" ? value : null;
  // A paid plan chosen without the random start spends at once: the browser's stand-in for Face ID.
  if (plan && !model.wallet.settings.delayStart) {
    const ok = await confirmFreshUnlock({ title: tr("Start {0}?", planName(plan)), message: tr("This spends from your prepaid balance.") });
    if (!ok.ok) return paint();
  }
  await change({ plan }, { interactive: !!plan && !model.wallet.settings.delayStart });
}

async function addTest() {
  await run(async () => {
    await addTestVouchers(30, { paymentsConfig: model });
    toast(tr("Added 30 test vouchers."), "ok");
  });
}

export async function renderPlan() {
  const root = $("plan-content");
  if (!root) return;
  if (!model) root.innerHTML = skeletonCards(2);
  try {
    model = await loadModel();
    paint();
  } catch (e) {
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(planErrorText(e instanceof PlanError ? e.code : "failed"))}</p></div>`;
  }
}

/** The automatic spend on start and whenever the Plan section opens; quiet on any failure. */
export async function planTick() {
  let back = null;
  try {
    if (pendingShopOrders().length > 0 || sessionStorage.getItem("flagship.shop.return")) back = (await finishOrders()).back;
  } catch {
    /* tried again on the next tick */
  }
  if (back && !document.getElementById("view-plan")?.classList.contains("hidden")) back = null;
  try {
    await spendTick();
  } catch {
    /* the next tick tries again; the grace period covers a missed day */
  }
  if (back) await enterPlan(false);
}

let lastTick = 0;

/** planTick at most once an hour per tab: Home calls it on every visit (the "on app start" tick). */
export function planTickSoon(now = Date.now()) {
  // A purchase waiting to be paid out (or just back from Stripe) doesn't wait for the hourly tick.
  if (now - lastTick < 3_600_000 && pendingShopOrders().length === 0 && !hasShopReturn()) return;
  lastTick = now;
  void planTick();
}

export function initPlanView() {
  $("plan-back")?.addEventListener("click", () => show("view-settings"));
}

function hasShopReturn() {
  try {
    return !!sessionStorage.getItem("flagship.shop.return");
  } catch {
    return false;
  }
}

export async function enterPlan(tick = true) {
  show("view-plan");
  model = null;
  if (tick) await planTick();
  await renderPlan();
}
