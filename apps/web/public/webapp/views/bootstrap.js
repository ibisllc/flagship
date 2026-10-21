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
  adoptProfileKeys,
  resetDevice,
} from "../keystore.js";
import { humanError } from "../lib/humanError.js";
import { failureText, rateLimitedError } from "../lib/rateLimited.js";
import { $, registerView, currentViewId } from "../lib/router.js";
import { dispatchInitialView } from "../lib/deepLink.js";
import { inlineConfirm, inlinePrompt, inlineSuggestUsername } from "../lib/modal.js";
import { recoverFromCloud, takeRecoveryProof } from "../lib/recovery.js";
import {
  activateDemoAccount,
  classifyResolution,
  resolveAccount,
} from "../lib/accountResolve.js";
import { accessOptions } from "../lib/accountAccess.js";
import { readNameField, readPairingField } from "../lib/connectAccount.js";
import { loginRealAccount } from "../lib/loginTakeover.js";
import { openAccount } from "../lib/openAccount.js";
import { addProfile } from "../lib/profiles.js";
import { unlockSession, getSession, lockSession } from "../lib/state.js";
import { controlApex } from "../lib/apex.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { set as profileSet } from "../lib/profilesStore.js";

import { tr } from "../lib/i18n.js";
registerView("view-bootstrap");

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/; // 3–30, interior dashes OK, no `--` (checked separately) — see packages/control-plane/src/labels.ts

// Sign-up no longer takes a chosen name — naming is random-by-default
// (docs/naming-recovery-and-name-change.md §4): a custom name is a paid change,
// later. So the cover has TWO actions: "Create your account" (→ random handle)
// and "Connect to an existing account", one page holding both ways back in:
// the account name (sign in) and a pairing code (join), as on iOS and Android.

export const NAME_RULE_ERROR =
  tr("Account names are 3 to 30 lowercase letters and digits, with single dashes inside.");

