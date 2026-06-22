// "Add a server" chooser. Adding a server is two genuinely different
// acts and the native apps distinguish them: PROVISION a brand-new box
// (mint a recipe → burn → boot) vs. PAIR an existing, already-running
// box (paste its address). The webapp used to jump straight into the
// create-server flow, leaving pod-pair.js reachable only from a Settings
// shortcut. This view is the fork the native apps already have.

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { signWithIrk, bytesToHex } from "../keystore.js";
import { parseTransferOfferQR, submitTransferClaim } from "../lib/serverTransfer.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-add-server-chooser");

export function initAddServerChooserView() {
  $("add-server-back")?.addEventListener("click", () => show("view-home"));
  $("add-server-provision")?.addEventListener("click", async () => {
    const { enterCreateServer } = await import("./create-server.js");
    await enterCreateServer();
  });
  $("add-server-pair")?.addEventListener("click", async () => {
    const { enterPodPair } = await import("./pod-pair.js");
    await enterPodPair();
  });
  $("add-server-claim")?.addEventListener("click", () => {
    openTransferClaimDialog().catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("transfer claim failed", e);
        toast(humanError(e), "err");
      }
    });
  });
}

// Acquirer "Take over a transferred box": paste the giver's transfer code, sign
// + POST a ServerTransferClaim. On success `.com` re-homes the box into this
// account; the giver's phone then finishes the disk-key re-seal.
async function openTransferClaimDialog() {
  const session = getSession();
  if (!session.umk || !session.irk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Take over a box");
  dlg.innerHTML = `
    <h3 class="modal-title">Take over a box</h3>
    <p class="modal-message">
      Paste the transfer code the current owner created. You'll become the new
      owner of the box and all its contents.
    </p>
    <textarea class="full-width mt-2" rows="4" data-claim-input placeholder="Paste the transfer code…"></textarea>
    <p class="modal-error err-text hidden" data-claim-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-claim-cancel>Cancel</button>
      <button class="primary" data-claim-go>Take over</button>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  const cleanup = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  const inputEl = dlg.querySelector("[data-claim-input]");
  const goBtn = dlg.querySelector("[data-claim-go]");
  const cancelBtn = dlg.querySelector("[data-claim-cancel]");
  const errEl = dlg.querySelector("[data-claim-error]");

  return new Promise((resolve, reject) => {
    const onCancel = () => { cleanup(); reject({ code: "cancelled" }); };
    dlg.addEventListener("close", onCancel, { once: true });
    cancelBtn.addEventListener("click", onCancel);

    goBtn.addEventListener("click", async () => {
      errEl.classList.add("hidden");
      let offer;
      try {
        offer = parseTransferOfferQR(inputEl.value.trim());
      } catch (e) {
        errEl.textContent = "That doesn't look like a transfer code.";
        errEl.classList.remove("hidden");
        return;
      }
      goBtn.disabled = true;
      goBtn.textContent = "Taking over…";
      try {
        const out = await submitTransferClaim({
          offer,
          acquirerUsername: session.username,
          umk: session.umk,
          acquirerIrkPubHex: bytesToHex(session.irk.publicKey),
          signWithIrk,
        });
        toast(`Took over ${escapeHtml(out.body.newServerDomain || offer.serverDomain)}`, "ok");
        cleanup();
        show("view-home");
        resolve(out);
      } catch (e) {
        errEl.textContent = humanError(e);
        errEl.classList.remove("hidden");
        goBtn.disabled = false;
        goBtn.textContent = "Take over";
      }
    });
  });
}

export function enterAddServerChooser() {
  show("view-add-server-chooser");
}
