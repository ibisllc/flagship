// v1.2 Phase 4 — Settings → Account security on the webapp PWA.
// Mirror of iOS AccountSecurityScreen.swift / AccountSecurityViewModel
// and the Android equivalent.
//
// Code protection (TOTP), the same name and flow as iOS and Android. It is
// an admin order (owner, 2026-11-23): this browser signs with its admin key
// (lib/totp.js), and a non-admin device sees the setting read-only:
//   1. Read the account-type badge from GET /api/users/:u.
//   2. Four-step enrollment (explainer → QR + secret → sample code →
//      recovery codes display, gated behind "I've saved these"). The
//      QR + manual-secret + recovery-codes display also let users
//      print/screenshot from a larger surface.
//   3. Turn off via the admin-signed POST /api/users/:u/totp/disable.
//
// All three signed POSTs live in lib/totp.js, which mirrors the iOS
// AccountSecurityViewModel state machine + the @flagship/protocol
// canonical bytes.

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { formatWhen } from "../lib/dateFormat.js";
import {
  TOTP_COPY,
  fetchAccountType as totpFetchAccountType,
  totpEnrollBegin,
  totpEnrollConfirm,
  totpDisable,
  totpErrorText,
} from "../lib/totp.js";
import { canSignAdminOrders } from "../lib/addServerGate.js";
import { humanError } from "../lib/humanError.js";
import { runRotateAdminRoot } from "../lib/adminRootRotation.js";
import { setupCloudRecovery, hasCloudRecovery } from "../lib/recovery.js";
import { RESET_KEYS_COPY, runResetAccountKeys } from "../lib/resetAccountKeysUi.js";

import { tr } from "../lib/i18n.js";
import { adminKeyCustody, custodyErrorText, isLockedKey, withAdminRoot } from "../lib/keyCustody.js";
registerView("view-account-security");

// Slice D (§5) — the type-to-confirm phrase for the destructive "Rotate admin
// key" action, and the revoke-semantic warning shown on the sheet.
const ROTATE_CONFIRM_PHRASE = "ROTATE";
export const ROTATE_ADMIN_WARNING =
  tr("Makes a new admin key and removes admin from every other device. They stay signed in as members but can't wipe, transfer or decommission your servers until they recover. Use it if a device is lost or stolen, or to cut off another admin. Servers switch on their next check-in.");

export const ROTATE_REESCROW_FAILED_MESSAGE =
  tr("Admin key rotated, but your recovery backup wasn't updated — it still holds your OLD admin key. Run recovery setup again from Settings to fix this.");

/**
 * The post-rotation re-escrow the rotation lib runs. Not-enrolled resolves
 * clean (nothing to re-wrap → the lib records "ok"); enrolled-but-failed
 * (popup blocked, WebAuthn cancelled, network) throws so the lib records
 * "failed" and the view can warn that the recovery backup still restores the
 * OLD admin root. Exported for tests.
 */
export function makeRotationReEscrow(deps = {}) {
  const enrolled = deps.hasCloudRecovery ?? hasCloudRecovery;
  const setup = deps.setupCloudRecovery ?? setupCloudRecovery;
  return async (username) => {
    if (await enrolled(username)) await setup(username);
  };
}

const state = {
  username: "",
  accountType: null,         // null = loading | "single" | "multi"
  totpEnrolledAt: null,
  // Step 2 staged secret + QR returned by /enroll-begin.
  staged: null,              // { secret, otpauthUrl, qrPngBase64, issuer }
  // Step 4 recovery codes returned by /enroll-confirm.
  recoveryCodes: null,
  savedRecoveryCodes: false,
  failureMessage: null,
  loadError: null,           // the badge couldn't be read: no buttons, this sentence
  busy: false,               // a signed POST is in flight
};

/** Whether this device may turn code protection on or off (an admin device, or a demo account's). */
function mayChange(session = getSession()) {
  return canSignAdminOrders(session);
}

async function fetchAccountType() {
  const session = getSession();
  const username = session.username;
  state.loadError = null;
  if (!username) {
    state.accountType = null;
    state.loadError = TOTP_COPY.notLoaded;
    return;
  }
  state.username = username;
  try {
    const { accountType, totpEnrolledAt } = await totpFetchAccountType(username);
    state.accountType = accountType;
    state.totpEnrolledAt = totpEnrolledAt;
  } catch (e) {
    console.error("account type read failed", e);
    state.accountType = null;
    state.loadError = totpErrorText(e);
  }
}

function fmtDate(ms) {
  if (!ms) return tr("an unknown date");
  return formatWhen(ms);
}