function setFieldError(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

/** Welcome ↔ the connect page (both live in view-bootstrap). */
function showConnectPanel(open) {
  $("bootstrap-welcome")?.classList.toggle("hidden", open);
  $("bootstrap-connect-panel")?.classList.toggle("hidden", !open);
  setFieldError("connect-name-error", "");
  setFieldError("connect-pair-error", "");
  if (open) {
    void import("../qrScanner.js")
      .then(({ hasBarcodeDetector }) => $("connect-scan")?.classList.toggle("hidden", !hasBarcodeDetector()))
      .catch(() => {});
    $("bootstrap-username")?.focus();
  } else {
    hideAccess();
    stopConnectScan();
  }
}

/** The pairing half: a pasted or scanned link (or bare `sid=…&pk=…`) joins. */
async function handlePairing(text) {
  const r = readPairingField(text ?? $("connect-pair-input")?.value);
  if (r.action === "none") return setFieldError("connect-pair-error", tr("Paste the pairing link, or scan the code."));
  if (r.action === "error") return setFieldError("connect-pair-error", r.error);
  setFieldError("connect-pair-error", "");
  stopConnectScan();
  const { enterJoin } = await import("./join.js");
  return enterJoin(r.link);
}

function stopConnectScan() {
  const video = $("connect-scan-video");
  const stream = video?.srcObject;
  stream?.getTracks?.().forEach((t) => t.stop());
  if (video) {
    video.srcObject = null;
    video.classList.add("hidden");
  }
}

async function scanPairingCode() {
  const btn = $("connect-scan");
  const video = $("connect-scan-video");
  if (!btn || !video) return;
  btn.disabled = true;
  btn.textContent = tr("Scanning…");
  video.classList.remove("hidden");
  setFieldError("connect-pair-error", "");
  try {
    const { scanWithCamera } = await import("../qrScanner.js");
    const raw = String(await scanWithCamera(video, { timeoutMs: 30_000 }));
    await handlePairing(raw);
  } catch {
    setFieldError("connect-pair-error", tr("Couldn't scan. Paste the pairing link instead."));
  } finally {
    stopConnectScan();
    btn.disabled = false;
    btn.textContent = tr("Scan a code");
  }
}

/** SIGN IN: resolve the typed username and branch on what the account IS —
 *  never a dead 404/"taken". Unknown → "no account by that name" (NOT sign-up;
 *  sign-up is the separate random path). Taken → the credential access options.
 *  A pairing link pasted here goes to join instead, with a note. */
async function handleContinue() {
  const field = readNameField($("bootstrap-username")?.value);
  if (field.action === "join") {
    setFieldError("connect-name-error", "");
    toast(field.note, "ok");
    const { enterJoin } = await import("./join.js");
    return enterJoin(field.link);
  }
  if (field.action === "error") return setFieldError("connect-name-error", field.error);
  const raw = field.action === "sign-in" ? field.name : "";
  if (!USERNAME_RE.test(raw) || raw.includes("--")) {
    setFieldError("connect-name-error", NAME_RULE_ERROR);
    return toast(NAME_RULE_ERROR, "err");
  }
  setFieldError("connect-name-error", "");
  hideAccess();
  let resolution;
  try {
    resolution = await resolveAccount(raw);
  } catch (e) {
    return toast(failureText(e, tr("Couldn't reach the directory: ")), "err");
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
    title: tr("No account by that name"),
    message: tr("We couldn't find an account called \"{0}\". Check the spelling, or create a new account (you'll get a free random handle).", username),
    okLabel: tr("OK"),
    cancelLabel: tr("Back"),
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
  const limited = rateLimitedError(r.status, body, r.headers?.get?.("retry-after"));
  if (limited) throw limited;
  if (r.status === 429) {
    return { throttled: true, retryAfterMs: Number(body.retryAfterMs) || 3000 };
  }
  if (!r.ok || typeof body.name !== "string") {
    throw new Error(`couldn't get a handle (HTTP ${r.status})`);
  }
  return { name: body.name, retryAfterMs: Number(body.retryAfterMs) || 2000 };
}

/** Sign-up cancelled before an account was opened: drop the key it just made,
 *  so this browser is back at the cover rather than holding a key that
 *  belongs to no account. */
async function abandonNewKey() {
  try {
    await resetDevice();
  } catch {
    /* nothing stored */
  }
  lockSession();
}

/** CREATE ACCOUNT: a free, random, dashless handle. Passphrase → device key →
 *  fetch candidates → shuffle/accept → claim that EXACT name (no free-text edit,
 *  so a custom name stays a paid change) → on to the recovery step. */
async function createAccount() {
  const pass = await inlinePrompt({
    title: tr("Create your account"),
    message:
      tr("Choose a passphrase (8+ chars). It encrypts your key in this browser — flagshipserver.com never sees it."),
    placeholder: "passphrase",
    type: "password",
    validate: (v) => (!v || v.length < 8 ? "8+ characters" : null),
  });
  if (!pass) return;
  const confirm = await inlinePrompt({
    title: tr("Confirm passphrase"),
    message: tr("Type it again."),
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
    return toast(failureText(e), "err");
  }
  const chosen = await inlineSuggestUsername({
    initialName: first.name,
    retryAfterMs: first.retryAfterMs,
    fetchNext: () => fetchSuggestion(deviceKey),
  });
  if (!chosen) return abandonNewKey(); // cancelled

  const suggestedAccountName = chosen.split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
  const accountDisplayName = await inlinePrompt({
    title: tr("Name this account"),
    message: tr("This private name appears above @{0} and is never used in links.", chosen),
    placeholder: tr("Account name"),
    initial: suggestedAccountName,
    validate: (v) => (!v?.trim() ? tr("Enter an account name") : null),
  });
  if (!accountDisplayName) return abandonNewKey();
  const deviceDisplayName = await inlinePrompt({
    title: tr("Name this device"),
    message: tr("This private name applies only inside this Flagship account."),
    placeholder: tr("This browser"),
    initial: tr("This browser"),
    validate: (v) => (!v?.trim() ? tr("Enter a device name") : null),
  });
  if (!deviceDisplayName) return abandonNewKey();

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
      adoptProfileKeys,
      // Asked only when there is no key to carry onto the profile.
      prompt: inlinePrompt,
      persistSeedForProfile,
      addProfile,
      accountDisplayName,
      deviceDisplayName,
      // No dispatchInitialView — route into the recovery step (a backup is
      // required; the wizard owns that flow, then the app shell).
    });
    toast(tr("Account created — {0}", chosen), "ok");
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
    `<p class="note">${tr("\"<strong>{0}</strong>\" already exists — that's an account. How do you want to get back in?", escapeHtml(resolution.username))}</p>` +
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
      // The pairing half is on this same page.
      const input = $("connect-pair-input");
      input?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      input?.focus();
      return;
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
    toast(tr("Joined {0}", resolution.username), "ok");
  } catch (e) {
    toast(tr("Couldn't open the demo: {0}", e.message ?? e), "err");
  }
}

