// Trusted devices are loaded only through the signed account directory.
// Human names are decrypted in this unlocked client and never returned by
// the control plane.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { getSession, unlockSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { formatWhen } from "../lib/dateFormat.js";
import {
  runReplaceDeviceCeremony,
  completeReplaceDeviceCeremony,
  fetchPendingRePair,
  startCountdown,
} from "../lib/replaceDeviceCeremony.js";
import { runWipeRestartCeremony } from "../lib/wipeRestartCeremony.js";
import {
  bootstrapFromExistingSeed,
  currentIrkVersion,
  resetDevice,
  setCurrentIrkVersion,
} from "../keystore.js";
import { renderPendingBanner, shouldRenderBanner } from "../lib/pendingRePairBanner.js";
import {
  fetchDecryptedDirectory,
  removeManagedDeviceDisplayName,
  setManagedDeviceDisplayName,
  updateAccountDisplayName,
  updateSelfDisplayName,
} from "../lib/accountDirectory.js";

registerView("view-trusted-devices");

/** Cached state: last-fetched devices + ETag for the If-Match flow.
 *  `pendingRePair` mirrors the GET /api/users/:u/re-pair snapshot so a
 *  fresh load can surface the banner without re-initiating. */
const state = {
  username: "",
  devices: [],
  accountDisplayName: null,
  accountProfile: null,
  selfProfiles: [],
  managedProfiles: [],
  pendingRePair: null,
};

function platformIcon(p) {
  return ({
    ios: "📱",
    android: "🤖",
    web: "🌐",
    macos: "💻",
    windows: "💻",
    linux: "💻",
  })[p] ?? "❔";
}

function platformDisplay(p) {
  return ({
    ios: "iPhone / iPad",
    android: "Android",
    web: "Web",
    macos: "Mac",
    windows: "Windows PC",
    linux: "Linux PC",
  })[p] ?? (p || "Unknown platform");
}

/** The name shown for a device row. Never renders the literal string
 *  "undefined": falls back to a platform-derived label, then a short
 *  token id, then a generic name — so a record missing its `label`
 *  (or `label` AND `platform`) still reads sensibly. */
function deviceName(device) {
  if (device.displayName) return device.displayName;
  return `${platformDisplay(device.platformClass)} · Device ${device.supportCode ?? device.deviceId.slice(0, 8)}`;
}