/** Renders the badge + explainer at the top of the screen. */
function renderBadge() {
  const isMulti = state.accountType === "multi";
  const titleText = isMulti ? tr("Code protection is on") : tr("Single-device account");
  const explainer = isMulti
    ? tr("Recovery needs a 6-digit authenticator code (or a recovery code) and a 24-hour wait.")
    : tr("Recovery needs a recovery credential, then a 3-day wait. Your other devices are alerted but can't cancel it.");
  return `
    <div class="card" data-account-security-badge="${escapeHtml(state.accountType ?? "unknown")}">
      <div class="row">
        <div class="weight-600">
          <span aria-hidden="true">${isMulti ? "🛡️" : "🛡"}</span>
          ${escapeHtml(titleText)}
        </div>
      </div>
      <p class="note small">${escapeHtml(explainer)}</p>
    </div>
  `;
}

function renderExplainer() {
  if (state.accountType === "multi") {
    return `
      <h3 class="mt-3">${tr("Currently enabled")}</h3>
      <p>
        ${tr("Set up on {0}. Keep your recovery codes safe: they're the only way back in if you lose your authenticator app.", escapeHtml(fmtDate(state.totpEnrolledAt)))}
      </p>
    `;
  }
  return `
    <h3 class="mt-3">${tr("Why turn it on?")}</h3>
    <p>
      ${tr("A check outside your browser's password manager: anyone who breaks into it still needs a live code from your authenticator app to take over your account.")}
    </p>
  `;
}

function renderStagedSecret() {
  if (!state.staged) return "";
  const dataUrl = `data:image/png;base64,${state.staged.qrPngBase64}`;
  return `
    <div class="card mt-3" data-account-security-staged>
      <h3>${tr("Step 2 of 4 — scan or paste")}</h3>
      <p class="note small">
        ${tr("Scan with an authenticator app (1Password, Google Authenticator, Authy …). Or paste the manual key below.")}
      </p>
      ${state.staged.qrPngBase64
        ? `<img alt="${tr("TOTP QR code")}" data-account-security-qr src="${escapeHtml(dataUrl)}"
                style="image-rendering: pixelated; width: 200px; height: 200px;" />`
        : ""}
      <p class="weight-600 mt-2">${tr("Manual key")}</p>
      <code data-account-security-manual-secret>${escapeHtml(state.staged.secret)}</code>
      <p class="weight-600 mt-3">${tr("Step 3 — enter the 6-digit code")}</p>
      <input type="text" inputmode="numeric" maxlength="6"
             id="account-security-sample-code"
             data-account-security-sample-code
             placeholder="123456" autocomplete="one-time-code" />
      <div class="row-2 mt-2">
        <button id="account-security-verify" data-account-security-verify-btn>
          ${tr("Verify code")}
        </button>
        <button class="secondary" id="account-security-cancel-enroll">${tr("Cancel")}</button>
      </div>
    </div>
  `;
}

function renderRecoveryCodes() {
  if (!state.recoveryCodes) return "";
  const items = state.recoveryCodes
    .map((c) => `<li><code>${escapeHtml(c)}</code></li>`)
    .join("");
  return `
    <div class="card mt-3" data-account-security-codes>
      <h3>${tr("Step 4 of 4 — save your recovery codes")}</h3>
      <p>
        ${tr("Print them or keep them in a password manager. Each works once. If you lose your authenticator, they're the only way back in.")}
      </p>
      <ol class="recovery-codes" data-account-security-recovery-codes>
        ${items}
      </ol>
      <label class="inline-check">
        <input type="checkbox" id="account-security-saved"
               data-account-security-saved-toggle
               ${state.savedRecoveryCodes ? "checked" : ""} />
        ${tr("I've saved these somewhere safe")}
      </label>
      <button id="account-security-done" class="mt-2"
              data-account-security-done-btn
              ${state.savedRecoveryCodes ? "" : "disabled"}>
        ${tr("Done")}
      </button>
      <button class="secondary mt-2" id="account-security-print">${tr("Print")}</button>
    </div>
  `;
}

