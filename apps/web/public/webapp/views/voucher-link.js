// A "Load into Flagship" voucher link opened in the webapp (docs/anonymous-vouchers.md "Voucher links"): the
// open-in-app page's web option, or a link pasted into the address bar. It asks before adding, checks every voucher
// here against the keys this browser already holds (no network call), and adds the new ones to the account's sealed
// wallet. Offline they wait in this browser and join the wallet at the next tick. The spend happens later, through
// the usual trickle, so nothing ties the purchase to the moment the vouchers arrived.

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { tr, trn } from "../lib/i18n.js";
import { commitVoucherLink, PlanError, prepareVoucherLink } from "../lib/plan.js";

registerView("view-voucher-link", { tab: "settings" });

const usd = (n) => `$${n}`;

/** The one sentence when a link adds nothing (or can't be read); null when there is something to add. Shared wording: iOS and Android say the same. */
export function voucherLinkOutcomeText(outcome) {
  switch (outcome) {
    case "damaged":
    case "not-a-link":
      return tr("This voucher link is incomplete or damaged. Open the whole link again, or use the voucher file.");
    case "newer":
      return tr("This voucher link needs a newer version of Flagship. Update the app, then open the link again.");
    case "already":
      return tr("These vouchers are already in this wallet. Nothing was added.");
    case "spent":
      return tr("These vouchers were already spent. Nothing was added.");
    case "invalid":
      return tr("These vouchers aren't signed by Flagship. Nothing was added.");
    case "unknown-key":
      return tr("This device doesn't know the key these vouchers were signed with yet. Open Settings, Plan once while online, then open the link again.");
    case "full":
      return tr("This wallet can hold 500 vouchers. Spend some first, then open the link again.");
    case "not-admin":
      return tr("Only an admin device of this account can add vouchers. Open the link on one.");
    case "locked":
      return tr("Sign in to your account first, then open the link again.");
    default:
      return null;
  }
}

/** The confirm card for a prepared link (outcome "add"). */
export function voucherLinkConfirmHtml(prep) {
  const n = prep.plan.add.length;
  const lines = [];
  if (prep.link.parts > 1) lines.push(tr("This is link {0} of {1} from the same purchase.", prep.link.part, prep.link.parts));
  if (prep.plan.duplicate > 0) lines.push(tr("Already in this wallet: {0}", prep.plan.duplicate));
  if (prep.plan.spent > 0) lines.push(tr("Already spent: {0}", prep.plan.spent));
  if (prep.plan.invalid > 0) lines.push(tr("Not signed by Flagship, left out: {0}", prep.plan.invalid));
  if (prep.plan.unknownKey > 0) lines.push(tr("Signed with a key this device doesn't know yet, left out: {0}", prep.plan.unknownKey));
  return `
    <div class="card stack-sm" data-testid="voucher-link-confirm">
      <p class="weight-600" data-testid="voucher-link-title">${escapeHtml(trn(n, "Add {0} voucher ({1}) to this account's wallet?", "Add {0} vouchers ({1}) to this account's wallet?", usd(n)))}</p>
      ${lines.map((l) => `<p class="caption" data-testid="voucher-link-line">${escapeHtml(l)}</p>`).join("")}
      <p class="caption">${escapeHtml(tr("Nothing is sent when you add them. They are spent later, a little at a time, like any other voucher."))}</p>
      ${prep.offline ? `<p class="caption" data-testid="voucher-link-offline">${escapeHtml(tr("You're offline. They wait in this browser and join the wallet when it's back online."))}</p>` : ""}
      <div class="row-2">
        <button id="voucher-link-add" data-testid="voucher-link-add">${escapeHtml(tr("Add"))}</button>
        <button class="secondary" id="voucher-link-cancel" data-testid="voucher-link-cancel">${escapeHtml(tr("Cancel"))}</button>
      </div>
    </div>`;
}

const outcomeHtml = (text) => `<div class="card" data-testid="voucher-link-outcome"><p>${escapeHtml(text)}</p></div>`;

async function done() {
  const { enterPlan } = await import("./plan.js");
  return enterPlan();
}

/** Shows the link's confirm card, or why it adds nothing. `deps` reach lib/plan.js (tests). */
export async function enterVoucherLink(raw, deps = {}) {
  show("view-voucher-link");
  const box = $("voucher-link-content");
  if (!box) return;
  box.innerHTML = `<div class="card placeholder">${escapeHtml(tr("Checking the vouchers…"))}</div>`;
  let prep;
  try {
    prep = await prepareVoucherLink(raw, deps);
  } catch (e) {
    box.innerHTML = outcomeHtml(tr("Something went wrong. Try again."));
    if (!(e instanceof PlanError)) console.error(e);
    return;
  }
  const text = voucherLinkOutcomeText(prep.outcome);
  if (text) {
    box.innerHTML = outcomeHtml(text);
    return;
  }
  box.innerHTML = voucherLinkConfirmHtml(prep);
  $("voucher-link-cancel")?.addEventListener("click", () => void done());
  $("voucher-link-add")?.addEventListener("click", async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      const r = await commitVoucherLink(prep, deps);
      if (r.parked) toast(tr("Added {0}. They join your balance when this browser is back online.", usd(r.added)), "ok");
      else toast(tr("Added {0} to your balance.", usd(r.added)), "ok");
      await done();
    } catch {
      ev.currentTarget.disabled = false;
      toast(tr("Something went wrong. Try again."), "err");
    }
  });
}
