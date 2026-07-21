import { unlockUmk, hasWrappedUmk, resetDevice } from "../keystore.js";
import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { unlockSession, lockSession, getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { stopRenewals } from "./home.js";
import { remove as profileRemove } from "../lib/profilesStore.js";
import { clearPin } from "../lib/pinLock.js";
import { hasCloudRecovery } from "../lib/recovery.js";
import { resolveAccount } from "../lib/accountResolve.js";
import { accountDeletePolicy } from "../lib/accountDeletion.js";
import { enterAccountDelete } from "./account-delete.js";

registerView("view-unlock");

async function handleUnlock() {
  const a = $("unlock-passphrase").value;
  try {
    const seed = await unlockUmk(a);
    await unlockSession(seed);
    // The reset rule: restoring via the full passphrase (chosen, or after a
    // forgotten PIN / lockout) clears any PIN — the passphrase is the real
    // key, and the PIN must be re-set deliberately afterwards.
    try {
      await clearPin();
    } catch {
      /* best-effort — never block an otherwise-good unlock */
    }
    await dispatchInitialView();
    toast("Unlocked");
  } catch {
    toast("Wrong passphrase", "err");
  }
}

export async function handleReset() {
  // Fold the device-reset under the SignOutPolicy gate so it can't bypass the
  // deletion ceremony: with NO cloud recovery on the LAST device, a reset is
  // account DEATH and must run the full ceremony (typed-username + confirm),
  // not a one-tap key wipe that silently orphans the only copy of the key.
  // With recovery (or another device), the key survives — the existing
  // reset-and-come-back-via-recovery path is unchanged.
  const username = getSession().username;
  let enrolled = false;
  try {
    enrolled = await hasCloudRecovery(username);
  } catch {
    enrolled = false; // fail-closed → treat as no recovery
  }
  if (!enrolled) {
    let resolution = null;
    try {
      resolution = await resolveAccount(username);
    } catch {
      resolution = null;
    }
    const policy = accountDeletePolicy({
      hasCloudRecovery: false,
      isDemoAccount: resolution?.kind === "demo",
    });
    if (policy === "ceremony") {
      enterAccountDelete();
      return;
    }
  }
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: "Reset this device?",
    message: "Removes this device's local key. You'll need your recovery passkey or the wrapped UMK export to come back. Continue?",
    okLabel: "Reset",
    danger: true,
  });
  if (!ok) return;
  await resetDevice();
  profileRemove("sessionId");
  // `username` is device-wide-or-pre-profile, so profileRemove also drops
  // the legacy flat key (which keystore.js still reads at boot).
  profileRemove("username");
  profileRemove("sessionToken");
  profileRemove("podBaseUrl");
  lockSession();
  stopRenewals();
  setSubtitle("device reset");
  show("view-bootstrap");
}

export function initUnlockView() {
  $("unlock-go")?.addEventListener("click", handleUnlock);
}

export { hasWrappedUmk };