function relative(ms) {
  if (!ms) return "unknown";
  const d = Date.now() - ms;
  const s = Math.max(0, Math.floor(d / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

async function fetchDevices() {
  const session = getSession();
  const username = session.username;
  if (!username) {
    state.username = "";
    state.devices = [];
    state.accountDisplayName = null;
    return;
  }
  state.username = username;
  const directory = await fetchDecryptedDirectory();
  state.accountDisplayName = directory.accountDisplayName;
  state.accountProfile = directory.accountProfile;
  state.selfProfiles = directory.selfProfiles;
  state.managedProfiles = directory.managedProfiles;
  state.devices = directory.devices;
}

async function fetchPendingRePairSnapshot() {
  if (!state.username) {
    state.pendingRePair = null;
    return;
  }
  try {
    const out = await fetchPendingRePair({ username: state.username });
    state.pendingRePair = out;
  } catch {
    state.pendingRePair = null;
  }
}

/** v1.2 Phase 4 — a row is quarantined while its 14-day window from
 *  admission has not yet elapsed. The clock icon + disabled Remove
 *  button surface the state to the user. */
function isQuarantined(device) {
  const until = device.quarantineUntil;
  return typeof until === "number" && until > 0 && until > Date.now();
}

/** Tooltip / toast copy for a quarantined row. Mirrors the iOS +
 *  Android helpers so the message is byte-stable across surfaces. */
function quarantineMessage(device) {
  const until = device.quarantineUntil;
  if (!until) return "This device is in quarantine. Use another device.";
  return `Quarantined until ${formatWhen(until)}. Use another device.`;
}

function renderDeviceCard(device) {
  const quarantined = isQuarantined(device);
  const quarantineMsg = quarantined ? quarantineMessage(device) : "";
  return `
    <div class="card" data-device-id="${escapeHtml(device.deviceId)}"
         ${quarantined ? `data-quarantined="true"` : ""}>
      <div class="row">
        <div class="weight-600">
          <span aria-hidden="true">${platformIcon(device.platformClass)}</span>
          ${escapeHtml(deviceName(device))}
          ${device.isCurrent ? `<span class="pill">This device</span>` : ""}
          ${device.grant?.signerRoot === "admin-root" ? `<span class="pill">Administrator</span>` : ""}
          ${device.managed ? `<span class="pill">${device.locked ? "Managed · locked" : "Managed"}</span>` : ""}
        </div>
      </div>
      <div class="note small">
        ${escapeHtml(platformDisplay(device.platformClass))}
        · Device ${escapeHtml(device.supportCode ?? device.deviceId.slice(0, 8))}
        · added ${escapeHtml(relative(device.createdAt))}
        ${
          device.lastSeenAt > device.createdAt
            ? `· last seen ${escapeHtml(relative(device.lastSeenAt))}`
            : ""
        }
      </div>
      <div class="row mt-2">
        ${device.isCurrent ? `<button class="secondary" data-self-rename="${escapeHtml(device.deviceId)}">Rename this device</button>` : ""}
        ${getSession().adminRootSeed ? `<button class="secondary" data-managed-name="${escapeHtml(device.deviceId)}">${device.managed ? "Edit managed name" : "Set managed name"}</button>` : ""}
        ${device.managed && getSession().adminRootSeed ? `<button class="secondary" data-managed-remove="${escapeHtml(device.deviceId)}">Remove managed name</button>` : ""}
      </div>
      ${quarantined
        ? `<div class="note small err-text">${escapeHtml(quarantineMsg)}</div>`
        : ""}
    </div>
  `;
}

/** Danger zone: live ceremonies for Replace device + Wipe & restart.
 *  Both rotate the account's identity keys; Wipe additionally drops
 *  the recovery envelope + UMK, so it's the "nuclear" option. Each
 *  uses a 3-second countdown confirm sheet (the webapp equivalent of
 *  the iOS/Android long-press, per docs/revocation-ui.md). */
function renderDangerZone() {
  return `
    <hr class="mt-4" />
    <h3 class="mt-2">Danger zone</h3>
    <p class="note small">
      Lost a device or worried about a stolen one? These actions rotate
      your account's identity keys, disconnecting every device on this
      account in one shot.
    </p>
    <div class="card" data-section="replace-device">
      <div class="row">
        <div class="weight-600">
          <span aria-hidden="true">🔄</span>
          Replace device
        </div>
        <button class="secondary danger" id="replace-device-btn">Replace device</button>
      </div>
      <p class="note small">
        Rotates your account's identity key. Every other device on this
        account will need to confirm a new pairing the next time it opens.
        Pods stay running; apps stay installed.
      </p>
    </div>
    <div class="card" data-section="wipe-restart">
      <div class="row">
        <div class="weight-600">
          <span aria-hidden="true">🗑️</span>
          Wipe &amp; restart
        </div>
        <button class="secondary danger" id="wipe-restart-btn">Wipe &amp; restart</button>
      </div>
      <p class="note small">
        Rotates your account identity + recovery passkey in one ceremony.
        Every device currently on this account — including this browser —
        gets disconnected and re-pairs fresh. Pods keep running; apps stay
        installed.
      </p>
    </div>
  `;
}

async function renderTrustedDevices() {
  const root = $("trusted-devices-list");
  if (!root) return;
  root.innerHTML = `<div class="card placeholder">Loading devices…</div>`;
  try {
    await fetchDevices();
    await fetchPendingRePairSnapshot();
    const bannerHtml = renderPendingBanner(state.pendingRePair);
    if (state.devices.length === 0) {
      root.innerHTML = `
        ${bannerHtml}
        <div class="card">
          <div class="weight-600">Just this device</div>
          <p class="note small">
            Sign in on a phone or tablet to add a trusted device. Browser
            sessions like this webapp aren't trusted devices — they're
            per-pod paired tokens, listed under "Browser sessions" instead.
          </p>
        </div>
        ${renderDangerZone()}`;
      bindPendingBanner();
      bindDangerZone();
      return;
    }
    const accountHeader = `
      <div class="card">
        <div class="weight-600">${escapeHtml(state.accountDisplayName ?? `@${state.username}`)}</div>
        <div class="note small">@${escapeHtml(state.username)} · public routing address</div>
        ${getSession().adminRootSeed ? `<button class="secondary mt-2" id="edit-account-display-name">Edit account name</button>` : ""}
      </div>`;
    root.innerHTML = bannerHtml + accountHeader + state.devices.map(renderDeviceCard).join("") + renderDangerZone();
    bindPrivateNameActions(root);
    bindPendingBanner();
    bindDangerZone();
  } catch (e) {
    root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(e.message ?? "Couldn't load devices")}</div>`;
  }
}

function bindPrivateNameActions(root) {
  document.getElementById("edit-account-display-name")?.addEventListener("click", async () => {
    const { inlinePrompt } = await import("../lib/modal.js");
    const name = await inlinePrompt({
      title: "Edit account name",
      message: "Encrypted presentation only. Your public routing username does not change.",
      initial: state.accountDisplayName ?? "",
      validate: (value) => value?.trim() ? null : "Enter an account name",
    });
    if (!name) return;
    try {
      await updateAccountDisplayName(name, state.accountProfile);
      toast("Account name updated");
      await renderTrustedDevices();
    } catch (error) {
      toast(error?.message ?? "Couldn't update account name", "err");
    }
  });
  root.querySelectorAll("[data-self-rename]").forEach((button) => button.addEventListener("click", async () => {
    const deviceId = button.getAttribute("data-self-rename");
    const device = state.devices.find((item) => item.deviceId === deviceId);
    const current = state.selfProfiles.find((item) => item.deviceId === deviceId) ?? null;
    const { inlinePrompt } = await import("../lib/modal.js");
    const name = await inlinePrompt({
      title: "Rename this device",
      message: "This name applies only inside this Flagship account.",
      initial: device?.selfDisplayName ?? "",
      validate: (value) => value?.trim() ? null : "Enter a device name",
    });
    if (!name) return;
    try {
      await updateSelfDisplayName(name, current);
      toast(device?.managed ? "Suggestion saved; the managed name remains visible" : "Device renamed");
      await renderTrustedDevices();
    } catch (error) {
      toast(error?.message ?? "Couldn't rename device", "err");
    }
  }));
  root.querySelectorAll("[data-managed-name]").forEach((button) => button.addEventListener("click", async () => {
    const deviceId = button.getAttribute("data-managed-name");
    const device = state.devices.find((item) => item.deviceId === deviceId);
    const current = state.managedProfiles.find((item) => item.deviceId === deviceId) ?? null;
    const { inlineConfirm, inlinePrompt } = await import("../lib/modal.js");
    if (!await inlineConfirm({ title: "Administrator change", message: "Use your unlocked administrator authority to manage this device name.", okLabel: "Continue" })) return;
    const name = await inlinePrompt({
      title: "Managed device name",
      message: "This encrypted name overrides the device's own suggestion.",
      initial: device?.managedDisplayName ?? device?.selfDisplayName ?? "",
      validate: (value) => value?.trim() ? null : "Enter a device name",
    });
    if (!name) return;
    const locked = await inlineConfirm({ title: "Lock this name?", message: "A locked managed name stays effective until an administrator removes or unlocks it.", okLabel: "Lock name", cancelLabel: "Leave unlocked" });
    try {
      await setManagedDeviceDisplayName(deviceId, name, locked, current);
      toast("Managed name updated");
      await renderTrustedDevices();
    } catch (error) {
      toast(error?.message ?? "Couldn't manage device name", "err");
    }
  }));
  root.querySelectorAll("[data-managed-remove]").forEach((button) => button.addEventListener("click", async () => {
    const deviceId = button.getAttribute("data-managed-remove");
    const current = state.managedProfiles.find((item) => item.deviceId === deviceId) ?? null;
    const { inlineConfirm } = await import("../lib/modal.js");
    if (!await inlineConfirm({ title: "Remove managed name?", message: "The device's own encrypted suggestion becomes visible.", okLabel: "Remove", danger: true })) return;
    try {
      await removeManagedDeviceDisplayName(deviceId, current);
      toast("Managed name removed");
      await renderTrustedDevices();
    } catch (error) {
      toast(error?.message ?? "Couldn't remove managed name", "err");
    }
  }));
}

function bindPendingBanner() {
  if (!shouldRenderBanner(state.pendingRePair)) return;
  document.getElementById("finalize-replace-btn")?.addEventListener("click", () => {
    finalizePendingReplace().catch((e) => toast(e?.message ?? "Finalize failed", "err"));
  });
}

async function finalizePendingReplace() {
  const session = getSession();
  if (!session.umk || !session.username) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const phase = openPhaseToast("Finalize replace");
  try {
    phase.update("installing", "Installing new identity…");
    const out = await completeReplaceDeviceCeremony({ username: session.username });
    // Bump the local IRK slot so subsequent signs use the rotated key.
    setCurrentIrkVersion(currentIrkVersion() + 1);
    await unlockSession(session.umk, session.username);
    phase.update("done", "Replace complete.");
    toast("Replace complete.");
    state.pendingRePair = null;
    await renderTrustedDevices();
  } catch (e) {
    phase.update("error", e?.message ?? "Couldn't finalize");
    toast(e?.message ?? "Finalize failed", "err");
  } finally {
    phase.dismissAfter(3500);
  }
}

function bindDangerZone() {
  document.getElementById("replace-device-btn")?.addEventListener("click", () => {
    runReplaceDeviceSheet().catch((e) => toast(e?.message ?? "Replace failed", "err"));
  });
  document.getElementById("wipe-restart-btn")?.addEventListener("click", () => {
    runWipeRestartSheet().catch((e) => toast(e?.message ?? "Wipe failed", "err"));
  });
}

/** Build a native <dialog>-based confirmation sheet with a 3-second
 *  countdown primary button. Resolves true when the countdown
 *  completes; false on Cancel / Esc / backdrop. Copy is verbatim from
 *  docs/revocation-ui.md so a future copy refactor surfaces here. */
function openCountdownSheet({ titleHtml, bodyHtml, primaryLabel, primaryClass }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "ceremony-dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.innerHTML = `
      <form method="dialog" class="modal-card">
        <h3 class="modal-title">${titleHtml}</h3>
        <div class="modal-message">${bodyHtml}</div>
        <p class="modal-message" data-countdown-line aria-live="polite"></p>
        <div class="row-2 mt-3">
          <button type="button" class="secondary" data-cancel>Cancel</button>
          <button type="button" class="${primaryClass || "danger"}" data-primary>${primaryLabel}</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);
    // Some test harnesses may not have HTMLDialogElement; degrade to a
    // visible block.
    if (typeof dialog.showModal === "function") {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    } else {
      dialog.setAttribute("open", "");
    }
    const primary = dialog.querySelector("[data-primary]");
    const cancel = dialog.querySelector("[data-cancel]");
    const line = dialog.querySelector("[data-countdown-line]");
    let countdown = null;
    let resolved = false;
    const close = (v) => {
      if (resolved) return;
      resolved = true;
      countdown?.cancel();
      try { dialog.close(); } catch { /* polyfilled */ }
      dialog.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => close(false));
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); close(false); });
    primary.addEventListener("click", () => {
      if (countdown) return; // already counting
      primary.setAttribute("disabled", "");
      countdown = startCountdown({
        onTick: (remaining) => {
          if (remaining > 0) {
            line.textContent = `Replacing in ${remaining}…`;
            primary.textContent = `${remaining}…`;
          } else {
            line.textContent = "Working…";
          }
        },
      });
      countdown.promise.then((ok) => {
        if (ok) close(true);
      });
    });
  });
}