function renderActions() {
  if (state.loadError) return "";
  const admin = mayChange();
  const adminOnly = admin
    ? ""
    : `<p class="faint-sm mt-2" data-account-security-admin-only>${escapeHtml(TOTP_COPY.adminOnly)}</p>`;
  if (state.accountType === "multi") {
    return `
      <div class="card mt-3">
        <button class="danger" id="account-security-disable"
                data-account-security-disable-btn
                ${state.busy || !admin ? "disabled" : ""}>
          ${state.busy ? tr("Working…") : tr("Turn off code protection")}
        </button>
        ${adminOnly}
      </div>
    `;
  }
  return `
    <div class="card mt-3">
      <button id="account-security-enable"
              data-account-security-enable-btn
              ${state.busy || !admin ? "disabled" : ""}>
        ${state.busy ? tr("Working…") : tr("Turn on code protection")}
      </button>
      ${admin
        ? `<p class="faint-sm mt-2">${tr("This browser signs with its admin key — no phone required.")}</p>`
        : adminOnly}
    </div>
  `;
}

/** Slice D — the owner-facing "Rotate admin key" control. Shown only when THIS
 *  device holds the admin master root (a non-admin device can't rotate); a
 *  non-admin device sees an explanatory note instead. */
function renderRotateAdminRoot() {
  const session = getSession();
  const isAdmin = !!session.adminRootSeed;
  if (!isAdmin) {
    return `
      <div class="card mt-3" data-account-security-rotate="unavailable">
        <h3>${tr("Admin key")}</h3>
        <p class="note small">
          ${tr("This device isn't an admin device, so it can't rotate the admin key. Rotate from a device that holds admin authority.")}
        </p>
      </div>
    `;
  }
  return `
    <div class="card mt-3" data-account-security-rotate="available">
      <h3>${tr("Admin key")}</h3>
      <p class="note small">${escapeHtml(ROTATE_ADMIN_WARNING)}</p>
      <button class="danger" id="account-security-rotate-admin"
              data-account-security-rotate-btn
              ${state.busy ? "disabled" : ""}>
        ${state.busy ? tr("Working…") : tr("Rotate admin key")}
      </button>
    </div>
  `;
}

/** Where this browser's admin key lives (docs/webapp-key-custody.md items 1 and 2). Exported for tests. */
export function renderAdminKeyCustody(custody = state.custody) {
  if (!custody) return "";
  if (custody.custody === "browser-passkey") {
    const pq = custody.pqBound
      ? tr("Its quantum-safe half is the one on record, so servers that need quantum-safe signatures accept this browser's orders.")
      : tr("Another device holds the admin key's quantum-safe half, so this browser signs classically. Servers that need quantum-safe signatures refuse its orders.");
    return `
      <div class="card mt-3" data-account-security-custody="passkey">
        <h3>${tr("This browser's admin key")}</h3>
        <p><strong>${escapeHtml(CUSTODY_LABEL)}</strong></p>
        <p class="note small">${tr("Each admin action asks for your passkey, and the key is locked again right after.")}</p>
        <p class="note small">${pq}</p>
      </div>`;
  }
  return `
    <div class="card mt-3" data-account-security-custody="passphrase">
      <h3>${tr("This browser's admin key")}</h3>
      <p class="note small">${tr("This browser's admin key is protected by its passphrase only. Protect it with a passkey (Touch ID, Windows Hello or a security key) before it signs anything.")}</p>
      <button id="account-security-protect-key" ${state.busy ? "disabled" : ""}>${tr("Protect with a passkey")}</button>
    </div>`;
}

export const CUSTODY_LABEL = tr("Browser: software key, unlocked with a passkey");

/** "Reset account keys" (docs/revocation-ui.md): the account-wide reset, moved here from each Trusted devices row. */
function renderResetAccountKeys() {
  return `
    <div class="card mt-3" data-account-security-reset-keys>
      <h3>${escapeHtml(RESET_KEYS_COPY.heading)}</h3>
      <p class="note small">${escapeHtml(RESET_KEYS_COPY.explain)}</p>
      <p class="note small hidden" id="account-security-reset-status" aria-live="polite"></p>
      <button class="danger" id="account-security-reset-keys" ${state.busy ? "disabled" : ""}>${escapeHtml(RESET_KEYS_COPY.confirm)}</button>
    </div>
  `;
}

function renderFailure() {
  const message = state.failureMessage ?? state.loadError;
  if (!message) return "";
  return `
    <div class="card mt-2 err-text" data-account-security-failed-msg>
      ${escapeHtml(message)}
    </div>
  `;
}

