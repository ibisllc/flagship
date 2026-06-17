/**
 * First-run wizard (#25) + peer-backup opt-in step (#95).
 *
 * Gates on "no servers yet" — once a user has at least one paired
 * server, the wizard never re-enters. The 6 steps (and the peer-backup
 * prompt sandwiched at step 6.5) tie together existing webapp screens
 * via small handoff helpers, so this module stays focused on the
 * orchestration: which step the user is on, where to navigate next,
 * and the persistent warning banner for skipped recovery setup.
 *
 * Steps:
 *   1. Generate device key   (delegates to bootstrap.js when no IRK)
 *   2. Open your account      (claim a username = reserve an identity,
 *                              bind the device key — NO server yet)
 *   3. Recovery passphrase    (skippable, but pins a warning banner)
 *   4. WebAuthn-PRF cloud rec (skippable, same warning)
 *   5. Add your first server  (jumps to create-server.js — optional,
 *                              repeatable; the account is already open)
 *   6. Peer-backup opt-in     (#95 — yes/no/maybe-later, persisted)
 *   7. Finish / explore       (optional — add services any time)
 *
 * Phase 2 (docs/login-and-account-redesign.md) decouples account
 * creation from server provisioning: step 2 OPENS the account (standalone
 * idempotent claim + device-key bind) so the user lands in the app with
 * zero servers; the server (step 5) is separate, later, and repeatable.
 *
 * The wizard module is dynamic-imported from home.js's empty-state
 * CTA so it doesn't bloat first paint.
 */

import { registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { signWithIrk, bytesToHex, persistSeedForProfile } from "../keystore.js";
import { isValidUsername, openAccount } from "../lib/openAccount.js";
import { checkUsername } from "../lib/usersCheck.js";
import { trademarkClaimMailto } from "../lib/trademarkClaim.js";
import { addProfile } from "../lib/profiles.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import {
  get as profileGet,
  set as profileSet,
  remove as profileRemove,
} from "../lib/profilesStore.js";

registerView("view-wizard");

// `wizardState` is marked device-wide-or-pre-profile in profilesStore.js —
// the wizard runs BEFORE a profile is active (step 1 = device-key, step 2 =
// open-account). The store routes those writes through the legacy flat key
// while still surfacing under the per-profile slot once a username is claimed.
const WIZARD_STATE_KEY = "flagship.wizard.state.v1";
// Documentation-pin: home.js + the homeRecoveryBanner static-source test
// assert that BOTH files reference the same recovery-warn key string. The
// runtime read/write now goes through profileGet/profileSet on the
// "recoveryWarn" slot (legacy key is "flagship.recovery.warn.v1").
const RECOVERY_WARN_KEY = "flagship.recovery.warn.v1";
const PEER_BACKUP_CHOICE_KEY = "flagship.peerBackup.choice.v1";
void WIZARD_STATE_KEY; void RECOVERY_WARN_KEY; void PEER_BACKUP_CHOICE_KEY;

const STEPS = [
  { id: "device-key", label: "Generate device key" },
  { id: "username", label: "Open your account" },
  { id: "secure-account", label: "Secure your account", skippable: true },
  { id: "passphrase", label: "Set recovery passphrase", skippable: true },
  { id: "webauthn-recovery", label: "Cloud recovery (WebAuthn)", skippable: true },
  { id: "create-server", label: "Add your first server" },
  { id: "peer-backup", label: "Help others (peer-backup)", skippable: true },
  { id: "demo-app", label: "Try a demo app", skippable: true },
];

/**
 * Passkey availability gate for the "Secure your account" step. Cloud
 * backup (lib/recovery.js setupCloudRecovery) wraps the UMK under a
 * WebAuthn passkey's PRF output, so it's only offerable when the browser
 * exposes the WebAuthn credential API at all. We detect gracefully — a
 * missing API means we DON'T pre-select cloud and disable its option,
 * but the file path + skip still work, so the step never blocks.
 */
export function passkeysAvailable() {
  try {
    return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
  } catch {
    return false;
  }
}

function loadState() {
  try {
    const raw = profileGet("wizardState");
    if (!raw) return { stepIdx: 0, completed: [] };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { stepIdx: 0, completed: [] };
    return { stepIdx: Number(parsed.stepIdx) || 0, completed: Array.isArray(parsed.completed) ? parsed.completed : [] };
  } catch {
    return { stepIdx: 0, completed: [] };
  }
}