async function runReplaceDeviceSheet() {
  const session = getSession();
  if (!session.umk || !session.username) {
    toast("Unlock the webapp first", "err");
    return;
  }
  // Sheet copy — VERBATIM from docs/revocation-ui.md § "Replace device
  // sheet copy". DO NOT REPHRASE.
  const confirmed = await openCountdownSheet({
    titleHtml: "Replace this device?",
    bodyHtml: `
      <p>Rotates your account's identity key. Every other device on this
      account — including this phone — will need to confirm a new pairing
      the next time it opens the app. You won't be locked out, but you'll
      see a one-time biometric prompt on each device.</p>
      <p>Servers stay running. Apps stay installed.</p>
    `,
    primaryLabel: "Replace",
    primaryClass: "danger",
  });
  if (!confirmed) return;

  const phase = openPhaseToast("Replace device");
  try {
    phase.update("signing", "Signing rotation request…");
    const oldVersion = currentIrkVersion();
    const result = await runReplaceDeviceCeremony(
      {
        username: session.username,
        umk: session.umk,
        currentVersion: oldVersion,
        ifMatch: state.etag,
      },
      { requestTotpProof: promptForTotpProof },
    );
    phase.update("posting", `Pending — completes ${formatCompletesAt(result.completesAt)}`);
    // Some accounts/policy paths complete immediately; the spec
    // optionally calls /complete now. Worker returns 425 if too early,
    // so we tolerate the early-call failure silently — UI surfaces the
    // pending state either way. On a successful complete, we bump the
    // webapp's local IRK version slot AND refresh the in-session IRK
    // so subsequent signing uses the rotated key.
    try {
      await completeReplaceDeviceCeremony({ username: session.username });
      phase.update("installing", "Installing new identity…");
      setCurrentIrkVersion(result.newVersion);
      await unlockSession(session.umk, session.username);
      phase.update("done", "Replace complete.");
    } catch (e) {
      if (e?.code === "425") {
        // Grace not elapsed — keep the rotation pending; the user can
        // come back to this view later and we'll detect a still-pending
        // row via /api/users/:u/re-pair (GET). For now we surface the
        // pending state and don't bump local IRK version yet.
        phase.update("done", "Pending — finish later from this screen.");
      } else if (e?.code === "404") {
        // No pending row server-side (already completed) — treat as
        // success and bump local version so subsequent signs match.
        setCurrentIrkVersion(result.newVersion);
        await unlockSession(session.umk, session.username);
        phase.update("done", "Replace complete.");
      } else {
        throw e;
      }
    }
    toast("Replace device — request accepted.");
    await renderTrustedDevices();
  } catch (e) {
    phase.update("error", e?.message ?? "Couldn't replace");
    toast(e?.message ?? "Replace failed", "err");
  } finally {
    phase.dismissAfter(3500);
  }
}

