// Take over a transferred box — the ACQUIRER claim entry (Slice C).
//
// This is the STANDALONE claim surface the old add-server chooser used to
// host inline. It is reachable three ways:
//   1. A `/transfer?o=<b64url>` universal link (phone Camera / DeepLink) →
//      app.js boot stashes it → dispatchInitialView routes here PRE-verified
//      offer in hand.
//   2. A "Take over a box" action (Home) → paste the link/code OR scan the
//      giver's QR with the camera.
//
// SECURITY (Slice C): a deep-linked / scanned offer is attacker-supplied, so
// the offer signature (vs its own giverIrkPub) + expiry are verified BEFORE
// the severe type-to-confirm and BEFORE any claim is signed/POSTed
// (verifyTransferOffer). The claim signing/POST itself is unchanged
// (submitTransferClaim) — the giver-phone disk-key re-seal is a later step.
//
// TIERED CONFIRM: taking over a box is a SEVERE action (danger color +
// type-to-confirm the server's full name) — the "what you see is what you
// sign" load-bearing consent for an irreversible ownership change.

import { show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { signWithIrk, bytesToHex, adminRootPubHex } from "../keystore.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import {
  parseTransferLink,
  parseTransferOfferQR,
  verifyTransferOffer,
  submitTransferClaim,
} from "../lib/serverTransfer.js";
import { scanWithCamera, hasBarcodeDetector } from "../qrScanner.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";

/** Parse either the universal-link form (`/transfer?o=…`, `flagship://…`) or
 *  a raw JSON transfer code. Returns the parsed offer or throws. */
export function parseAnyTransferInput(text) {
  const viaLink = parseTransferLink(text);
  if (viaLink) return viaLink;
  return parseTransferOfferQR(text); // throws on a malformed non-link paste
}

/**
 * Open the take-over claim dialog.
 *   - No `prefillOffer`: shows the paste/scan input stage first.
 *   - `prefillOffer` (from a deep link): skips input, verifies + severe-
 *     confirms straight away.
 *
 * @param {object} [prefillOffer]  a parseTransferLink / parseTransferOfferQR result
 */