function saveState(state) {
  try {
    profileSet("wizardState", JSON.stringify(state));
  } catch { /* localStorage full / disabled */ }
}

/**
 * Public entry point. Caller passes an initial step hint (e.g.
 * "create-server" when the user hits "Create a server" from the
 * empty state). The wizard advances to that step or to the user's
 * resume point, whichever is later.
 */
export async function enterWizard(opts = {}) {
  const state = loadState();
  if (opts.step) {
    const idx = STEPS.findIndex((s) => s.id === opts.step);
    if (idx >= 0 && idx > state.stepIdx) state.stepIdx = idx;
  }
  saveState(state);
  await renderStep(state);
}

/**
 * Step 2 — OPEN THE ACCOUNT (Phase 2). Reads the typed username, runs
 * the standalone idempotent claim (binding it to this device's IRK), and
 * persists the identity locally. It does NOT navigate — the wizard owns
 * the next step (recovery), so we pass no `dispatchInitialView`. Returns
 * true on success so the caller advances; false (with a toast already
 * shown) keeps the user on the step to fix the input.
 */
/** Show / hide the "name taken" panel, which carries the trademark
 *  claim affordance. Hidden when `username` is null. */
function renderTakenState(username) {
  const panel = document.getElementById("wizard-username-taken");
  if (!panel) return;
  if (!username) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  const mailto = trademarkClaimMailto(username);
  panel.innerHTML = `
    <p>The name <strong>${escapeHtml(username)}</strong> is already taken. Try another.</p>
    <p class="muted-sm">Hold a registered trademark to this name?
      <a id="wizard-trademark-claim" href="${mailto}">I hold a trademark to this name</a>.</p>
  `;
  panel.classList.remove("hidden");
}

