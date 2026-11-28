// "Reset account keys" in Settings → Account security (docs/revocation-ui.md, docs/wipe-restart.md).
//
// The ceremony is lib/wipeRestartCeremony.js unchanged: a fresh account key, a new recovery passkey, a new
// identity key swapped in on `.com`. Every other device loses its grants and has to join again, every server has
// to be paired again, the servers keep their data, and this browser keeps the account under a new passphrase.
// It used to sit on each row of Trusted devices as "Wipe & restart", which read as if it wiped that one device.
// The confirmation keeps its strength: a sheet whose button counts down three seconds before it acts.

import { tr } from "./i18n.js";
import { escapeHtml } from "./util.js";
import { getSession, unlockSession } from "./state.js";
import { startCountdown } from "./replaceDeviceCeremony.js";
import { runWipeRestartCeremony } from "./wipeRestartCeremony.js";
import { bootstrapFromExistingSeed, keepRetiredUmk, resetDevice, setCurrentIrkVersion } from "../keystore.js";

export const RESET_KEYS_COPY = Object.freeze({
  heading: tr("Reset account keys"),
  explain: tr("Makes new keys for your account. Every other device is removed and has to join again, and every server has to be paired again. Your servers keep their data, and the account stays on this device."),
  confirmTitle: tr("Reset your account keys?"),
  confirmMessage: tr("Makes new keys for your account. Every other device is removed and has to join again, and every server has to be paired again. Your servers keep their data, and the account stays on this device. This can't be undone."),
  confirm: tr("Reset account keys"),
  counting: (n) => tr("Resetting in {0}…", n),
  locked: tr("Unlock the webapp first"),
});

/**
 * A native <dialog> confirmation whose primary button counts down three seconds before it resolves true;
 * Cancel, Esc and the backdrop resolve false. `countingLine(n)` is the line shown while it counts.
 */
export function openCountdownSheet({ titleHtml, bodyHtml, primaryLabel, primaryClass, countingLine }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "ceremony-dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.innerHTML = `
      <form method="dialog" class="modal-card">
        <h3 class="modal-title">${titleHtml}</h3>
        <div class="modal-message">${bodyHtml}</div>
        <p class="modal-message" data-countdown-line aria-live="polite"></p>
        <div class="row-2 mt-3">
          <button type="button" class="secondary" data-cancel>${tr("Cancel")}</button>
          <button type="button" class="${primaryClass || "danger"}" data-primary>${primaryLabel}</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === "function") {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    } else {
      dialog.setAttribute("open", "");
    }
    const primary = dialog.querySelector("[data-primary]");
    const cancel = dialog.querySelector("[data-cancel]");
    const line = dialog.querySelector("[data-countdown-line]");
    let countdown = null;
    let resolved = false;
    const close = (v) => {
      if (resolved) return;
      resolved = true;
      countdown?.cancel();
      try { dialog.close(); } catch { /* polyfilled */ }
      dialog.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => close(false));
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); close(false); });
    primary.addEventListener("click", () => {
      if (countdown) return;
      primary.setAttribute("disabled", "");
      countdown = startCountdown({
        onTick: (remaining) => {
          if (remaining > 0) {
            line.textContent = countingLine(remaining);
            primary.textContent = `${remaining}…`;
          } else {
            line.textContent = tr("Working…");
          }
        },
      });
      countdown.promise.then((ok) => {
        if (ok) close(true);
      });
    });
  });
}

/**
 * Run "Reset account keys". `progress(text)` shows each step; resolves `{ done: true }` on success,
 * `{ done: false }` when the person stopped. Throws on a failure before `.com` committed; a failure of the
 * local install after it resolves `{ done: false, localFailed: message }`.
 */
export async function runResetAccountKeys({ progress = () => {} } = {}) {
  const session = getSession();
  if (!session.umk || !session.username) throw new Error(RESET_KEYS_COPY.locked);
  const confirmed = await openCountdownSheet({
    titleHtml: escapeHtml(RESET_KEYS_COPY.confirmTitle),
    bodyHtml: `<p>${escapeHtml(RESET_KEYS_COPY.confirmMessage)}</p>`,
    primaryLabel: escapeHtml(RESET_KEYS_COPY.confirm),
    primaryClass: "danger",
    countingLine: RESET_KEYS_COPY.counting,
  });
  if (!confirmed) return { done: false };

  // The new account key is kept in this browser under a new passphrase.
  const { inlinePrompt } = await import("./modal.js");
  const newLocalPass = await inlinePrompt({
    title: tr("Set a new browser passphrase"),
    message: tr("After the reset, this browser will unlock with a new passphrase. Use 8+ characters."),
    placeholder: tr("New browser passphrase"),
    type: "password",
    okLabel: tr("Continue"),
    validate: (v) => (v && v.length >= 8 ? null : tr("Use at least 8 characters")),
  });
  if (!newLocalPass) return { done: false };

  progress(tr("Registering new passkey…"));
  const result = await runWipeRestartCeremony({ username: session.username, umk: session.umk, adminRootSeed: session.adminRootSeed });
  progress(tr("Server accepted; installing locally…"));
  try {
    const oldUmk = session.umk;
    await resetDevice();
    // A fresh account key starts its identity key at version 1.
    setCurrentIrkVersion(1);
    await bootstrapFromExistingSeed(newLocalPass, result.newUmk);
    // The admin-root record (and the device's other local secrets) were sealed under the old account key:
    // keep that key retired under the new one so they still open (the admin root is sealed again on first use).
    await keepRetiredUmk(result.newUmk, oldUmk);
    await unlockSession(result.newUmk, session.username);
  } catch (e) {
    return {
      done: false,
      localFailed: tr("Server committed but local install failed: {0}. Re-open the app to recover.", e?.message ?? e),
    };
  }
  progress(tr("Done. Your account has new keys."));
  return { done: true };
}
