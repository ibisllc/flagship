// Approve a voi.ci sign-in on this browser (docs/voici-and-messages.md §6.1, §9.5, §11.4): the page's verified name
// and photo, the 6-digit code both sides show, how the visitor appears, then Approve (this device's passphrase, the
// browser's stand-in for Face ID) or Cancel. The webapp has no device attestation, so it signs in on the slow tier.

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import { inlineConfirm } from "../lib/modal.js";
import { confirmFreshUnlock } from "../lib/freshUnlock.js";
import { getSession } from "../lib/state.js";
import { hex, voiciPseudonymCode } from "../lib/voiciProtocol.js";
import { approveSignIn, joinSignInPipe, loadSignInPage, pagePseudonym } from "../lib/voiciSignIn.js";
import { changeState } from "../lib/voiciWorld.js";
import { jpegUrl } from "../lib/voiciImage.js";
import { rememberVisitedPage } from "../lib/voiciReplies.js";
import { VOICI_RULES_TEXT, VOICI_RULES_TITLE, VOICI_SIGN_IN_PRIVATE, voiciErrorText } from "../lib/voiciCopy.js";

import { tr } from "../lib/i18n.js";

registerView("view-voici-sign-in", { tab: "messages" });

const RULES_KEY = "flagship.voici.rulesAccepted.v1";
let pipe = null;

function close() {
  try {
    pipe?.close();
  } catch {
    /* already closed */
  }
  pipe = null;
}

function setState(html) {
  $("voici-sign-in-content").innerHTML = html;
}

function failed(e) {
  close();
  setState(`<div class="card stack-sm"><p data-testid="voici-sign-in-error">${escapeHtml(voiciErrorText(e))}</p>
    <button type="button" class="secondary" id="voici-sign-in-done">${escapeHtml(tr("Close"))}</button></div>`);
  $("voici-sign-in-done").addEventListener("click", () => void import("./messages.js").then((m) => m.enterMessages()));
}

async function rulesAccepted() {
  try {
    if (localStorage.getItem(RULES_KEY) === "1") return true;
  } catch {
    /* ask */
  }
  const ok = await inlineConfirm({ title: VOICI_RULES_TITLE(), message: VOICI_RULES_TEXT(), okLabel: tr("I agree") });
  if (ok) {
    try {
      localStorage.setItem(RULES_KEY, "1");
    } catch {
      /* asked again next time */
    }
  }
  return ok;
}

/** Opens the approval for a parsed sign-in link (lib/voiciSignIn.js parseVoiciSignInLink). `deps` are test seams. */
export async function enterVoiciSignIn(link, deps = {}) {
  close();
  show("view-voici-sign-in");
  setState(`<div class="card placeholder">${escapeHtml(tr("Checking the page…"))}</div>`);
  let page;
  try {
    page = await loadSignInPage(link, deps);
    pipe = await joinSignInPipe(link, deps);
  } catch (e) {
    return failed(e);
  }
  const code = voiciPseudonymCode(hex(pagePseudonym(getSession().umk, link.pageId).p.publicKey));
  const name = page.profile.displayName;
  const avatar = page.profile.avatar ? page.pieces.get(page.profile.avatar) : null;
  setState(`
    <div class="card stack-sm" data-testid="voici-sign-in-card">
      <div class="voici-preview-head">
        ${avatar ? `<img class="pe-avatar" id="voici-sign-in-avatar" alt="" />` : ""}
        <p class="weight-600" data-testid="voici-sign-in-title"></p>
      </div>
      <p>${escapeHtml(tr("Check that voi.ci shows this code:"))}</p>
      <p class="sas-code mono" data-testid="voici-sign-in-code">${escapeHtml(pipe.sas)}</p>
      <p class="note" data-testid="voici-sign-in-appear">${escapeHtml(tr("You appear as Visitor {0}. They never see your username.", code))}</p>
      <p class="note">${escapeHtml(VOICI_SIGN_IN_PRIVATE())}</p>
      <p class="note">${escapeHtml(tr("From the web, an account can start a new conversation once it is 7 days old, one a day."))}</p>
      <p class="muted-sm" id="voici-sign-in-wait"></p>
      <div class="row-2">
        <button type="button" class="secondary" id="voici-sign-in-cancel">${escapeHtml(tr("Cancel"))}</button>
        <button type="button" id="voici-sign-in-approve">${escapeHtml(tr("Approve"))}</button>
      </div>
    </div>`);
  $("voici-sign-in-content").querySelector("[data-testid=voici-sign-in-title]").textContent = tr("Sign in to voi.ci to message {0}?", name);
  if (avatar) $("voici-sign-in-avatar").src = jpegUrl(avatar);
  $("voici-sign-in-cancel").addEventListener("click", () => {
    close();
    void import("./messages.js").then((m) => m.enterMessages());
  });
  const request = link.request;
  const approve = $("voici-sign-in-approve");
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    if (!(await rulesAccepted())) {
      approve.disabled = false;
      return;
    }
    const fresh = await (deps.confirmFreshUnlock ?? confirmFreshUnlock)({
      title: tr("Approve this sign-in?"),
      message: tr("voi.ci will be able to send messages to {0} as Visitor {1}.", name, code),
      okLabel: tr("Approve"),
    });
    if (!fresh.ok) {
      approve.disabled = false;
      if (fresh.error) $("voici-sign-in-wait").textContent = fresh.error;
      return;
    }
    try {
      const answer = await approveSignIn(link, request, { ...deps, updateState: (fn, d) => changeState(fn, d) });
      await pipe.answer(answer);
      rememberVisitedPage(link.pageId, link.username);
      close();
      setState(`<div class="card stack-sm"><p data-testid="voici-sign-in-done">${escapeHtml(tr("Signed in. You can go back to voi.ci."))}</p>
        <button type="button" class="secondary" id="voici-sign-in-close">${escapeHtml(tr("Close"))}</button></div>`);
      $("voici-sign-in-close").addEventListener("click", () => void import("./messages.js").then((m) => m.enterMessages()));
    } catch (e) {
      failed(e);
    }
  });
}

export function initVoiciSignInView() {
  /* rendered per sign-in */
}