async function runWipeRestartSheet() {
  const session = getSession();
  if (!session.umk || !session.username) {
    toast("Unlock the webapp first", "err");
    return;
  }
  // Sheet copy — VERBATIM from docs/revocation-ui.md § "Wipe & restart
  // sheet copy". The user-facing `<u>` interpolation is the username
  // exactly as registered.
  const confirmed = await openCountdownSheet({
    titleHtml: "Wipe and start over?",
    bodyHtml: `
      <p>Your account keeps the username <strong>@${escapeHtml(session.username)}</strong>
      and your pods keep their data. Every device currently on this account
      will be disconnected. You'll re-pair each one fresh — including this
      phone, which becomes the new root of trust.</p>
      <p><strong>This can't be undone from another device.</strong></p>
    `,
    primaryLabel: "Wipe and start over",
    primaryClass: "danger",
  });
  if (!confirmed) return;

  // We need a fresh local passphrase for the re-bound UMK.
  const { inlinePrompt } = await import("../lib/modal.js");
  const newLocalPass = await inlinePrompt({
    title: "Set a new browser passphrase",
    message: "After the wipe, this browser will unlock with a new passphrase. Use 8+ characters.",
    placeholder: "New browser passphrase",
    type: "password",
    okLabel: "Continue",
    validate: (v) => (v && v.length >= 8 ? null : "Use at least 8 characters"),
  });
  if (!newLocalPass) return;

  const phase = openPhaseToast("Wipe & restart");
  try {
    phase.update("registering", "Registering new passkey…");
    phase.update("signing", "Signing wipe request…");
    const result = await runWipeRestartCeremony({
      username: session.username,
      umk: session.umk,
      ifMatch: state.etag,
    });
    phase.update("posting", "Server accepted; installing locally…");
    // Local install: drop the OLD wrapped UMK and re-bootstrap with
    // the NEW UMK under the user's new browser passphrase. Failure
    // here AFTER server-success matches the iOS "worst case" branch —
    // we surface a clear recovery hint.
    try {
      await resetDevice();
      // Fresh UMK = fresh v1 slot — the NEW IRK signed into wipe-restart
      // is `flagship.irk.v1` off the NEW UMK, so the local IRK version
      // resets to 1 for subsequent signing.
      setCurrentIrkVersion(1);
      await bootstrapFromExistingSeed(newLocalPass, result.newUmk);
      await unlockSession(result.newUmk, session.username);
    } catch (e) {
      phase.update(
        "error",
        `Server committed but local install failed: ${e?.message ?? e}. Re-open the app to recover.`,
      );
      toast("Server wiped — re-open the app to finish on this browser.", "err");
      return;
    }
    phase.update("done", "Wipe complete. New account key installed.");
    toast("Wipe & restart complete.");
    await renderTrustedDevices();
  } catch (e) {
    phase.update("error", e?.message ?? "Couldn't wipe");
    toast(e?.message ?? "Wipe failed", "err");
  } finally {
    phase.dismissAfter(4000);
  }
}

