import { bootstrapNewIdentity, bootstrapFromExistingSeed } from "../keystore.js";
import { $, registerView } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { inlineConfirm, inlinePrompt } from "../lib/modal.js";
import { recoverFromCloud } from "../lib/recovery.js";
import {
  activateDemoAccount,
  classifyResolution,
  resolveAccount,
} from "../lib/accountResolve.js";
import { addProfile } from "../lib/profiles.js";
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
  // Account-name-first JOIN (docs/login-and-account-redesign.md). The
  // login field holds ONLY a bare username — a person/company handle,
  // letters/digits, no dots. We then run a single preflight
  // (GET /api/account/resolve) and branch on what the account IS, not on
  // an HTTP status. Login NEVER surfaces a 404: every "absent" is a node
  // in the decision tree.
  const username = await inlinePrompt({
    title: "Join an account",
    message: "The username on the account you're joining.",
    placeholder: "alice",
    validate: (v) => {
      if (!v) return "username required";
      if (!USERNAME_RE.test(v)) return "lowercase letters and digits only";
      return null;
    },
  });
  if (!username) return;

  let resolution;
  try {
    resolution = await resolveAccount(username);
  } catch (e) {
    // A throw here is a genuine transport/server failure (rate-limit,
    // 5xx) — NOT a missing account. A miss is `kind:"unknown"` in a 200
    // body, handled below.
    return toast(`couldn't reach the directory: ${e.message ?? e}`, "err");
  }

  switch (classifyResolution(resolution)) {
    case "demo":
      return joinDemo(resolution);
    case "unknown":
      return showNoSuchAccount(username);
    default:
      return recoverRealAccount(username);
  }
}

/** Demo = special-case recovery whose crypto checks are no-ops: knowing
 *  the username is the entire capability. No passkey, no recovery popup,
 *  no passphrase prompts — just attach a fresh device and open the
 *  sandbox. */
async function joinDemo(resolution) {
  try {
    await activateDemoAccount(resolution, {
      bootstrapNewIdentity,
      unlockSession,
      addProfile,
      dispatchInitialView,
      setUsername: (u) => localStorage.setItem("flagship.username", u),
    });
    toast(`joined ${resolution.username}`, "ok");
  } catch (e) {
    toast(`couldn't open the demo: ${e.message ?? e}`, "err");
  }
}

/** A miss is a STATE, not a 404 — render clear guidance, not an error. */
async function showNoSuchAccount(username) {
  await inlineConfirm({
    title: "No Flagship account by that name",
    message: `We couldn't find an account called "${username}". Check the spelling, or generate a new account instead.`,
    okLabel: "OK",
    cancelLabel: "Back",
  });
}

/** Phase 1 keeps the EXISTING credentialed recovery flow for real
 *  (single/multi) accounts. Phase 3 replaces this with the full login
 *  state machine (passkey-PRF unwrap → TOTP → backup-vs-takeover). */
async function recoverRealAccount(username) {
  // #30 — inline-modal steps replace window.prompts. We keep them as a
  // sequence so the user can cancel between steps without losing place.
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
