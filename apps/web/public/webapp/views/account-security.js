// v1.2 Phase 4 — Settings → Account security on the webapp PWA.
// Mirror of iOS AccountSecurityScreen.swift / AccountSecurityViewModel
// and the Android equivalent.
//
// Drives the FULL IRK-signed flow (the webapp holds the IRK via
// keystore.js signWithIrk over WebCrypto Ed25519, so it signs the same
// envelopes the mobile app does — superseding the earlier "use your
// phone" placeholder):
//   1. Read the account-type badge from GET /api/users/:u.
//   2. Four-step enrollment (explainer → QR + secret → sample code →
//      recovery codes display, gated behind "I've saved these"). The
//      QR + manual-secret + recovery-codes display also let users
//      print/screenshot from a larger surface.
//   3. Disable via the IRK-signed POST /api/users/:u/totp/disable.
//
// All three signed POSTs live in lib/totp.js, which mirrors the iOS
// AccountSecurityViewModel state machine + the @flagship/protocol
// canonical bytes.

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import {
  fetchAccountType as totpFetchAccountType,
  totpEnrollBegin,
  totpEnrollConfirm,
  totpDisable,
} from "../lib/totp.js";

registerView("view-account-security");

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
  busy: false,               // a signed POST is in flight
};

async function fetchAccountType() {
  const session = getSession();
  const username = session.username;
  if (!username) {
    state.accountType = null;
    return;
  }
  state.username = username;
  const { accountType, totpEnrolledAt } = await totpFetchAccountType(username);
  state.accountType = accountType;
  state.totpEnrolledAt = totpEnrolledAt;
}

function fmtDate(ms) {
  if (!ms) return "an unknown date";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** Renders the badge + explainer at the top of the screen. */
function renderBadge() {
  const isMulti = state.accountType === "multi";
  const titleText = isMulti ? "Multi-device + 2FA" : "Single-device account";
  const explainer = isMulti
    ? "Recovery requires a 6-digit TOTP code (or a recovery code) plus a 24-hour grace window."
    : "Recovery uses a 3-day waiting period during which your other devices can object.";
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
      <h3 class="mt-3">Currently enabled</h3>
      <p>
        Your TOTP secret was generated on ${escapeHtml(fmtDate(state.totpEnrolledAt))}.
        Store your recovery codes somewhere safe — they're the only
        way back in if your authenticator app is lost.
      </p>
    `;
  }
  return `
    <h3 class="mt-3">Why enable this?</h3>
    <p>
      A second factor outside your browser's password manager. If
      that store is ever compromised, the attacker still needs a live
      6-digit code from your authenticator app to take over your
      account.
    </p>
  `;
}

function renderStagedSecret() {
  if (!state.staged) return "";
  const dataUrl = `data:image/png;base64,${state.staged.qrPngBase64}`;
  return `
    <div class="card mt-3" data-account-security-staged>
      <h3>Step 2 of 4 — scan or paste</h3>
      <p class="note small">
        Scan with an authenticator app (1Password, Google Authenticator,
        Authy …). Or paste the manual key below.
      </p>
      ${state.staged.qrPngBase64
        ? `<img alt="TOTP QR code" data-account-security-qr src="${escapeHtml(dataUrl)}"
                style="image-rendering: pixelated; width: 200px; height: 200px;" />`
        : ""}
      <p class="weight-600 mt-2">Manual key</p>
      <code data-account-security-manual-secret>${escapeHtml(state.staged.secret)}</code>
      <p class="weight-600 mt-3">Step 3 — enter the 6-digit code</p>
      <input type="text" inputmode="numeric" maxlength="6"
             id="account-security-sample-code"
             data-account-security-sample-code
             placeholder="123456" autocomplete="one-time-code" />
      <div class="row-2 mt-2">
        <button id="account-security-verify" data-account-security-verify-btn>
          Verify code
        </button>
        <button class="secondary" id="account-security-cancel-enroll">Cancel</button>
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
      <h3>Step 4 of 4 — save your recovery codes</h3>
      <p>
        Print these or store them in a password manager. Each code
        works once if you lose your authenticator. They're the ONLY
        way back in.
      </p>
      <ol class="recovery-codes" data-account-security-recovery-codes>
        ${items}
      </ol>
      <label class="inline-check">
        <input type="checkbox" id="account-security-saved"
               data-account-security-saved-toggle
               ${state.savedRecoveryCodes ? "checked" : ""} />
        I've saved these somewhere safe
      </label>
      <button id="account-security-done" class="mt-2"
              data-account-security-done-btn
              ${state.savedRecoveryCodes ? "" : "disabled"}>
        Done
      </button>
      <button class="secondary mt-2" id="account-security-print">Print</button>
    </div>
  `;
}

function renderActions() {
  if (state.accountType === "multi") {
    return `
      <div class="card mt-3">
        <button class="danger" id="account-security-disable"
                data-account-security-disable-btn
                ${state.busy ? "disabled" : ""}>
          ${state.busy ? "Working…" : "Disable multi-device + 2FA"}
        </button>
      </div>
    `;
  }
  return `
    <div class="card mt-3">
      <button id="account-security-enable"
              data-account-security-enable-btn
              ${state.busy ? "disabled" : ""}>
        ${state.busy ? "Working…" : "Enable multi-device + 2FA"}
      </button>
      <p class="faint-sm mt-2">
        This browser signs the enrollment with your account key — no
        phone required.
      </p>
    </div>
  `;
}

function renderFailure() {
  if (!state.failureMessage) return "";
  return `
    <div class="card mt-2 err-text" data-account-security-failed-msg>
      ${escapeHtml(state.failureMessage)}
    </div>
  `;
}

async function renderAccountSecurity() {
  const root = $("account-security-content");
  if (!root) return;
  root.innerHTML = `<div class="card placeholder">Loading…</div>`;
  try {
    await fetchAccountType();
    root.innerHTML = [
      renderBadge(),
      renderExplainer(),
      renderStagedSecret(),
      renderRecoveryCodes(),
      renderActions(),
      renderFailure(),
    ].join("");
    bindHandlers();
  } catch (e) {
    root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(e.message ?? "Couldn't load.")}</div>`;
  }
}