/** Lightweight phased-progress UI. Mirrors the iOS Phase enums — we
 *  render the latest phase as a sticky note above the device list. */
function openPhaseToast(action) {
  const root = $("trusted-devices-list");
  let bar = document.getElementById("ceremony-phase-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "ceremony-phase-bar";
    bar.className = "card mt-2";
    bar.setAttribute("aria-live", "polite");
    if (root && root.parentElement) {
      root.parentElement.insertBefore(bar, root);
    } else {
      document.body.appendChild(bar);
    }
  }
  const setText = (phase, message) => {
    bar.innerHTML = `<div class="weight-600">${escapeHtml(action)}</div>
      <p class="note small" data-phase="${escapeHtml(phase)}">${escapeHtml(message)}</p>`;
  };
  setText("idle", "Starting…");
  return {
    update: setText,
    dismissAfter(ms) {
      setTimeout(() => { bar.remove(); }, ms);
    },
  };
}

/** v1.2 — multi-device accounts need a TOTP proof beside the signed
 *  envelope. The ceremony helper calls this when the Worker returns
 *  401 + accountType:"multi"; we open a single-input prompt for the
 *  6-digit code (or a recovery-format code) and pass it back. The
 *  ceremony then retries with the proof attached. Returning `null`
 *  cancels and surfaces a friendly "cancelled" error. */
