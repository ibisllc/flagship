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

function copyButton(value, label) {
  return `<button class="secondary" data-copy="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
}

export async function enterNameDibs() {
  const session = getSession();
  if (!session?.umk || !session?.irk || !session?.username) {
    toast("Unlock the webapp first", "err");
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
  dlg.setAttribute("aria-label", "Claim your .com name");
  dlg.innerHTML = `
    <h3 class="modal-title">Claim your .com name</h3>
    <div data-stage="closed" class="${win.open ? "hidden" : ""}">
      <p class="modal-message">${
        win.configured && Date.now() < win.start
          ? `The dibs window opens on ${escapeHtml(formatDibsDate(win.start))}.`
          : "The dibs window isn't open, so no names are held for .com holders — any free name can be bought as an ordinary name change."
      }</p>
      <div class="row-2 mt-3"><button class="secondary" data-close>Close</button></div>
    </div>
    <div data-stage="name" class="${win.open ? "" : "hidden"}">
      <p class="modal-message">
        Until ${win.end ? escapeHtml(formatDibsDate(win.end)) : "the window closes"}, a name matching a registered
        <strong>.com</strong> is held for whoever controls that domain. Enter the name of the .com you control.
      </p>
      <label class="label" for="dibs-name">Name</label>
      <div class="row-2"><input id="dibs-name" data-dibs-name autocomplete="off" spellcheck="false" placeholder="acme" /><span>.com</span></div>
      <p class="modal-error err-text hidden" data-dibs-error></p>
      <div class="row-2 mt-3">
        <button class="secondary" data-close>Cancel</button>
        <button class="primary" data-dibs-start>Get my code</button>
      </div>
    </div>
    <div data-stage="publish" class="hidden">
      <p class="modal-message">Publish this code in <strong>one</strong> of these two places, then tap <em>Check now</em>.
        It's tied to your account's key, so nobody else can use it. DNS changes can take a while — you can close this and come back.</p>
      <div class="card mt-2" data-dibs-dns></div>
      <div class="card mt-2" data-dibs-http></div>
      <p class="modal-error err-text hidden" data-dibs-error></p>
      <div class="row-2 mt-3">
        <button class="secondary" data-close>Later</button>
        <button class="primary" data-dibs-check>Check now</button>
      </div>
    </div>
    <div data-stage="done" class="hidden">
      <p class="modal-message" data-dibs-done></p>
      <div class="row-2 mt-3"><button class="primary" data-close>Done</button></div>
    </div>
  `;
  document.body.appendChild(dlg);
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  dlg.addEventListener("click", (e) => {
    const value = e.target?.getAttribute?.("data-copy");
    if (value !== null && value !== undefined) {
      navigator.clipboard?.writeText(value).then(() => toast("Copied"), () => {});
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
    if (!name) return showError("name", "Enter a name.");
    ev.target.disabled = true;
    showError("name", "");
    try {
      claim = await startDibsClaim({ username: session.username, name, umk: session.umk, irkPubHex, signWithIrk });
      if (claim.verified) {
        finish(claim.name);
        return;
      }
      dlg.querySelector("[data-dibs-dns]").innerHTML = `
        <p><strong>Option 1 — DNS.</strong> Add a <code>TXT</code> record:</p>
        <p class="mono">Name: ${escapeHtml(claim.publishAt.dns.name)}</p>
        <p class="mono" style="word-break:break-all">Value: ${escapeHtml(claim.record)}</p>
        <div class="row-2">${copyButton(claim.publishAt.dns.name, "Copy name")}${copyButton(claim.record, "Copy value")}</div>`;
      dlg.querySelector("[data-dibs-http]").innerHTML = `
        <p><strong>Option 2 — a file on your website.</strong> Serve this text at</p>
        <p class="mono" style="word-break:break-all">${escapeHtml(claim.publishAt.https.url)}</p>
        <div class="row-2">${copyButton(claim.record, "Copy text")}</div>`;
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
      `You've proven you control <strong>${escapeHtml(name)}.com</strong>, so the name <strong>${escapeHtml(name)}</strong> is held for you. ` +
      `Switching your account to it is a one-time $20 name change — your servers move with you.`;
    stage("done");
  }

  dlg.showModal();
}
