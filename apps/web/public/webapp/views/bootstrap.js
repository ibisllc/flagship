import { bootstrapNewIdentity } from "../keystore.js";
import { $, registerView } from "../lib/router.js";
import { unlockSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { enterHome } from "./home.js";

registerView("view-bootstrap");

async function handleBootstrap() {
  const a = $("bootstrap-passphrase").value;
  const b = $("bootstrap-passphrase-2").value;
  if (a !== b) return toast("passphrases don't match", "err");
  if (a.length < 8) return toast("passphrase must be 8+ chars", "err");
  try {
    const seed = await bootstrapNewIdentity(a);
    await unlockSession(seed);
    await enterHome();
    toast("device key generated");
  } catch (e) {
    toast(String(e), "err");
  }
}

export function initBootstrapView() {
  $("bootstrap-go")?.addEventListener("click", handleBootstrap);
}