export async function enterTransferClaim(prefillOffer) {
  const session = getSession();
  if (!session?.umk || !session?.irk) {
    toast("Unlock the webapp first", "err");
    return;
  }

  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Take over a box");
  dlg.innerHTML = `
    <h3 class="modal-title">Take over a box</h3>

    <div data-stage="input">
      <p class="modal-message">
        Someone is handing you their box. Paste the transfer link they created
        (Server → Transfer to another account)${
          hasBarcodeDetector() ? ", or scan their QR code" : ""
        }. You'll become the new owner of the box and all its contents.
      </p>
      <textarea class="full-width mt-2" rows="4" data-claim-input placeholder="Paste the transfer link or code…"></textarea>
      ${
        hasBarcodeDetector()
          ? `<button class="secondary full-width mt-2" data-claim-scan>Scan QR with camera</button>
             <video class="full-width mt-2 hidden" data-claim-video playsinline muted style="border-radius:8px;max-height:320px;background:#000"></video>`
          : ""
      }
      <p class="modal-error err-text hidden" data-claim-error></p>
      <div class="row-2 mt-3">
        <button class="secondary" data-claim-cancel>Cancel</button>
        <button class="primary" data-claim-continue>Continue</button>
      </div>
    </div>

    <div data-stage="confirm" class="hidden">
      <p class="modal-message">
        This takes over <strong data-confirm-domain></strong> and
        <strong>all its contents</strong>. You'll become the new owner and the
        current owner will lose control — this cannot be undone. Type the
        server's full name to confirm.
      </p>
      <input class="full-width mt-2" data-confirm-input placeholder="" autocomplete="off" />
      <p class="modal-error err-text hidden" data-confirm-error></p>
      <div class="row-2 mt-3">
        <button class="secondary" data-confirm-cancel>Cancel</button>
        <button class="danger" data-confirm-go disabled>Take over</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  let scanStream = null;
  const stopScan = () => {
    if (scanStream) {
      try { scanStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      scanStream = null;
    }
  };
  const cleanup = () => {
    stopScan();
    if (dlg.open) dlg.close();
    dlg.remove();
  };

  const inputStage = dlg.querySelector('[data-stage="input"]');
  const confirmStage = dlg.querySelector('[data-stage="confirm"]');
  const inputEl = dlg.querySelector("[data-claim-input]");
  const continueBtn = dlg.querySelector("[data-claim-continue]");
  const inputErr = dlg.querySelector("[data-claim-error]");
  const scanBtn = dlg.querySelector("[data-claim-scan]");
  const videoEl = dlg.querySelector("[data-claim-video]");

  const confirmDomainEl = dlg.querySelector("[data-confirm-domain]");
  const confirmInput = dlg.querySelector("[data-confirm-input]");
  const confirmErr = dlg.querySelector("[data-confirm-error]");
  const confirmGo = dlg.querySelector("[data-confirm-go]");

  return new Promise((resolve, reject) => {
    const onCancel = () => { cleanup(); reject({ code: "cancelled" }); };
    dlg.addEventListener("close", onCancel, { once: true });
    dlg.querySelector("[data-claim-cancel]")?.addEventListener("click", onCancel);
    dlg.querySelector("[data-confirm-cancel]")?.addEventListener("click", onCancel);

    // ── Verify a parsed offer, then advance to the severe confirm stage. ──
    async function advanceToConfirm(offer, errEl) {
      const verdict = await verifyTransferOffer(offer);
      if (!verdict.ok) {
        errEl.textContent = verdict.reason;
        errEl.classList.remove("hidden");
        return;
      }
      stopScan();
      inputStage.classList.add("hidden");
      confirmStage.classList.remove("hidden");
      const domain = offer.serverDomain;
      confirmDomainEl.textContent = domain;
      confirmInput.placeholder = domain;
      confirmInput.value = "";
      confirmGo.disabled = true;
      confirmInput.focus();

      confirmInput.addEventListener("input", () => {
        confirmGo.disabled =
          confirmInput.value.trim().toLowerCase() !== String(domain).toLowerCase();
      });

      confirmGo.addEventListener("click", async () => {
        confirmErr.classList.add("hidden");
        confirmGo.disabled = true;
        confirmGo.textContent = "Taking over…";
        try {
          const out = await submitTransferClaim({
            offer,
            acquirerUsername: session.username,
            umk: session.umk,
            acquirerIrkPubHex: bytesToHex(session.irk.publicKey),
            // Slice D §9.8 — the claim (v2) commits to the acquirer's admin
            // master root ("" for a legacy account), so the box re-pins its
            // AUTHORITY anchor to exactly this key via the giver's signed
            // handoff proof — a rogue `.com` can't swap it post-signature.
            acquirerAdminRootPubHex: session.adminRootSeed
              ? await adminRootPubHex(session.adminRootSeed)
              : "",
            // Slice D: the transfer CLAIM order is signed with the ACQUIRER's
            // admin root (when present); the co-signed mailbox-auth stays the
            // IRK (tag-routed). Legacy accounts sign with the IRK.
            signWithIrk: sensitiveSigner(),
          });
          toast(`Took over ${escapeHtml(out.body.newServerDomain || domain)}`, "ok");
          cleanup();
          show("view-home");
          resolve(out);
        } catch (e) {
          confirmErr.textContent = humanError(e);
          confirmErr.classList.remove("hidden");
          confirmGo.disabled = false;
          confirmGo.textContent = "Take over";
        }
      });
    }

    // ── Input stage: paste ──
    continueBtn?.addEventListener("click", async () => {
      inputErr.classList.add("hidden");
      let offer;
      try {
        offer = parseAnyTransferInput(inputEl.value.trim());
      } catch {
        inputErr.textContent = "That doesn't look like a transfer link or code.";
        inputErr.classList.remove("hidden");
        return;
      }
      await advanceToConfirm(offer, inputErr);
    });

    // ── Input stage: camera scan (graceful — degrades to paste) ──
    scanBtn?.addEventListener("click", async () => {
      inputErr.classList.add("hidden");
      scanBtn.disabled = true;
      scanBtn.textContent = "Scanning…";
      videoEl?.classList.remove("hidden");
      try {
        const raw = await scanWithCamera(videoEl, { timeoutMs: 30_000 });
        scanStream = videoEl?.srcObject || null;
        let offer;
        try {
          offer = parseAnyTransferInput(String(raw).trim());
        } catch {
          inputErr.textContent = "That QR isn't a Flagship transfer code.";
          inputErr.classList.remove("hidden");
          return;
        }
        await advanceToConfirm(offer, inputErr);
      } catch (e) {
        // No camera / permission denied / not HTTPS / timeout → keep paste.
        inputErr.textContent =
          "Couldn't scan — paste the transfer link or code instead.";
        inputErr.classList.remove("hidden");
        void e;
      } finally {
        stopScan();
        videoEl?.classList.add("hidden");
        scanBtn.disabled = false;
        scanBtn.textContent = "Scan QR with camera";
      }
    });

    // ── Deep-link prefill: verify + severe-confirm immediately. ──
    if (prefillOffer) {
      void advanceToConfirm(prefillOffer, inputErr).catch((e) => {
        inputErr.textContent = humanError(e);
        inputErr.classList.remove("hidden");
      });
    }
  });
}
