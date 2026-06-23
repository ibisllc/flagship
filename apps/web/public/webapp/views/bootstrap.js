import {
  bootstrapNewIdentity,
  bootstrapFromExistingSeed,
  deriveIrkFromSeed,
  deriveIrkVersioned,
  signWithIrkVersioned,
  setActiveKeystoreProfile,
  signWithIrk,
  bytesToHex,
  persistSeedForProfile,
} from "../keystore.js";
import { humanError } from "../lib/humanError.js";
import { $, registerView } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { inlineConfirm, inlinePrompt, inlineSuggestUsername } from "../lib/modal.js";
import { recoverFromCloud } from "../lib/recovery.js";
import {
  activateDemoAccount,
  classifyResolution,
  resolveAccount,
} from "../lib/accountResolve.js";
import { accessOptions } from "../lib/accountAccess.js";
import { loginRealAccount } from "../lib/loginTakeover.js";
import { openAccount } from "../lib/openAccount.js";
import { addProfile } from "../lib/profiles.js";
import { unlockSession, getSession } from "../lib/state.js";
import { controlApex } from "../lib/apex.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { set as profileSet } from "../lib/profilesStore.js";

registerView("view-bootstrap");

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/; // 3–30, interior dashes OK, no `--` (checked separately) — see packages/control-plane/src/labels.ts

// Sign-up no longer takes a chosen name — naming is random-by-default
// (docs/naming-recovery-and-name-change.md §4): a custom name is a paid change,
// later. So the cover has TWO actions: "Create account" (→ random handle) and a
// username field that is SIGN-IN only.

/** SIGN IN: resolve the typed username and branch on what the account IS —
 *  never a dead 404/"taken". Unknown → "no account by that name" (NOT sign-up;
 *  sign-up is the separate random path). Taken → the credential access options. */
async function handleContinue() {
  const raw = ($("bootstrap-username")?.value || "").trim().toLowerCase();
  if (!USERNAME_RE.test(raw) || raw.includes("--")) {
    return toast("username: 3–30 lowercase letters/digits with interior single dashes", "err");
  }
  hideAccess();
  let resolution;
  try {
    resolution = await resolveAccount(raw);
  } catch (e) {
    return toast(`couldn't reach the directory: ${e.message ?? e}`, "err");
  }
  switch (classifyResolution(resolution)) {
    case "demo":
      return joinDemo(resolution);
    case "unknown":
      return showNoSuchAccount(raw);
    default:
      return showAccessOptions(resolution); // taken → credential access options
  }
}

/** A miss is a STATE, not a 404 — clear guidance, and a nudge to create. */
async function showNoSuchAccount(username) {
  await inlineConfirm({
    title: "No account by that name",
    message: `We couldn't find an account called "${username}". Check the spelling, or create a new account (you'll get a free random handle).`,
    okLabel: "OK",
    cancelLabel: "Back",
  });
}

/** A throwaway per-sign-up device id, just for the regenerate throttle (the
 *  real IRK isn't the rate-limit key — see docs/username-suggestion-queue.md). */
function newSuggestDeviceKey() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Ask the server for ONE random handle. Returns `{ name, retryAfterMs }`, or
 *  `{ throttled: true, retryAfterMs }` when regenerating too fast. */
async function fetchSuggestion(deviceKey) {
  const r = await fetch(`${controlApex()}/api/username/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceKey }),
    cache: "no-store",
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 429) {
    return { throttled: true, retryAfterMs: Number(body.retryAfterMs) || 3000 };
  }
  if (!r.ok || typeof body.name !== "string") {
    throw new Error(`couldn't get a handle (HTTP ${r.status})`);
  }
  return { name: body.name, retryAfterMs: Number(body.retryAfterMs) || 2000 };
}

/** CREATE ACCOUNT: a free, random, dashless handle. Passphrase → device key →
 *  fetch candidates → shuffle/accept → claim that EXACT name (no free-text edit,
 *  so a custom name stays a paid change) → on to the recovery step. */
async function createAccount() {
  const pass = await inlinePrompt({
    title: "Create your account",
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

  let seed;
  try {
    seed = await bootstrapNewIdentity(pass);
    await unlockSession(seed);
  } catch (e) {
    console.error(e);
    return toast(humanError(e), "err");
  }

  // Hand them ONE random handle + a (rate-limited) regenerate button. No
  // free-text field — a custom name is the paid name-change.
  const deviceKey = newSuggestDeviceKey();
  let first;
  try {
    first = await fetchSuggestion(deviceKey);
  } catch (e) {
    return toast(e.message ?? String(e), "err");
  }
  const chosen = await inlineSuggestUsername({
    initialName: first.name,
    retryAfterMs: first.retryAfterMs,
    fetchNext: () => fetchSuggestion(deviceKey),
  });
  if (!chosen) return; // cancelled

  // Claim that EXACT name (idempotent, IRK-signed). No editable field, so a
  // free custom name is impossible — that's the paid name-change.
  try {
    const session = getSession();
    await openAccount(chosen, {
      session,
      signWithIrk,
      bytesToHex,
      setUsername: (u) => {
        try { profileSet("username", u); } catch { /* swallow */ }
        session.username = u;
      },
      persistSeedForProfile,
      addProfile,
      // No dispatchInitialView — route into the recovery step (a backup is
      // required; the wizard owns that flow, then the app shell).
    });
    toast(`account created — ${chosen}`, "ok");
    try {
      const { enterWizard } = await import("./wizard.js");
      await enterWizard({ step: "secure-account" });
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
  $("bootstrap-create")?.addEventListener("click", createAccount);
  $("bootstrap-continue")?.addEventListener("click", handleContinue);
  $("bootstrap-username")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleContinue();
    }
  });
}