/** Phase 3 — the real-account (single/multi) login state machine. Drives
 *  the credentialed JOIN off the resolution:
 *    - recovery.present == false → a clean inline STATE (not a 404).
 *    - single → cloud-recovery unwrap → 7-day-grace TAKEOVER → re-pair
 *               initiated → this device gets a fresh opaque deviceId.
 *    - multi  → unwrap + a recovery TOTP / recovery code (the Worker
 *               REQUIRES it for account_type=multi) → 24h-grace TAKEOVER.
 *  (Real WebAuthn-PRF: `recoverFromCloud` is the recovery sub-origin
 *  popup flow. Grace countdown/completion/push/quarantine are
 *  Phase 4.) */
async function recoverRealAccount(resolution) {
  const username = resolution.username;
  try {
    const result = await loginRealAccount(resolution, {
      showState: (state) =>
        inlineConfirm({
          title: state.title,
          message: state.message,
          okLabel: tr("OK"),
          cancelLabel: tr("Back"),
        }),
      confirm: (opts) => inlineConfirm(opts),
      prompt: (opts) => inlinePrompt(opts),
      takeoverDeps: {
        recoverFromCloud,
        // `.com`'s attestation that the unwrap above cleared the
        // recovery passphrase gate. The re-pair initiate is refused
        // without a credential, and on a single-device account this is
        // the one the user has.
        takeRecoveryProof,
        // The registered-key proof (we hold the recovered seed), sent
        // alongside it — see runTakeover.
        signWithIrk,
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
      toast(tr("Taking over {0} — you're now the admin device", username), "ok");
    }
  } catch (e) {
    toast(failureText(e, tr("Couldn't take over {0}: ", username)), "err");
  }
}

export function initBootstrapView() {
  $("bootstrap-create")?.addEventListener("click", createAccount);
  $("bootstrap-connect")?.addEventListener("click", () => showConnectPanel(true));
  $("connect-back")?.addEventListener("click", () => showConnectPanel(false));
  $("bootstrap-continue")?.addEventListener("click", handleContinue);
  $("bootstrap-username")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleContinue();
    }
  });
  $("bootstrap-username")?.addEventListener("input", () => setFieldError("connect-name-error", ""));
  $("connect-pair-continue")?.addEventListener("click", () => handlePairing());
  $("connect-pair-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handlePairing();
    }
  });
  $("connect-pair-input")?.addEventListener("input", () => setFieldError("connect-pair-error", ""));
  $("connect-scan")?.addEventListener("click", scanPairingCode);
  // Every arrival on the cover (boot, sign-out, a new profile) starts at the
  // two choices; leaving it stops the camera.
  document.addEventListener("flagship:view-shown", (e) => {
    if (e.detail?.id === "view-bootstrap") showConnectPanel(false);
    else if (currentViewId() !== "view-bootstrap") stopConnectScan();
  });
}
