// The org's Plan inside Settings → Organizations (docs/plans-and-backup-offer.md "As built"): Business status, seats
// in use, the price, the org wallet's balance and auto-pay (org admins only: only they open the wallet key), the
// trial, buying a company's invoiced batch, voucher files in and out. Every number comes from `.com`'s served
// config; every sentence goes through tr().

import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { inlinePrompt } from "../lib/modal.js";
import { tr, trn, dateLocale } from "../lib/i18n.js";
import { getSession } from "../lib/state.js";
import { loadPaymentsConfig } from "../lib/plan.js";
import { downloadTextFile } from "../lib/keyfileBackup.js";
import * as op from "../lib/orgPlan.js";

const DAY = 86_400_000;

const money = (usd) => {
  try {
    return new Intl.NumberFormat(dateLocale(), { style: "currency", currency: "USD", maximumFractionDigits: usd % 1 === 0 ? 0 : 2 }).format(usd);
  } catch {
    return `$${usd}`;
  }
};
const day = (ms) => new Date(ms).toLocaleDateString(dateLocale());

/** The plan's status sentence. Exported for tests. */
export function orgPlanStatusText(p, now = Date.now()) {
  if (p.status === "trial") {
    const days = Math.max(0, Math.ceil((p.trialEndsAt - now) / DAY));
    return trn(days, "Business, trial: {0} day left", "Business, trial: {0} days left");
  }
  if (p.status === "paid") return tr("Business: paid through {0}", day(p.paidUntil));
  return tr("Business has lapsed");
}

export const LAPSED_TEXT = () => tr("You can still use every app, remove people and export the org. Adding people, servers or connectors needs a paid plan.");

/** Refusal codes as sentences. Exported for tests. */
export function orgPlanErrorText(e) {
  switch (e?.code) {
    case "org-plan-lapsed":
      return tr("This org's plan has lapsed. Pay for seats on the Plan to add people.");
    case "org-seats-below-live":
      return tr("Pay for at least as many seats as there are people in the org.");
    case "voucher-file-bad":
      return tr("That isn't a Flagship voucher file.");
    case "batch-size":
      return tr("A batch is {0} to {1} vouchers.", e.min, e.max);
    case "batch-key-bad":
      return tr("That isn't a Flagship batch key file.");
    case "rail-off":
      return tr("Card payments aren't available right now.");
    case "bank-off":
      return tr("Bank transfer isn't available right now. Pay by card instead.");
    case "payment-void":
      return tr("That batch can no longer be paid. Start a new batch.");
    case "wallet-key-missing":
    case "wallet-unreadable":
      return tr("This browser can't open the org's wallet yet. Ask another admin to rotate the org's keys.");
    default:
      return tr("That didn't go through. Try again.");
  }
}

function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", async () => {
      const files = [];
      for (const f of input.files ?? []) files.push({ name: f.name, text: await f.text() });
      resolve(files);
    });
    input.click();
  });
}

/**
 * Renders the org's Plan into `host`. `seat`, `snap` from orgSeat.js; `isOrgAdmin` decides whether the wallet and its
 * actions show.
 */
