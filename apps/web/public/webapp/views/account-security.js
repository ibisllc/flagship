// v1.2 Phase 4 — Settings → Account security on the webapp PWA.
// Mirror of iOS AccountSecurityScreen.swift and Android
// AccountSecurityScreen.kt.
//
// Drives:
//   1. Read the account-type badge from GET /api/users/:u.
//   2. Four-step enrollment (explainer → QR + secret → sample code →
//      recovery codes display, gated behind "I've saved these").
//   3. Disable via POST /api/users/:u/totp/disable.
//
// The webapp doesn't sign the TOTP envelopes here — the mobile flow
// owns the IRK and signs everything; the webapp surface is intended
// for users who already have a phone enrolled and want to see / fall
// back to the badge state from a browser. The enroll/disable buttons
// surface a "use your phone" hint until the webapp's own IRK-signing
// landing pad (separate v1.3 work) lands. The QR + manual-secret +
// recovery-codes display ARE useful here for users who want to
// print/screenshot the codes from a larger surface.

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";

registerView("view-account-security");

const COM_BASE = "https://flagshipserver.com";

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
};

async function fetchAccountType() {
  const session = getSession();
  const username = session.username;
  if (!username) {
    state.accountType = null;
    return;
  }
  state.username = username;
  const r = await fetch(
    `${COM_BASE}/api/users/${encodeURIComponent(username)}`,
    { method: "GET", cache: "no-store" },
  );
  if (!r.ok) {
    state.accountType = null;
    return;
  }
  const body = await r.json();
  state.accountType = body.accountType ?? "single";
  state.totpEnrolledAt = body.totpEnrolledAt ?? null;
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
    : "Recovery uses a 7-day waiting period during which your other devices can object.";
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
                data-account-security-disable-btn>
          Disable multi-device + 2FA
        </button>
      </div>
    `;
  }
  return `
    <div class="card mt-3">
      <button id="account-security-enable"
              data-account-security-enable-btn>
        Enable multi-device + 2FA
      </button>
      <p class="faint-sm mt-2">
        Need to enroll from your phone? The mobile app drives the
        IRK-signed handshake. The webapp surfaces the same flow once
        v1.3 lands the browser-side signing path.
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
    state.failureMessage = "Use the mobile app to enroll — the webapp shares the badge but doesn't yet sign the enrollment envelope. Coming in v1.3.";
    await renderAccountSecurity();
  });
  document.getElementById("account-security-disable")?.addEventListener("click", async () => {
    const { inlineConfirm } = await import("../lib/modal.js");
    const ok = await inlineConfirm({
      title: "Disable multi-device + 2FA?",
      message: "Drops your TOTP secret + recovery codes. The account goes back to single-device + 7-day recovery grace. Refused while other trusted devices exist.",
      okLabel: "Disable",
      danger: true,
    });
    if (!ok) return;
    state.failureMessage = "Use the mobile app to disable — the webapp shares the badge but doesn't yet sign the disable envelope. Coming in v1.3.";
    await renderAccountSecurity();
  });
  document.getElementById("account-security-verify")?.addEventListener("click", async () => {
    // No-op surface; the same v1.3 note applies. Surface a hint
    // and clear the sample code so the input doesn't stay primed.
    state.failureMessage = "Verify the code from the mobile app — the webapp can't sign the enrollment envelope yet. Coming in v1.3.";
    await renderAccountSecurity();
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