async function handleOpenAccount() {
  const input = document.getElementById("wizard-username-input");
  const username = (input?.value || "").trim().toLowerCase();
  renderTakenState(null); // clear any prior taken-state on a fresh attempt
  if (!isValidUsername(username)) {
    toast("username must be 3–30 lowercase letters and digits, no hyphens", "err");
    input?.focus();
    return false;
  }
  const session = getSession();
  if (!session.umk || !session.irk) {
    toast("generate a device key first", "err");
    return false;
  }
  const btn = document.getElementById("wizard-go-username");
  if (btn) btn.disabled = true;
  // Pre-flight availability so a taken name renders the dedicated
  // taken-state (with the trademark-claim link) instead of a generic
  // toast. A network hiccup here is non-fatal — the claim below is the
  // authoritative gate and is idempotent.
  try {
    const avail = await checkUsername(username);
    if (avail && avail.available === false) {
      renderTakenState(username);
      if (btn) btn.disabled = false;
      input?.focus();
      return false;
    }
  } catch {
    // ignore — fall through to the claim, which is authoritative.
  }
  try {
    await openAccount(username, {
      session,
      signWithIrk,
      bytesToHex,
      setUsername: (u) => {
        // `username` is device-wide-or-pre-profile → profileSet also writes
        // the legacy flat key (which keystore.js and a few boot consumers
        // still read).
        try { profileSet("username", u); } catch { /* swallow */ }
        session.username = u;
      },
      // Multi-profile keying: store the session UMK under THIS account's
      // own keystore record so a second account never clobbers the first.
      persistSeedForProfile,
      addProfile,
      // No dispatchInitialView — the wizard advances to the recovery
      // step itself. The account is open; the app shell comes after the
      // remaining (skippable) wizard steps.
    });
    toast(`account opened — ${username}`, "ok");
    return true;
  } catch (e) {
    const msg = String(e.message || e);
    // A claim that comes back "already claimed" (409 from a DIFFERENT
    // IRK) is the taken-name case — render the dedicated state with the
    // trademark-claim link rather than a bare toast.
    if (/already claimed|409|conflict/i.test(msg)) {
      renderTakenState(username);
    } else {
      toast(msg, "err");
    }
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Act on the "Secure your account" step's selected option, reusing the
 * existing recovery primitives (we never rebuild backup crypto here):
 *   - cloud → lib/recovery.js setupCloudRecovery (WebAuthn-PRF passkey)
 *   - file  → the lib/keyfileBackup.js export ceremony
 * Returns true once the chosen backup actually completed, false if it
 * failed or the user cancelled (so the caller keeps them on the step).
 */
async function handleSecureAccount() {
  const session = getSession();
  if (!session.umk || !session.irk) {
    toast("open your account first", "err");
    return false;
  }
  const username =
    session.username || profileGet("username") || "";
  const cloud = document.getElementById("wizard-secure-cloud");
  const useCloud = !!(cloud && cloud.checked && !cloud.disabled);
  const btn = document.getElementById("wizard-secure-continue");
  if (btn) btn.disabled = true;
  try {
    if (useCloud) {
      const { setupCloudRecovery } = await import("../lib/recovery.js");
      await setupCloudRecovery(username);
      toast(`cloud backup on for ${username}`, "ok");
      return true;
    }
    // File path: run the same `.flagshipkey` export ceremony the
    // Recovery view uses (heavy warnings + strong passphrase + acks).
    const { runKeyfileExportCeremony } = await import("./recovery.js");
    const saved = await runKeyfileExportCeremony();
    return saved === true;
  } catch (e) {
    toast(`backup failed: ${e?.message ?? e}`, "err");
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function renderStep(state) {
  const step = STEPS[state.stepIdx];
  if (!step) {
    // Wizard complete.
    show("view-home");
    return;
  }
  const root = document.getElementById("view-wizard");
  if (!root) return;
  root.innerHTML = wizardChrome(state, step) + (await renderStepBody(state, step));
  show("view-wizard");
  wireStepHandlers(state, step);
}

function wizardChrome(state, currentStep) {
  const dots = STEPS.map((s, i) => {
    let cls = "wizard-dot";
    if (i < state.stepIdx) cls += " done";
    if (i === state.stepIdx) cls += " current";
    if (state.completed.includes(s.id)) cls += " done";
    return `<span class="${cls}" title="${s.label}"></span>`;
  }).join("");
  return `
    <div class="card wizard-shell">
      <div class="wizard-progress">
        <div class="wizard-step-count muted-sm">step ${state.stepIdx + 1} of ${STEPS.length}</div>
        <div class="wizard-dots">${dots}</div>
      </div>
      <h2 class="card-title">${currentStep.label}</h2>
      <div id="wizard-body" class="stack-md"></div>
    </div>
  `;
}

async function renderStepBody(state, step) {
  // Each step's body delegates to the existing view that owns the
  // logic. The wizard just provides the chrome + "next" handoff.
  switch (step.id) {
    case "device-key":
      return `
        <p class="note">Your device key never leaves this browser. We use it to sign every
        message your server trusts.</p>
        <div class="btn-row-sm">
          <button id="wizard-go-bootstrap" class="pill primary">Generate</button>
        </div>
      `;
    case "username":
      return `
        <p class="note">Your account is an identity, not a server. Claiming a handle
        reserves your name and binds it to this device's key — that <em>is</em> your
        account. A server comes later (and you can run zero, one, or many). The handle
        is a routing label, not a profile — be as pseudonymous as you want; the server
        never stores any real-world identity attribute
        (<a href="https://flagshipserver.com/security.html#no-kyc">why</a>).</p>
        <label class="field-label" for="wizard-username-input">Username</label>
        <input id="wizard-username-input" type="text" inputmode="text" autocapitalize="none"
               autocomplete="username" spellcheck="false" placeholder="alice"
               aria-describedby="wizard-username-hint" />
        <p id="wizard-username-hint" class="note muted-sm">3–30 lowercase letters and digits, no dots or hyphens</p>
        <div id="wizard-username-taken" class="note err hidden" role="alert"></div>
        <div class="btn-row-sm">
          <button id="wizard-go-username" class="pill primary">Open my account</button>
        </div>
      `;
    case "secure-account":
      return renderSecureAccountStep();
    case "passphrase":
    case "webauthn-recovery":
      return `
        <p class="note">Set up recovery and you can get back into your account instantly
        and privately from a fresh browser if you lose this device. Skip it and you can
        still get back in, but only the slow way — a single-device account can be claimed
        from a new browser after a 3-day wait, and because that same path lets anyone who
        knows your username start a claim, recovery's the safer route. We recommend setting
        it up now (one minute); if you skip, a banner reminds you on the home screen.</p>
        <div class="btn-row-sm">
          <button id="wizard-go-recovery" class="pill primary">Set up recovery</button>
          <button id="wizard-skip-recovery" class="pill">Skip for now</button>
        </div>
      `;
    case "create-server":
      return `
        <p class="note">Your account is open — this step is optional. Compose your first
        server here (you can add more later). When you tap Continue, the webapp opens
        <code>flagshipserver.com/build/</code> on this machine — scan the QR there from
        this browser to deliver the disk image.</p>
        <div class="btn-row-sm">
          <button id="wizard-go-create-server" class="pill primary">Add a server</button>
          <button id="wizard-skip-create-server" class="pill">Skip for now</button>
        </div>
      `;
    case "peer-backup":
      return renderPeerBackupStep();
    case "demo-app":
      return `
        <p class="note">You're all set. Explore your server, or finish here —
        you can add services any time.</p>
        <div class="btn-row-sm">
          <button id="wizard-skip-demo" class="pill primary">Finish</button>
        </div>
      `;
    default:
      return "<p class=\"note\">Unknown step — finishing wizard.</p>";
  }
}

/** #95 — peer-backup opt-in step. Three buttons: enable, decline,
 *  "maybe later" (defers the choice without writing a "no" record). */
function renderPeerBackupStep() {
  return `
    <p class="note">
      Help others (and let them help you). Your encrypted shards travel to other
      Flagship users' pods; theirs travel to yours. Nobody can read each other's
      data — the bytes are sealed against keys only you hold.
    </p>
    <p class="note muted-sm">
      You can change this anytime in Settings → Peer-backup.
    </p>
    <div class="btn-row-sm">
      <button id="wizard-pb-enable" class="pill primary">Enable peer-backup</button>
      <button id="wizard-pb-decline" class="pill">No thanks</button>
      <button id="wizard-pb-later" class="pill ghost">Maybe later</button>
    </div>
  `;
}

/**
 * "Secure your account" step (runs immediately after the account is
 * opened, before the user reaches the app). Nudges a backup with the
 * cloud (passkey) option pre-selected when WebAuthn is available, the
 * downloadable `.flagshipkey` file as the self-custody alternative, and
 * a clearly de-emphasized "Skip for now" text link guarded by a warning.
 *
 * Both methods are reachable later from Settings → Recovery (the cloud
 * passkey via #recovery-cloud-setup, the file via #recovery-keyfile-export),
 * which is what the skip-warning's "set this up anytime in Settings" line
 * promises.
 */
export function renderSecureAccountStep() {
  const havePasskeys = passkeysAvailable();
  const cloudHint = havePasskeys
    ? "Recover with your device passkey or password manager."
    : "Passkeys aren't available in this browser — use a backup file.";
  return `
    <p class="note">Back up your account now so you can get back in if you lose this
    device. No one — not even us — can recover it for you.</p>
    <fieldset id="wizard-secure-options" class="secure-options stack-md">
      <legend class="visually-hidden">Backup method</legend>
      <label class="secure-option${havePasskeys ? "" : " disabled"}">
        <input type="radio" name="wizard-secure-method" value="cloud"
               id="wizard-secure-cloud"
               ${havePasskeys ? "checked" : "disabled"} />
        <span class="secure-option-text">
          <span class="secure-option-label">Save to a passkey</span>
          <span class="secure-option-sub muted-sm" id="wizard-secure-cloud-hint">${escapeHtml(cloudHint)}</span>
        </span>
      </label>
      <label class="secure-option">
        <input type="radio" name="wizard-secure-method" value="file"
               id="wizard-secure-file" ${havePasskeys ? "" : "checked"} />
        <span class="secure-option-text">
          <span class="secure-option-label">Save a backup file</span>
          <span class="secure-option-sub muted-sm">An encrypted .flagshipkey you keep yourself.</span>
        </span>
      </label>
    </fieldset>
    <div class="btn-row-sm">
      <button id="wizard-secure-continue" class="pill primary">Continue</button>
    </div>
    <p class="note muted-sm">
      <a id="wizard-secure-skip" href="#" role="button">Skip for now</a>
    </p>
  `;
}

function wireStepHandlers(state, step) {
  switch (step.id) {
    case "device-key":
      document.getElementById("wizard-go-bootstrap")?.addEventListener("click", async () => {
        markCompleteAndAdvance(state, "device-key");
        const { enterBootstrap } = await import("./bootstrap.js");
        await enterBootstrap();
      });
      break;
    case "username":
      document.getElementById("wizard-go-username")?.addEventListener("click", async () => {
        const ok = await handleOpenAccount();
        if (ok) markCompleteAndAdvance(state, "username");
      });
      break;
    case "secure-account":
      document.getElementById("wizard-secure-continue")?.addEventListener("click", async () => {
        const ok = await handleSecureAccount();
        // Backing up clears any prior skip warning — the account is now
        // recoverable. Only advance once the chosen action succeeds; a
        // failure (or cancelled ceremony) keeps the user on the step.
        if (ok) {
          try { profileRemove("recoveryWarn"); } catch { /* swallow */ }
          markCompleteAndAdvance(state, "secure-account");
        }
      });
      document.getElementById("wizard-secure-skip")?.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const { inlineConfirm } = await import("../lib/modal.js");
        const skip = await inlineConfirm({
          title: "Skip backup?",
          message:
            "Without a backup, losing this device means losing your account for good. You can set this up anytime in Settings.",
          okLabel: "Skip anyway",
          cancelLabel: "Back",
          danger: true,
        });
        if (!skip) return;
        try { profileSet("recoveryWarn", "true"); } catch { /* swallow */ }
        markCompleteAndAdvance(state, "secure-account");
      });
      break;
    case "passphrase":
    case "webauthn-recovery":
      document.getElementById("wizard-go-recovery")?.addEventListener("click", async () => {
        markCompleteAndAdvance(state, step.id);
        const { enterRecovery } = await import("./recovery.js");
        if (typeof enterRecovery === "function") await enterRecovery();
      });
      document.getElementById("wizard-skip-recovery")?.addEventListener("click", () => {
        try {
          profileSet("recoveryWarn", "true");
        } catch { /* swallow */ }
        markCompleteAndAdvance(state, step.id);
      });
      break;
    case "create-server":
      document.getElementById("wizard-go-create-server")?.addEventListener("click", async () => {
        markCompleteAndAdvance(state, "create-server");
        const { enterCreateServer } = await import("./create-server.js");
        await enterCreateServer();
      });
      document.getElementById("wizard-skip-create-server")?.addEventListener("click", () => {
        // The account is already open — a server is optional. Skipping
        // lands the user on Home with the empty-server CTA.
        markCompleteAndAdvance(state, "create-server");
      });
      break;
    case "peer-backup":
      document.getElementById("wizard-pb-enable")?.addEventListener("click", async () => {
        try { profileSet("peerBackupChoice", "enabled"); } catch { /* swallow */ }
        // The actual enable is a signed BackupToggle envelope; the
        // peer-backup view (#27) handles that. From the wizard we
        // just record the user's choice + jump to the view.
        markCompleteAndAdvance(state, "peer-backup");
        try {
          const { enterPeerBackup } = await import("./peer-backup.js");
          if (typeof enterPeerBackup === "function") await enterPeerBackup();
        } catch { /* not present yet */ }
      });
      document.getElementById("wizard-pb-decline")?.addEventListener("click", () => {
        try { profileSet("peerBackupChoice", "declined"); } catch { /* swallow */ }
        markCompleteAndAdvance(state, "peer-backup");
      });
      document.getElementById("wizard-pb-later")?.addEventListener("click", () => {
        try { profileSet("peerBackupChoice", "deferred"); } catch { /* swallow */ }
        markCompleteAndAdvance(state, "peer-backup");
      });
      break;
    case "demo-app":
      document.getElementById("wizard-skip-demo")?.addEventListener("click", () => {
        markCompleteAndAdvance(state, "demo-app");
      });
      break;
  }
}

function markCompleteAndAdvance(state, stepId) {
  if (!state.completed.includes(stepId)) state.completed.push(stepId);
  state.stepIdx++;
  saveState(state);
  void renderStep(state);
}

/** Helper for home.js: returns true iff the user explicitly skipped
 *  recovery setup and should see a persistent warning banner. */
export function shouldShowRecoveryWarning() {
  try {
    return profileGet("recoveryWarn") === "true";
  } catch {
    return false;
  }
}

/** Helper for home.js / settings: returns the user's peer-backup
 *  wizard choice. One of "enabled" | "declined" | "deferred" | null. */
export function getPeerBackupChoice() {
  try {
    return profileGet("peerBackupChoice");
  } catch {
    return null;
  }
}
