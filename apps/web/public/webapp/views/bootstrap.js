import {
  bootstrapNewIdentity,
  bootstrapFromExistingSeed,
  deriveIrkFromSeed,
  deriveIrkVersioned,
  signWithIrkVersioned,
  setActiveKeystoreProfile,
} from "../keystore.js";
import { humanError } from "../lib/humanError.js";
import { $, registerView } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { inlineConfirm, inlinePrompt } from "../lib/modal.js";
import { recoverFromCloud } from "../lib/recovery.js";
import {
  activateDemoAccount,
  classifyResolution,
  resolveAccount,
} from "../lib/accountResolve.js";
import { accessOptions } from "../lib/accountAccess.js";
import { loginRealAccount } from "../lib/loginTakeover.js";
import { addProfile } from "../lib/profiles.js";
import { unlockSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { set as profileSet } from "../lib/profilesStore.js";

registerView("view-bootstrap");

const USERNAME_RE = /^[a-z0-9]{3,30}$/; // 3–30, no hyphens — see packages/control-plane/src/labels.ts

/**
 * The unified cover (docs/login-and-account-redesign.md): ONE username field.
 * Resolve it, then branch on what the account IS — never a dead 404/"taken":
 *   - free      → sign up (claim this name)
 *   - demo      → join the sandbox
 *   - taken     → show EVERY way to get back in (recover / scan / keyfile /
 *                 claim-with-a-wait), unsupported ones disabled + explained.
 */
async function handleContinue() {
  const raw = ($("bootstrap-username")?.value || "").trim().toLowerCase();
  if (!USERNAME_RE.test(raw)) {
    return toast("username: 3–30 lowercase letters and digits, no hyphens", "err");
  }
  hideAccess();
  let resolution;
  try {
    resolution = await resolveAccount(raw);
  } catch (e) {
    // A throw here is a genuine transport/server failure (rate-limit, 5xx) —
    // NOT a missing account (a miss is `kind:"unknown"` in a 200 body).
    return toast(`couldn't reach the directory: ${e.message ?? e}`, "err");
  }
  switch (classifyResolution(resolution)) {
    case "demo":
      return joinDemo(resolution);
    case "unknown":
      return signUp(raw); // the name is FREE → create it
    default:
      return showAccessOptions(resolution); // the name is TAKEN → how to get in
  }
}

/** FREE name → create the account. Username-first: the name is already chosen,
 *  so collect the passphrase now (it used to live on the cover), generate the
 *  device key, then hand the wizard the chosen name to claim + finish setup. */
async function signUp(username) {
  const pass = await inlinePrompt({
    title: `Create "${username}"`,
    message:
      "Choose a passphrase (8+ chars). It encrypts your key in this browser — flagshipserver.com never sees it.",
    placeholder: "passphrase",
    type: "password",
    validate: (v) => (!v || v.length < 8 ? "8+ characters" : null),
  });
  if (!pass) return;
  const confirm = await inlinePrompt({
    title: "Confirm passphrase",
    message: "Type it again.",
    placeholder: "passphrase",
    type: "password",
    validate: (v) => (v !== pass ? "passphrases don't match" : null),
  });
  if (confirm == null) return;
  try {
    const seed = await bootstrapNewIdentity(pass);
    await unlockSession(seed);
    toast("device key generated");
    // Hand the wizard the already-chosen name so the user doesn't retype it.
    try {
      const { enterWizard } = await import("./wizard.js");
      await enterWizard({ step: "username" });
      const field = document.getElementById("wizard-username-input");
      if (field) {
        field.value = username;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch {
      await dispatchInitialView();
    }
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
}

/** TAKEN name → render all four access pathways (enabled/disabled+explained)
 *  inline, and route the pick to its existing flow. This is the fix for the
 *  old dead-end: entering your own name now offers recovery, not "try another". */
function showAccessOptions(resolution) {
  const host = $("bootstrap-access");
  if (!host) return;
  const opts = accessOptions(resolution);
  host.innerHTML =
    `<p class="note">"<strong>${escapeHtml(resolution.username)}</strong>" already exists — that's an account. How do you want to get back in?</p>` +
    opts
      .map(
        (o) => `
      <button class="full-width mt-2${o.enabled ? "" : " secondary"}" data-access="${o.id}"${o.enabled ? "" : " disabled"}>
        ${escapeHtml(o.label)}
      </button>
      <p class="note muted-sm">${escapeHtml(o.enabled ? o.sublabel : o.disabledReason || o.sublabel)}</p>`,
      )
      .join("");
  host.classList.remove("hidden");
  for (const btn of host.querySelectorAll("[data-access]:not([disabled])")) {
    btn.addEventListener("click", () =>
      dispatchAccess(btn.getAttribute("data-access"), resolution),
    );
  }
}

function hideAccess() {
  const host = $("bootstrap-access");
  if (host) {
    host.classList.add("hidden");
    host.innerHTML = "";
  }
}

/** Route a chosen access pathway to its existing flow. */
async function dispatchAccess(id, resolution) {
  switch (id) {
    case "recover":
      // The credentialed login state machine (cloud-recovery unwrap). There is
      // no no-credential fallback — naming is self-custody.
      return recoverRealAccount(resolution);
    case "keyfile": {
      const { enterRecovery } = await import("./recovery.js");
      return enterRecovery();
    }
    case "scan": {
      const link = await inlinePrompt({
        title: "Scan a pairing code",
        message:
          "On a device that's already signed in, open Settings → Add device, then paste the pairing link it shows here.",
        placeholder: "https://flagshipserver.com/join?…",
      });
      if (!link) return;
      const { enterJoin } = await import("./join.js");
      return enterJoin(link);
    }
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
      // L4 — let the user pick how this recovered device relates to their
      // other devices (parity with iOS PostRecoveryChoiceScreen). Wipe &
      // restart stays a v1.1 path (dimmed "Coming soon"), so this resolves
      // only keep-both or replace-lost.
      chooseDisposition: async () => {
        const { enterPostRecoveryChoice } = await import("./post-recovery-choice.js");
        return enterPostRecoveryChoice({ wipeAndRestartEnabled: false });
      },
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
    } else if (result.outcome === "keep-both") {
      toast(`recovered ${username} — your other devices stay connected`, "ok");
    }
  } catch (e) {
    toast(`couldn't take over ${username}: ${e.message ?? e}`, "err");
  }
}

export function initBootstrapView() {
  $("bootstrap-continue")?.addEventListener("click", handleContinue);
  $("bootstrap-username")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleContinue();
    }
  });
}
