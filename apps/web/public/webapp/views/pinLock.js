// Tier-1 "Lock with PIN code" — view wiring (webapp only).
//
// Two views:
//   view-pin-unlock — numeric PIN to re-derive the in-memory key after a
//     PIN lock, with "Unlock with passphrase instead" as the fallback.
//   view-pin-set    — set (new + confirm) or change (current + new +
//     confirm) the PIN. Reached from Settings.
//
// The crypto + store live in lib/pinLock.js; this module is presentation +
// flow only.

import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession, unlockSession, lockSession } from "../lib/state.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { toast } from "../lib/toast.js";
import { stopRenewals } from "./home.js";
import {
  hasPin,
  setPin,
  verifyPin,
  unlockWithPin,
  isValidPin,
  MIN_PIN_LEN,
  MAX_PIN_LEN,
} from "../lib/pinLock.js";

import { tr, trn } from "../lib/i18n.js";
registerView("view-pin-unlock");
registerView("view-pin-set");

// "set" (first time: new + confirm) | "change" (current + new + confirm).
let setMode = "set";

/** Tier-1 LOCK (PIN variant): clear the in-memory key and route to the PIN
 *  unlock screen. Mirrors sessionTiers.lock() but gates re-entry on the
 *  PIN. Exported so Settings can call it. */
export function lockToPin() {
  stopRenewals?.();
  lockSession();
  setSubtitle("locked");
  show("view-pin-unlock");
}

/** Open the set/change-PIN view. mode "change" additionally requires the
 *  current PIN before accepting a new one. */
export function startSetPin({ mode = "set" } = {}) {
  setMode = mode;
  const title = $("pin-set-title");
  if (title) title.textContent = mode === "change" ? tr("Change PIN") : tr("Set a PIN");
  $("pin-set-current")?.classList.toggle("hidden", mode !== "change");
  hideErr("pin-set-error");
  for (const id of ["pin-set-current", "pin-set-input", "pin-set-confirm"]) {
    const el = $(id);
    if (el) el.value = "";
  }
  show("view-pin-set");
}

function showErr(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = "";
}
function hideErr(id) {
  const el = $(id);
  if (el) el.style.display = "none";
}

async function handleSetPinSave() {
  hideErr("pin-set-error");
  const next = $("pin-set-input").value;
  const confirm = $("pin-set-confirm").value;
  if (!isValidPin(next)) {
    showErr("pin-set-error", tr("PIN must be {0}–{1} digits.", MIN_PIN_LEN, MAX_PIN_LEN));
    return;
  }
  if (next !== confirm) {
    showErr("pin-set-error", tr("PINs don't match."));
    return;
  }
  if (setMode === "change") {
    const current = $("pin-set-current").value;
    if (!(await verifyPin(current))) {
      showErr("pin-set-error", tr("Current PIN is incorrect."));
      return;
    }
  }
  const seed = getSession().umk;
  if (!seed) {
    showErr("pin-set-error", tr("Unlock first."));
    return;
  }
  try {
    await setPin(next, seed);
  } catch {
    showErr("pin-set-error", tr("Couldn't save the PIN."));
    return;
  }
  // Clear the inputs either way so the PIN isn't left sitting in the DOM.
  for (const id of ["pin-set-current", "pin-set-input", "pin-set-confirm"]) {
    const el = $(id);
    if (el) el.value = "";
  }
  if (setMode === "change") {
    toast(tr("PIN updated"), "ok");
    show("view-settings-tab");
  } else {
    // First-time set: lock immediately so the PIN is in effect.
    lockToPin();
  }
}

async function handlePinUnlock() {
  hideErr("pin-unlock-error");
  const input = $("pin-unlock-input");
  const val = input.value;
  try {
    const seed = await unlockWithPin(val);
    await unlockSession(seed);
    input.value = "";
    await dispatchInitialView();
    toast(tr("Unlocked"));
  } catch (e) {
    input.value = "";
    if (e && e.lockedOut) {
      toast(tr("Too many wrong PINs — use your passphrase."), "err");
      show("view-unlock");
      return;
    }
    const left = e && typeof e.remaining === "number" ? e.remaining : null;
    showErr(
      "pin-unlock-error",
      left != null ? trn(left, "Wrong PIN — {0} try left.", "Wrong PIN — {0} tries left.") : tr("Wrong PIN."),
    );
  }
}

export function initPinViews() {
  $("pin-unlock-go")?.addEventListener("click", () => handlePinUnlock().catch(() => {}));
  $("pin-unlock-passphrase")?.addEventListener("click", () => show("view-unlock"));
  $("pin-set-go")?.addEventListener("click", () => handleSetPinSave().catch(() => {}));
  $("pin-set-cancel")?.addEventListener("click", () => show("view-settings-tab"));
}

export { hasPin };
