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
  if (!confirm("Reset removes this device's local key. Continue?")) return;
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