async function promptForTotpProof() {
  const { inlinePrompt } = await import("../lib/modal.js");
  const code = await inlinePrompt({
    title: "Enter your TOTP code",
    message:
      "This account requires a 6-digit code from your authenticator app, " +
      "or a recovery code if you've lost the device with the authenticator.",
    placeholder: "123456",
    type: "text",
    okLabel: "Continue",
    validate: (v) => (v && v.length >= 6 ? null : "Enter the 6-digit code or a recovery code"),
  });
  if (!code) return null;
  // Heuristic: pure-numeric 6-8 digits → TOTP; anything else → recovery.
  const method = /^\d{6,8}$/.test(code) ? "totp" : "recovery";
  return { code, method };
}

function formatCompletesAt(ms) {
  if (typeof ms !== "number" || !ms) return "soon";
  return formatWhen(ms);
}

export function initTrustedDevicesView() {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-trusted-devices") {
      renderTrustedDevices().catch(() => {});
    }
  });
  $("trusted-devices-back")?.addEventListener("click", () => show("view-settings"));
  // Phase 3b — cross-device QR pairing: the admin generates a pairing QR
  // and seals the account keys to a freshly-scanned-in collaborator
  // device (which joins QUARANTINED for 14 days).
  $("trusted-devices-add")?.addEventListener("click", async () => {
    try {
      const { enterAddDevice } = await import("./add-device.js");
      await enterAddDevice();
    } catch (e) {
      console.error(e);
      toast(humanError(e), "err");
    }
  });
}

// Public re-render hook for tests and integration code that wants to
// pump the view without a router event.
export { renderTrustedDevices };
