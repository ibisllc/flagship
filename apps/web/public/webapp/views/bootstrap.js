import {
  bootstrapNewIdentity,
  bootstrapFromExistingSeed,
  deriveIrkFromSeed,
  deriveIrkVersioned,
  signWithIrkVersioned,
  setActiveKeystoreProfile,
} from "../keystore.js";
import { $, registerView } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { inlineConfirm, inlinePrompt } from "../lib/modal.js";
import { recoverFromCloud } from "../lib/recovery.js";
import {
  activateDemoAccount,
  classifyResolution,
  resolveAccount,
} from "../lib/accountResolve.js";
import { loginRealAccount } from "../lib/loginTakeover.js";
import { addProfile } from "../lib/profiles.js";
import { unlockSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { set as profileSet } from "../lib/profilesStore.js";

registerView("view-bootstrap");

const USERNAME_RE = /^[a-z0-9]{3,30}$/; // 3–30, no hyphens — see packages/control-plane/src/labels.ts

async function handleBootstrap() {
  const a = $("bootstrap-passphrase").value;
  const b = $("bootstrap-passphrase-2").value;
  if (a !== b) return toast("passphrases don't match", "err");
  if (a.length < 8) return toast("passphrase must be 8+ chars", "err");
  try {
    const seed = await bootstrapNewIdentity(a);
    await unlockSession(seed);
    toast("device key generated");
    // Phase 2 (docs/login-and-account-redesign.md): generating a device
    // key is NOT opening an account. The account is an identity — the
    // user must still claim a username (bound to this device key) before
    // they have an account. Route through the first-run wizard, which
    // advances from the (now-complete) device-key step straight to the
    // OPEN-ACCOUNT step. Server provisioning is separate + later. If the
    // wizard isn't on disk, fall back to the normal app shell.
    try {
      const { enterWizard } = await import("./wizard.js");
      await enterWizard({ step: "username" });
    } catch {
      await dispatchInitialView();
    }
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
      if (!USERNAME_RE.test(v)) return "3–30 lowercase letters and digits, no hyphens";
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
      return recoverRealAccount(resolution);
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
      setActiveKeystoreProfile,
      unlockSession,
      addProfile,
      dispatchInitialView,
      setUsername: (u) => profileSet("username", u),
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

/** Phase 3 — the real-account (single/multi) login state machine. Drives
 *  the credentialed JOIN off the resolution:
 *    - recovery.present == false → a clean inline STATE (not a 404).
 *    - single → cloud-recovery unwrap → 7-day-grace TAKEOVER → re-pair
 *               initiated → this device labelled "admin".
 *    - multi  → unwrap + a recovery TOTP / recovery code (the Worker
 *               REQUIRES it for account_type=multi) → 24h-grace TAKEOVER
 *               → "admin".
 *  (Mock/popup WebAuthn as today: `recoverFromCloud` is the existing
 *  sub-origin flow. Grace countdown/completion/push/quarantine are
 *  Phase 4.) */
async function recoverRealAccount(resolution) {
  const username = resolution.username;
  try {
    const result = await loginRealAccount(resolution, {
      showState: (state) =>
        inlineConfirm({
          title: state.title,
          message: state.message,
          okLabel: "OK",
          cancelLabel: "Back",
        }),
      confirm: (opts) => inlineConfirm(opts),
      prompt: (opts) => inlinePrompt(opts),
      takeoverDeps: {
        recoverFromCloud,
        // Multi-profile keying: point the keystore at the account being
        // taken over BEFORE the recovered seed is wrapped, so it lands
        // under that account's own record (never clobbers another profile).
        setActiveKeystoreProfile,
        bootstrapFromExistingSeed,
        unlockSession,
        deriveIrkFromSeed,
        deriveIrkVersioned,
        signWithIrkVersioned,
        addProfile: (profile) => addProfile(profile),
        dispatchInitialView,
        setUsername: (u) => profileSet("username", u),
      },
    });
    if (result.outcome === "takeover") {
      toast(`taking over ${username} — you're now the admin device`, "ok");
    }
  } catch (e) {
    toast(`couldn't take over ${username}: ${e.message ?? e}`, "err");
  }
}

export function initBootstrapView() {
  $("bootstrap-go")?.addEventListener("click", handleBootstrap);
  $("bootstrap-recover")?.addEventListener("click", handleRecover);
}
