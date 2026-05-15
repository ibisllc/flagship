import { bootstrapNewIdentity, bootstrapFromExistingSeed } from "../keystore.js";
import { $, registerView } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { inlinePrompt } from "../lib/modal.js";
import { recoverFromCloud } from "../lib/recovery.js";
import { unlockSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";

registerView("view-bootstrap");

const USERNAME_RE = /^[a-z0-9]{1,63}$/; // no hyphens — see packages/control-plane/src/labels.ts

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
  // #30 — three inline-modal steps replace three window.prompts. We
  // keep them as a sequence (rather than one combined form) so the
  // user can cancel between steps without losing their place.
  const username = await inlinePrompt({
    title: "Recover account",
    message: "Username on the account you're recovering.",
    placeholder: "alice",
    validate: (v) => {
      if (!v) return "username required";
      if (!USERNAME_RE.test(v)) return "lowercase letters and digits only";
      return null;
    },
  });
  if (!username) return;
  const passA = await inlinePrompt({
    title: "New local passphrase",
    message: "Encrypts the recovered key on this browser. 8+ characters.",
    type: "password",
    placeholder: "passphrase",
    validate: (v) => {
      if (!v || v.length < 8) return "passphrase must be 8+ chars";
      return null;
    },
  });
  if (!passA) return;
  const passB = await inlinePrompt({
    title: "Confirm passphrase",
    type: "password",
    placeholder: "passphrase",
    validate: (v) => (v === passA ? null : "passphrases don't match"),
  });
  if (!passB) return;
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
