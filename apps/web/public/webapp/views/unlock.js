import { unlockUmk, hasWrappedUmk, resetDevice } from "../keystore.js";
import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { unlockSession, lockSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { stopRenewals } from "./home.js";

registerView("view-unlock");

async function handleUnlock() {
  const a = $("unlock-passphrase").value;
  try {
    const seed = await unlockUmk(a);
    await unlockSession(seed);
    await dispatchInitialView();
    toast("unlocked");
  } catch {
    toast("wrong passphrase", "err");
  }
}

export async function handleReset() {
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: "Reset this device?",
    message: "Removes this device's local key. You'll need your recovery passkey or the wrapped UMK export to come back. Continue?",
    okLabel: "Reset",
    danger: true,
  });
  if (!ok) return;
  await resetDevice();
  localStorage.removeItem("flagship.sessionId");
  localStorage.removeItem("flagship.username");
  localStorage.removeItem("flagship.sessionToken");
  localStorage.removeItem("flagship.podBaseUrl");
  lockSession();
  stopRenewals();
  setSubtitle("device reset");
  show("view-bootstrap");
}

export function initUnlockView() {
  $("unlock-go")?.addEventListener("click", handleUnlock);
}

export { hasWrappedUmk };