function bindHandlers() {
  document.getElementById("account-security-enable")?.addEventListener("click", async () => {
    const session = getSession();
    if (!session.umk) {
      state.failureMessage = "Unlock the webapp first.";
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
      state.failureMessage = e?.status === 503
        ? "Two-factor isn't enabled on this server yet. Try again later."
        : humanError(e);
    } finally {
      state.busy = false;
      await renderAccountSecurity();
    }
  });
  document.getElementById("account-security-disable")?.addEventListener("click", async () => {
    const { inlineConfirm } = await import("../lib/modal.js");
    const ok = await inlineConfirm({
      title: "Disable multi-device + 2FA?",
      message: "Drops your TOTP secret + recovery codes. The account goes back to single-device + 3-day recovery grace. Refused while other trusted devices exist.",
      okLabel: "Disable",
      danger: true,
    });
    if (!ok) return;
    const { inlinePrompt } = await import("../lib/modal.js");
    const code = await inlinePrompt({
      title: "Confirm with your 2FA code",
      message: "Enter a live 6-digit code from your authenticator (or a recovery code) to disable.",
      placeholder: "123456",
    });
    if (!code) return;
    const session = getSession();
    if (!session.umk) {
      state.failureMessage = "Unlock the webapp first.";
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
      toast("Two-factor disabled.");
    } catch (e) {
      console.error("totp disable failed", e);
      state.failureMessage = e?.status === 401
        ? "That code didn't match. Try a fresh code from your authenticator."
        : e?.status === 409
          ? "Disable refused — other devices are still trusted on this account. Disconnect them first."
          : humanError(e);
    } finally {
      state.busy = false;
      await renderAccountSecurity();
    }
  });
  document.getElementById("account-security-verify")?.addEventListener("click", async () => {
    const codeInput = document.getElementById("account-security-sample-code");
    const code = (codeInput?.value ?? "").trim();
    if (!code) {
      state.failureMessage = "Enter the 6-digit code from your authenticator app.";
      await renderAccountSecurity();
      return;
    }
    const session = getSession();
    if (!session.umk) {
      state.failureMessage = "Unlock the webapp first.";
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
      state.failureMessage = e?.status === 401
        ? "That code didn't match. Try again with a fresh code from your authenticator."
        : humanError(e);
    } finally {
      state.busy = false;
      await renderAccountSecurity();
    }
  });
  document.getElementById("account-security-cancel-enroll")?.addEventListener("click", async () => {
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
      toast("Tick the checkbox first.", "err");
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