async function renderAccountSecurity() {
  const root = $("account-security-content");
  if (!root) return;
  root.innerHTML = `<div class="card placeholder">${tr("Loading…")}</div>`;
  try {
    await fetchAccountType();
    state.custody = getSession().adminRootSeed ? await adminKeyCustody().catch(() => null) : null;
    root.innerHTML = [
      renderBadge(),
      renderExplainer(),
      renderStagedSecret(),
      renderRecoveryCodes(),
      renderActions(),
      renderAdminKeyCustody(),
      renderRotateAdminRoot(),
      renderResetAccountKeys(),
      renderFailure(),
    ].join("");
    bindHandlers();
  } catch (e) {
    console.error("account security render failed", e);
    root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(totpErrorText(e))}</div>`;
  }
}

/** Why this browser can't send a code protection order right now, or null. Exported for tests. */
export function preflight(session = getSession()) {
  if (!session?.username) return TOTP_COPY.notLoaded;
  if (!session.umk) return TOTP_COPY.locked;
  if (!mayChange(session)) return TOTP_COPY.adminOnly;
  return null;
}

function bindHandlers() {
  document.getElementById("account-security-reset-keys")?.addEventListener("click", async () => {
    if (state.busy) return;
    const status = document.getElementById("account-security-reset-status");
    const progress = (text) => {
      if (!status) return;
      status.textContent = text;
      status.classList.remove("hidden");
    };
    state.busy = true;
    state.failureMessage = null;
    try {
      const out = await runResetAccountKeys({ progress });
      if (out.localFailed) {
        state.failureMessage = out.localFailed;
        toast(tr("Server wiped — re-open the app to finish on this browser."), "err");
      } else if (out.done) {
        toast(tr("Done. Your account has new keys."), "ok");
      }
    } catch (e) {
      console.error("reset account keys failed", e);
      state.failureMessage = e?.message === RESET_KEYS_COPY.locked ? e.message : humanError(e);
    } finally {
      state.busy = false;
      await renderAccountSecurity();
    }
  });
  document.getElementById("account-security-protect-key")?.addEventListener("click", async () => {
    const key = getSession().adminRootSeed;
    if (!isLockedKey(key)) return;
    try {
      // Opening the key once moves it under a new passkey (lib/keyCustody.js).
      await withAdminRoot(key, async () => {});
      toast(tr("This browser's admin key is now protected by a passkey."), "ok");
    } catch (e) {
      state.failureMessage = custodyErrorText(e);
    }
    await renderAccountSecurity();
  });
  document.getElementById("account-security-enable")?.addEventListener("click", async () => {
    const session = getSession();
    const blocked = preflight(session);
    if (blocked) {
      state.failureMessage = blocked;
      await renderAccountSecurity();
      return;
    }
    state.busy = true;
    state.failureMessage = null;
    await renderAccountSecurity();
    try {
      const staged = await totpEnrollBegin({
        username: session.username,
        umk: session.umk,
      });
      state.staged = staged;
    } catch (e) {
      console.error("totp enroll-begin failed", e);
      state.failureMessage = totpErrorText(e);
    } finally {
      state.busy = false;
      await renderAccountSecurity();
    }
  });
  document.getElementById("account-security-disable")?.addEventListener("click", async () => {
    const { inlineConfirm } = await import("../lib/modal.js");
    const ok = await inlineConfirm({
      title: tr("Turn off code protection?"),
      message: tr("Removes your authenticator and recovery codes. The account goes back to single-device with a 3-day recovery wait. Refused while other trusted devices exist."),
      okLabel: tr("Disable"),
      danger: true,
    });
    if (!ok) return;
    const { inlinePrompt } = await import("../lib/modal.js");
    const code = await inlinePrompt({
      title: tr("Confirm with your code"),
      message: tr("Enter a live 6-digit code from your authenticator (or a recovery code) to turn code protection off."),
      placeholder: "123456",
    });
    if (!code) return;
    const session = getSession();
    const blocked = preflight(session);
    if (blocked) {
      state.failureMessage = blocked;
      await renderAccountSecurity();
      return;
    }
    state.busy = true;
    state.failureMessage = null;
    await renderAccountSecurity();
    try {
      const { accountType } = await totpDisable({
        username: session.username,
        umk: session.umk,
        code,
      });
      state.accountType = accountType;
      state.totpEnrolledAt = null;
      toast(tr("Code protection is off."));
    } catch (e) {
      console.error("totp disable failed", e);
      state.failureMessage = totpErrorText(e);
      if (e?.code === "totp-not-enrolled") {
        state.accountType = "single";
        state.totpEnrolledAt = null;
      }
    } finally {
      state.busy = false;
      await renderAccountSecurity();
    }
  });
  document.getElementById("account-security-verify")?.addEventListener("click", async () => {
    const codeInput = document.getElementById("account-security-sample-code");
    const code = (codeInput?.value ?? "").trim();
    if (!code) {
      state.failureMessage = tr("Enter the 6-digit code from your authenticator app.");
      await renderAccountSecurity();
      return;
    }
    const session = getSession();
    const blocked = preflight(session);
    if (blocked) {
      state.failureMessage = blocked;
      await renderAccountSecurity();
      return;
    }
    state.busy = true;
    state.failureMessage = null;
    await renderAccountSecurity();
    try {
      const result = await totpEnrollConfirm({
        username: session.username,
        umk: session.umk,
        code,
      });
      state.accountType = result.accountType;
      state.totpEnrolledAt = result.totpEnrolledAt;
      state.recoveryCodes = result.recoveryCodes;
      state.staged = null;
    } catch (e) {
      console.error("totp enroll-confirm failed", e);
      state.failureMessage = e?.code === "invalid-totp-code" || e?.status === 401
        ? tr("That code didn't match. Try again with a fresh code from your authenticator.")
        : totpErrorText(e);
      // The setup is gone (expired, or code protection is on already): back to the start.
      if (e?.code === "totp-pending-expired" || e?.code === "totp-no-pending" || e?.code === "totp-already-enrolled") {
        state.staged = null;
      }
    } finally {
      state.busy = false;
      await renderAccountSecurity();
    }
  });
  document.getElementById("account-security-cancel-enroll")?.addEventListener("click", async () => {
    // `.com` drops the staged secret after an hour; it never counts as code protection meanwhile.
    state.staged = null;
    state.failureMessage = null;
    await renderAccountSecurity();
  });
  document.getElementById("account-security-saved")?.addEventListener("change", async (ev) => {
    state.savedRecoveryCodes = !!ev.currentTarget.checked;
    await renderAccountSecurity();
  });
  document.getElementById("account-security-done")?.addEventListener("click", async () => {
    if (!state.savedRecoveryCodes) {
      toast(tr("Tick the checkbox first."), "err");
      return;
    }
    // Scrub plaintexts from memory once the user has confirmed.
    state.recoveryCodes = null;
    state.staged = null;
    state.savedRecoveryCodes = false;
    state.failureMessage = null;
    await renderAccountSecurity();
  });
  document.getElementById("account-security-print")?.addEventListener("click", () => {
    window.print();
  });
  document.getElementById("account-security-rotate-admin")?.addEventListener("click", async () => {
    const session = getSession();
    if (!session.umk || !session.adminRootSeed) {
      state.failureMessage = session.umk
        ? tr("This device isn't an admin device.")
        : tr("Unlock the webapp first.");
      await renderAccountSecurity();
      return;
    }
    const { inlineConfirm, inlinePrompt } = await import("../lib/modal.js");
    const ok = await inlineConfirm({
      title: tr("Rotate admin key?"),
      message: ROTATE_ADMIN_WARNING,
      okLabel: tr("Continue"),
      danger: true,
    });
    if (!ok) return;
    const typed = await inlinePrompt({
      title: tr("Type ROTATE to confirm"),
      message: tr("This revokes admin from your other admin devices and cannot be undone. Type {0} to continue.", ROTATE_CONFIRM_PHRASE),
      placeholder: ROTATE_CONFIRM_PHRASE,
    });
    if (!typed || typed.trim().toUpperCase() !== ROTATE_CONFIRM_PHRASE) {
      if (typed != null) toast(tr("Rotation cancelled — phrase didn't match."), "err");
      return;
    }
    state.busy = true;
    state.failureMessage = null;
    await renderAccountSecurity();
    try {
      const result = await runRotateAdminRoot({
        username: session.username,
        umkSeed: session.umk,
        currentAdminRootSeed: session.adminRootSeed,
        session,
        // Re-escrow the NEW root under the recovery credential — best-effort +
        // only when recovery is actually enrolled.
        reEscrow: makeRotationReEscrow(),
      });
      if (result.reEscrow === "failed") {
        // The rotation itself succeeded — but a stale escrow silently restores
        // the dead root, so the warning must persist past a toast's lifetime.
        state.failureMessage = ROTATE_REESCROW_FAILED_MESSAGE;
      } else {
        toast(tr("Admin key rotated — your other admin devices are no longer admins."), "ok");
      }
    } catch (e) {
      console.error("admin-root rotation failed", e);
      state.failureMessage = humanError(e);
    } finally {
      state.busy = false;
      await renderAccountSecurity();
    }
  });
}

export function initAccountSecurityView() {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-account-security") {
      renderAccountSecurity().catch(() => {});
    }
  });
  $("account-security-back")?.addEventListener("click", () => show("view-settings-tab"));
}

// Public re-render hook for tests and integration code.
export { renderAccountSecurity };
