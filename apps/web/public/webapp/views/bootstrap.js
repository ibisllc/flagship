import { bootstrapNewIdentity, bootstrapFromExistingSeed } from "../keystore.js";
import { $, registerView } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { recoverFromCloud } from "../lib/recovery.js";
import { unlockSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";

registerView("view-bootstrap");

async function handleBootstrap() {
  const a = $("bootstrap-passphrase").value;
  const b = $("bootstrap-passphrase-2").value;
  if (a !== b) return toast("passphrases don't match", "err");
  if (a.length < 8) return toast("passphrase must be 8+ chars", "err");
  try {
    const seed = await bootstrapNewIdentity(a);
    await unlockSession(seed);
    await dispatchInitialView();
    toast("device key generated");
  } catch (e) {
    toast(String(e), "err");
  }
}

async function handleRecover() {
  const username = prompt("Username on the account you're recovering:");
  if (!username) return;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(username)) {
    return toast("invalid username", "err");
  }
  const passA = prompt("Pick a new local passphrase for this browser (8+ chars):");
  if (!passA || passA.length < 8) return toast("passphrase must be 8+ chars", "err");
  const passB = prompt("Confirm passphrase:");
  if (passA !== passB) return toast("passphrases don't match", "err");
  try {
    const seed = await recoverFromCloud(username);
    await bootstrapFromExistingSeed(passA, seed);
    localStorage.setItem("flagship.username", username);
    await unlockSession(seed, username);
    await dispatchInitialView();
    toast(`recovered ${username}`, "ok");
  } catch (e) {
    toast(`recover failed: ${e.message ?? e}`, "err");
  }
}

export function initBootstrapView() {
  $("bootstrap-go")?.addEventListener("click", handleBootstrap);
  $("bootstrap-recover")?.addEventListener("click", handleRecover);
}
