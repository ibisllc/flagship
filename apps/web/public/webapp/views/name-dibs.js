// "Claim your .com name" — the dibs flow (docs/naming-recovery-and-name-change.md §7).
//
// Three stages in one dialog:
//   1. name   — which .com do you control?
//   2. publish — the record to publish (DNS TXT or HTTPS file); "Check now".
//   3. done   — proven; switching the account to the name is the paid step.
//
// Re-opening the flow for the same name returns the same record (.com keeps a
// pending claim's nonce), so closing the dialog while DNS propagates is safe.

import { getSession } from "../lib/state.js";
import { bytesToHex, signWithIrk } from "../keystore.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";
import { fetchDibsWindow, formatDibsDate, startDibsClaim, verifyDibsClaim } from "../lib/nameDibs.js";

import { tr as tr_ } from "../lib/i18n.js";
function copyButton(value, label) {
  return `<button class="secondary" data-copy="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
}

export async function enterNameDibs({ name: presetName = "", kind = "account", onDone } = {}) {
  const session = getSession();
  if (!session?.umk || !session?.irk || !session?.username) {
    toast(tr_("Unlock the webapp first"), "err");
    return;
  }
  let win;
  try {
    win = await fetchDibsWindow();
  } catch (e) {
    toast(humanError(e), "err");
    return;
  }

  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", tr_("Claim your .com name"));
  dlg.innerHTML = `
    <h3 class="modal-title">${tr_("Claim your .com name")}</h3>
    <div data-stage="closed" class="${win.open ? "hidden" : ""}">
      <p class="modal-message">${win.configured && Date.now() < win.start
          ? tr_("The dibs window opens on {0}.", escapeHtml(formatDibsDate(win.start)))
          : tr_("The dibs window isn't open, so no names are held for .com holders — any free name can be taken as usual.")}</p>
      <div class="row-2 mt-3"><button class="secondary" data-close>${tr_("Close")}</button></div>
    </div>
    <div data-stage="name" class="${win.open ? "" : "hidden"}">
      <p class="modal-message">
        ${tr_("Until {0}, a name matching a registered <strong>.com</strong> is held for whoever controls that domain. Enter the name of the .com you control.", win.end ? escapeHtml(formatDibsDate(win.end)) : "the window closes")}
      </p>
      <label class="label" for="dibs-name">${tr_("Name")}</label>
      <div class="row-2"><input id="dibs-name" data-dibs-name autocomplete="off" spellcheck="false" placeholder="acme" value="${escapeHtml(String(presetName).replace(/-/g, ""))}" /><span>${tr_(".com")}</span></div>
      <p class="modal-error err-text hidden" data-dibs-error></p>
      <div class="row-2 mt-3">
        <button class="secondary" data-close>${tr_("Cancel")}</button>
        <button class="primary" data-dibs-start>${tr_("Get my code")}</button>
      </div>
    </div>
    <div data-stage="publish" class="hidden">
      <p class="modal-message">${tr_("Publish this code in <strong>one</strong> of these two places, then tap <em>Check now</em>. It's tied to your account's key, so nobody else can use it. DNS changes can take a while — you can close this and come back.")}</p>
      <div class="card mt-2" data-dibs-dns></div>
      <div class="card mt-2" data-dibs-http></div>
      <p class="modal-error err-text hidden" data-dibs-error></p>
      <div class="row-2 mt-3">
        <button class="secondary" data-close>${tr_("Later")}</button>
        <button class="primary" data-dibs-check>${tr_("Check now")}</button>
      </div>
    </div>
    <div data-stage="done" class="hidden">
      <p class="modal-message" data-dibs-done></p>
      <div class="row-2 mt-3"><button class="primary" data-close>${tr_("Done")}</button></div>
    </div>
  `;
  document.body.appendChild(dlg);
  let doneCb = null;
  const close = () => {
    dlg.close();
    dlg.remove();
    doneCb?.();
  };
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  dlg.addEventListener("click", (e) => {
    const value = e.target?.getAttribute?.("data-copy");
    if (value !== null && value !== undefined) {
      navigator.clipboard?.writeText(value).then(() => toast(tr_("Copied")), () => {});
    }
  });
  const stage = (name) =>
    dlg.querySelectorAll("[data-stage]").forEach((el) => el.classList.toggle("hidden", el.dataset.stage !== name));
  const showError = (stageName, message) => {
    const el = dlg.querySelector(`[data-stage="${stageName}"] [data-dibs-error]`);
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("hidden", !message);
  };

  const irkPubHex = bytesToHex(session.irk.publicKey);
  let claim = null;

  dlg.querySelector("[data-dibs-start]")?.addEventListener("click", async (ev) => {
    const name = String(dlg.querySelector("[data-dibs-name]").value || "").trim().toLowerCase().replace(/\.com$/, "");
    if (!name) return showError("name", tr_("Enter a name."));
    ev.target.disabled = true;
    showError("name", "");
    try {
      claim = await startDibsClaim({ username: session.username, name, kind, umk: session.umk, irkPubHex, signWithIrk });
      if (claim.verified) {
        finish(claim.name);
        return;
      }
      dlg.querySelector("[data-dibs-dns]").innerHTML = `
        <p>${tr_("<strong>Option 1 — DNS.</strong> Add a <code>TXT</code> record:")}</p>
        <p class="mono">${tr_("Name: {0}", escapeHtml(claim.publishAt.dns.name))}</p>
        <p class="mono" style="word-break:break-all">${tr_("Value: {0}", escapeHtml(claim.record))}</p>
        <div class="row-2">${copyButton(claim.publishAt.dns.name, tr_("Copy name"))}${copyButton(claim.record, tr_("Copy value"))}</div>`;
      dlg.querySelector("[data-dibs-http]").innerHTML = `
        <p>${tr_("<strong>Option 2 — a file on your website.</strong> Serve this text at")}</p>
        <p class="mono" style="word-break:break-all">${escapeHtml(claim.publishAt.https.url)}</p>
        <div class="row-2">${copyButton(claim.record, tr_("Copy text"))}</div>`;
      stage("publish");
    } catch (e) {
      showError("name", humanError(e));
    } finally {
      ev.target.disabled = false;
    }
  });

  dlg.querySelector("[data-dibs-check]")?.addEventListener("click", async (ev) => {
    if (!claim) return;
    ev.target.disabled = true;
    showError("publish", "");
    try {
      const r = await verifyDibsClaim({
        username: session.username,
        name: claim.name,
        kind,
        nonce: claim.nonce,
        umk: session.umk,
        signWithIrk,
      });
      if (r.verified) finish(claim.name);
    } catch (e) {
      showError("publish", humanError(e));
    } finally {
      ev.target.disabled = false;
    }
  });

  function finish(name) {
    dlg.querySelector("[data-dibs-done]").innerHTML =
      tr("You've proven you control <strong>{0}.com</strong>, so the name <strong>{1}</strong> is held for you.", escapeHtml(name), escapeHtml(name));
    doneCb = onDone;
    stage("done");
  }

  dlg.showModal();
}