export async function renderOrgPlan(seat, snap, host, { isOrgAdmin, refresh }) {
  let plan;
  let pc;
  try {
    [plan, pc] = await Promise.all([op.loadOrgPlan(seat.orgId), loadPaymentsConfig()]);
  } catch {
    host.innerHTML = `<p class="note">${escapeHtml(tr("The plan couldn't be loaded. Try again later."))}</p>`;
    return;
  }
  const cfg = pc.config;
  const umk = getSession()?.umk;
  let keys = null;
  let wallet = null;
  if (isOrgAdmin && umk) {
    try {
      keys = await op.walletKeys(seat, snap, { umk, create: true });
      wallet = await op.openOrgWallet(seat, cfg, keys);
      if (wallet.version > 0 && wallet.keyVersion < keys.newest) wallet = (await op.refreshAfterRotation(seat, snap, cfg, keys, { umk, current: wallet })).wallet;
    } catch {
      wallet = null;
    }
  }
  const seats = Math.max(wallet?.wallet.settings.seats ?? 0, op.minPayableSeats(cfg, plan));
  const price = op.priceOf(cfg, seats);
  const bal = wallet ? op.orgBalance(cfg, { ...wallet.wallet, settings: { ...wallet.wallet.settings, seats } }) : null;
  const batches = op.pendingBatches();
  host.innerHTML = `
    <p class="fs-detail-label">${escapeHtml(tr("Plan"))}</p>
    <p class="fs-row-title" data-org-plan-status>${escapeHtml(orgPlanStatusText(plan))}</p>
    ${plan.status === "lapsed" ? `<p class="note">${escapeHtml(LAPSED_TEXT())}</p>` : ""}
    ${plan.status === "trial" ? `<p class="note">${escapeHtml(tr("Paid time starts when the trial ends."))}</p>` : ""}
    <p class="note">${escapeHtml(tr("{0} of {1} seats in use", plan.liveSeats, plan.seatLimit))}</p>
    <p class="note">${escapeHtml(tr("{0} a seat a month, at least {1} seats", money(price.perSeat), cfg.business.minSeats))}</p>
    ${
      wallet
        ? `<div class="stack-sm">
      <label>${escapeHtml(tr("Seats to pay for"))} <input type="number" data-org-seats min="${op.minPayableSeats(cfg, plan)}" max="${cfg.business.maxSeats}" value="${seats}"></label>
      <p class="note">${escapeHtml(trn(seats, "{1} a month for {0} seat", "{1} a month for {0} seats", money(price.perMonth)))}</p>
      <p class="note" data-org-balance>${escapeHtml(trn(bal.vouchers, "{0} voucher in the org's wallet", "{0} vouchers in the org's wallet"))} · ${escapeHtml(trn(bal.months, "about {0} month", "about {0} months"))}</p>
      <label><input type="checkbox" data-org-autopay ${wallet.wallet.settings.autoPay ? "checked" : ""}> ${escapeHtml(tr("Pay automatically from the org's wallet"))}</label>
      <button class="secondary" data-org-import>${escapeHtml(tr("Import voucher files"))}</button>
      <label>${escapeHtml(tr("Invoiced batch for the company"))} <input type="number" data-org-batch-units min="${cfg.business.batchMinUnits}" max="${cfg.business.batchMaxUnits}" value="${Math.max(cfg.business.batchMinUnits, price.units * 12)}"></label>
      <p class="note">${escapeHtml(tr("The invoice names your company and the number of vouchers, never this org or anyone in it."))}</p>
      <button data-org-batch-buy ${pc.rails?.stripe ? "" : "disabled"}>${escapeHtml(tr("Buy a batch"))}</button>
      ${pc.rails?.stripeBank ? `<button class="secondary" data-org-batch-bank>${escapeHtml(tr("Pay by bank transfer"))}</button><p class="note">${escapeHtml(tr("Stripe shows your company the bank details. The vouchers are ready once the whole transfer has arrived, which can take a few days."))}</p>` : ""}
      ${pc.rails?.stripe ? "" : `<p class="note" data-org-batch-rail-off>${escapeHtml(tr("Card payments aren't available right now."))}</p>`}
      <button class="secondary" data-org-batch-key>${escapeHtml(tr("Finish a batch from its key file"))}</button>
      ${batches.length ? batches.map((b) => `<div class="stack-sm"><p class="note">${escapeHtml(trn(b.units, "Batch of {0} voucher", "Batch of {0} vouchers"))}</p><button data-org-batch-wallet="${escapeHtml(b.session)}">${escapeHtml(tr("Add to the org's wallet"))}</button><button class="secondary" data-org-batch-files="${escapeHtml(b.session)}">${escapeHtml(tr("Save as voucher files for staff"))}</button></div>`).join("") : ""}
    </div>`
        : isOrgAdmin
          ? `<p class="note">${escapeHtml(tr("Unlock to see the org's wallet."))}</p>`
          : `<p class="note">${escapeHtml(tr("The org's admins hold its wallet."))}</p>`
    }`;
  if (!wallet || !keys) return;
  // The org trickle runs while an org admin has the org open here (the phones also run it in the background).
  void op.orgSpendTick(seat, snap, { umk, plan, cfg, keys, current: wallet }).catch(() => {});

  const run = async (fn, done) => {
    try {
      const r = await fn();
      const msg = typeof done === "function" ? done(r) : done;
      if (msg) toast(msg, "ok");
    } catch (e) {
      toast(orgPlanErrorText(e), "err");
    }
    await refresh();
  };
  const opts = () => ({ umk: getSession().umk });
  host.querySelector("[data-org-seats]")?.addEventListener("change", (ev) => {
    const n = Number(ev.target.value);
    if (!Number.isSafeInteger(n) || n < op.minPayableSeats(cfg, plan) || n > cfg.business.maxSeats) {
      toast(orgPlanErrorText({ code: "org-seats-below-live" }), "err");
      return;
    }
    void run(() => op.saveOrgWalletSettings(seat, snap, cfg, keys, { seats: n }, opts()), tr("Saved."));
  });
  host.querySelector("[data-org-autopay]")?.addEventListener("change", (ev) => {
    void run(() => op.saveOrgWalletSettings(seat, snap, cfg, keys, { autoPay: !!ev.target.checked }, opts()), tr("Saved."));
  });
  host.querySelector("[data-org-import]")?.addEventListener("click", async () => {
    const files = await pickFiles(".json,application/json");
    if (files.length === 0) return;
    await run(() => op.importVoucherFiles(seat, snap, cfg, keys, files, opts()), (r) => trn(r.added, "Added {0} voucher.", "Added {0} vouchers."));
  });
  const buy = async (method) => {
    const units = Number(host.querySelector("[data-org-batch-units]")?.value);
    try {
      const r = await op.buyBatch(units, { paymentsConfig: pc, method });
      downloadTextFile(r.keyFile.name, r.keyFile.text);
      toast(tr("Keep the batch key file: it finishes the batch on any computer, and anyone holding it can claim the vouchers."), "ok");
      location.assign(r.url);
    } catch (e) {
      toast(orgPlanErrorText(e), "err");
    }
  };
  host.querySelector("[data-org-batch-buy]")?.addEventListener("click", () => buy("card"));
  host.querySelector("[data-org-batch-bank]")?.addEventListener("click", () => buy("bank"));
  host.querySelector("[data-org-batch-key]")?.addEventListener("click", async () => {
    const files = await pickFiles(".json,application/json", false);
    if (files.length === 0) return;
    await run(() => op.addBatchKey(files[0].text), tr("Batch added."));
  });
  const finish = async (session) => {
    const b = op.pendingBatches().find((x) => x.session === session);
    if (!b) return null;
    const vouchers = await op.finishBatch(b, { paymentsConfig: pc });
    if (!vouchers) {
      toast(tr("That batch isn't paid yet. A bank transfer can take a few days."), "ok");
      return null;
    }
    return { b, vouchers };
  };
  for (const btn of host.querySelectorAll("[data-org-batch-wallet]")) {
    btn.addEventListener("click", () =>
      run(async () => {
        const got = await finish(btn.dataset.orgBatchWallet);
        if (!got) return null;
        await op.updateOrgWallet(seat, snap, cfg, keys, (w) => ({ ...w, vouchers: [...w.vouchers, ...got.vouchers] }), opts());
        op.forgetBatch(got.b.session);
        return got.vouchers.length;
      }, (n) => (n ? trn(n, "Added {0} voucher.", "Added {0} vouchers.") : null)),
    );
  }
  for (const btn of host.querySelectorAll("[data-org-batch-files]")) {
    btn.addEventListener("click", () =>
      run(async () => {
        const got = await finish(btn.dataset.orgBatchFiles);
        if (!got) return null;
        const answer = await inlinePrompt({
          title: tr("Voucher files for staff"),
          message: tr("How many vouchers in each file? (Pro is {0} a month.)", cfg.plans.pro.unitsPerMonth),
          initial: String(cfg.plans.pro.unitsPerMonth * 12),
          okLabel: tr("Save the files"),
        });
        if (answer === null || answer === undefined) return null;
        const per = Math.max(1, Math.round(Number(answer) || 0));
        for (const f of op.voucherFilesOf(got.vouchers, per)) downloadTextFile(f.name, f.text);
        op.forgetBatch(got.b.session);
        return Math.ceil(got.vouchers.length / per);
      }, (n) => (n ? trn(n, "Saved {0} voucher file. Each one is like cash: hand it over privately.", "Saved {0} voucher files. Each one is like cash: hand them over privately.") : null)),
    );
  }
}
