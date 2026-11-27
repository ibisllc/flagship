// Trusted devices are loaded only through the signed account directory.
// Human names are decrypted in this unlocked client and never returned by
// the control plane.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { getSession, unlockSession } from "../lib/state.js";
import { isAdminDevice } from "../lib/memberRoles.js";
import { ADD_DEVICE_ADMIN_ONLY } from "../lib/crossDevicePairing.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { formatWhen } from "../lib/dateFormat.js";
import {
  completeReplaceDeviceCeremony,
  fetchPendingRePair,
} from "../lib/replaceDeviceCeremony.js";
import { currentIrkVersion, setCurrentIrkVersion } from "../keystore.js";
import { renderPendingBanner, shouldRenderBanner } from "../lib/pendingRePairBanner.js";
import {
  VETO_CONFIRM_MESSAGE,
  VETO_CONFIRM_TITLE,
  renderRecoveryReview,
  shouldRenderRecoveryReview,
  submitRecoveryVeto,
} from "../lib/recoveryVeto.js";
import {
  fetchDecryptedDirectory,
  removeAccountDevice,
  removeManagedDeviceDisplayName,
  setManagedDeviceDisplayName,
  updateAccountDisplayName,
  updateSelfDisplayName,
} from "../lib/accountDirectory.js";

import { tr } from "../lib/i18n.js";
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
    windows: tr("Windows PC"),
    linux: tr("Linux PC"),
  })[p] ?? (p || tr("Unknown platform"));
}

/** The name shown for a device row. Never renders the literal string
 *  "undefined": falls back to a platform-derived label, then a short
 *  token id, then a generic name — so a record missing its `label`
 *  (or `label` AND `platform`) still reads sensibly. */
function deviceName(device) {
  if (device.displayName) return device.displayName;
  return tr("{0} · Device {1}", platformDisplay(device.platformClass), device.supportCode ?? device.deviceId.slice(0, 8));
}

function relative(ms) {
  if (!ms) return "unknown";
  const d = Date.now() - ms;
  const s = Math.max(0, Math.floor(d / 1000));
  if (s < 60) return tr("just now");
  if (s < 3600) return tr("{0}m ago", Math.floor(s / 60));
  if (s < 86_400) return tr("{0}h ago", Math.floor(s / 3600));
  return tr("{0}d ago", Math.floor(s / 86_400));
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
  if (!until) return tr("This device is in quarantine. Use another device.");
  return tr("Quarantined until {0}. Use another device.", formatWhen(until));
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
          ${device.isCurrent ? `<span class="pill">${tr("This device")}</span>` : ""}
          ${device.grant?.signerRoot === "admin-root" ? `<span class="pill">${tr("Administrator")}</span>` : ""}
          ${device.managed ? `<span class="pill">${device.locked ? tr("Managed · locked") : tr("Managed")}</span>` : ""}
        </div>
      </div>
      <div class="note small">
        ${device.lastSeenAt > device.createdAt
          ? tr("{0} · Device {1} · added {2} · last seen {3}", escapeHtml(platformDisplay(device.platformClass)), escapeHtml(device.supportCode ?? device.deviceId.slice(0, 8)), escapeHtml(relative(device.createdAt)), escapeHtml(relative(device.lastSeenAt)))
          : tr("{0} · Device {1} · added {2}", escapeHtml(platformDisplay(device.platformClass)), escapeHtml(device.supportCode ?? device.deviceId.slice(0, 8)), escapeHtml(relative(device.createdAt)))}
      </div>
      <div class="row mt-2">
        ${device.isCurrent ? `<button class="secondary" data-self-rename="${escapeHtml(device.deviceId)}">${tr("Rename this device")}</button>` : ""}
        ${getSession().adminRootSeed ? `<button class="secondary" data-managed-name="${escapeHtml(device.deviceId)}">${device.managed ? tr("Edit managed name") : tr("Set managed name")}</button>` : ""}
        ${device.managed && getSession().adminRootSeed ? `<button class="secondary" data-managed-remove="${escapeHtml(device.deviceId)}">${tr("Remove managed name")}</button>` : ""}
        ${device.isCurrent ? "" : `<button class="secondary danger" data-remove-device="${escapeHtml(device.deviceId)}">${tr("Remove from account")}</button>`}
      </div>
      ${quarantined
        ? `<div class="note small err-text">${escapeHtml(quarantineMsg)}</div>`
        : ""}
    </div>
  `;
}

function renderAddDeviceGate() {
  const btn = $("trusted-devices-add");
  if (!btn) return;
  const admin = isAdminDevice(getSession());
  btn.disabled = !admin;
  let note = $("trusted-devices-add-note");
  if (!admin && !note) {
    note = document.createElement("p");
    note.id = "trusted-devices-add-note";
    note.className = "note small";
    note.textContent = ADD_DEVICE_ADMIN_ONLY;
    btn.insertAdjacentElement("afterend", note);
  } else if (admin && note) note.remove();
}

async function renderTrustedDevices() {
  const root = $("trusted-devices-list");
  if (!root) return;
  renderAddDeviceGate();
  root.innerHTML = `<div class="card placeholder">${tr("Loading devices…")}</div>`;
  try {
    await fetchDevices();
    await fetchPendingRePairSnapshot();
    state.ownReplace = await isOwnReplacement(state.pendingRePair);
    const bannerHtml = (!state.ownReplace && renderRecoveryReview(state.pendingRePair, isAdminDevice(getSession()))) || renderPendingBanner(state.pendingRePair);
    if (state.devices.length === 0) {
      root.innerHTML = `
        ${bannerHtml}
        <div class="card">
          <div class="weight-600">${tr("Just this device")}</div>
          <p class="note small">
            ${tr("Sign in on a phone or tablet to add a trusted device.")}
          </p>
        </div>`;
      bindPendingBanner();
      return;
    }
    const accountHeader = `
      <div class="card">
        <div class="weight-600">${escapeHtml(state.accountDisplayName ?? `@${state.username}`)}</div>
        <div class="note small">${tr("@{0} · public routing address", escapeHtml(state.username))}</div>
        ${getSession().adminRootSeed ? `<button class="secondary mt-2" id="edit-account-display-name">${tr("Edit account name")}</button>` : ""}
      </div>`;
    root.innerHTML = bannerHtml + accountHeader + state.devices.map(renderDeviceCard).join("");
    bindPrivateNameActions(root);
    bindRemoveDevice(root);
    bindPendingBanner();
  } catch (e) {
    root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(e.message ?? tr("Couldn't load devices"))}</div>`;
  }
}

function bindPrivateNameActions(root) {
  document.getElementById("edit-account-display-name")?.addEventListener("click", async () => {
    const { inlinePrompt } = await import("../lib/modal.js");
    const name = await inlinePrompt({
      title: tr("Edit account name"),
      message: tr("Encrypted presentation only. Your public routing username does not change."),
      initial: state.accountDisplayName ?? "",
      validate: (value) => value?.trim() ? null : tr("Enter an account name"),
    });
    if (!name) return;
    try {
      await updateAccountDisplayName(name, state.accountProfile);
      toast(tr("Account name updated"));
      await renderTrustedDevices();
    } catch (error) {
      toast(error?.message ?? tr("Couldn't update account name"), "err");
    }
  });
  root.querySelectorAll("[data-self-rename]").forEach((button) => button.addEventListener("click", async () => {
    const deviceId = button.getAttribute("data-self-rename");
    const device = state.devices.find((item) => item.deviceId === deviceId);
    const current = state.selfProfiles.find((item) => item.deviceId === deviceId) ?? null;
    const { inlinePrompt } = await import("../lib/modal.js");
    const name = await inlinePrompt({
      title: tr("Rename this device"),
      message: tr("This name applies only inside this Flagship account."),
      initial: device?.selfDisplayName ?? "",
      validate: (value) => value?.trim() ? null : tr("Enter a device name"),
    });
    if (!name) return;
    try {
      await updateSelfDisplayName(name, current);
      toast(device?.managed ? tr("Suggestion saved; the managed name remains visible") : tr("Device renamed"));
      await renderTrustedDevices();
    } catch (error) {
      toast(error?.message ?? tr("Couldn't rename device"), "err");
    }
  }));
  root.querySelectorAll("[data-managed-name]").forEach((button) => button.addEventListener("click", async () => {
    const deviceId = button.getAttribute("data-managed-name");
    const device = state.devices.find((item) => item.deviceId === deviceId);
    const current = state.managedProfiles.find((item) => item.deviceId === deviceId) ?? null;
    const { inlineConfirm, inlinePrompt } = await import("../lib/modal.js");
    if (!await inlineConfirm({ title: tr("Administrator change"), message: tr("Use your unlocked administrator authority to manage this device name."), okLabel: tr("Continue") })) return;
    const name = await inlinePrompt({
      title: tr("Managed device name"),
      message: tr("This encrypted name overrides the device's own suggestion."),
      initial: device?.managedDisplayName ?? device?.selfDisplayName ?? "",
      validate: (value) => value?.trim() ? null : tr("Enter a device name"),
    });
    if (!name) return;
    const locked = await inlineConfirm({ title: tr("Lock this name?"), message: tr("A locked managed name stays effective until an administrator removes or unlocks it."), okLabel: tr("Lock name"), cancelLabel: tr("Leave unlocked") });
    try {
      await setManagedDeviceDisplayName(deviceId, name, locked, current);
      toast(tr("Managed name updated"));
      await renderTrustedDevices();
    } catch (error) {
      toast(error?.message ?? tr("Couldn't manage device name"), "err");
    }
  }));
  root.querySelectorAll("[data-managed-remove]").forEach((button) => button.addEventListener("click", async () => {
    const deviceId = button.getAttribute("data-managed-remove");
    const current = state.managedProfiles.find((item) => item.deviceId === deviceId) ?? null;
    const { inlineConfirm } = await import("../lib/modal.js");
    if (!await inlineConfirm({ title: tr("Remove managed name?"), message: tr("The device's own encrypted suggestion becomes visible."), okLabel: tr("Remove"), danger: true })) return;
    try {
      await removeManagedDeviceDisplayName(deviceId, current);
      toast(tr("Managed name removed"));
      await renderTrustedDevices();
    } catch (error) {
      toast(error?.message ?? tr("Couldn't remove managed name"), "err");
    }
  }));
}

/** The words of "Remove from account" (docs/revocation-ui.md). Exported for tests. */
export const REMOVE_DEVICE_COPY = Object.freeze({
  action: tr("Remove from account"),
  title: (name) => tr("Remove {0} from your account?", name),
  message: tr("It loses access to your account and your servers. The next time it goes online, Flagship erases your account's keys from it."),
  failedTitle: tr("Couldn't remove the device"),
  notAllowed: tr("Only an admin device of this account can remove other devices."),
  fallback: tr("Check your connection and try again."),
  removed: tr("Device removed"),
});

/** Why a removal failed, in words the person can act on. Exported for tests. */
export function removeDeviceErrorText(e) {
  if (e?.rateLimited === true && typeof e.message === "string") return e.message;
  if (e?.status === 403) return REMOVE_DEVICE_COPY.notAllowed;
  const text = humanError(e);
  return text === humanError(null) ? REMOVE_DEVICE_COPY.fallback : text;
}

/**
 * Ask, then remove the device. The steps are a list so a later one (e.g. "Could someone else unlock this
 * device?") slots in between asking and removing without touching the rest.
 */
export async function removeDeviceFlow(device, deps = {}) {
  const modal = deps.modal ?? (await import("../lib/modal.js"));
  const name = deviceName(device);
  const ok = await modal.inlineConfirm({
    title: REMOVE_DEVICE_COPY.title(name),
    message: REMOVE_DEVICE_COPY.message,
    okLabel: REMOVE_DEVICE_COPY.action,
    danger: true,
  });
  if (!ok) return false;
  try {
    await (deps.remove ?? removeAccountDevice)(device.deviceId);
  } catch (error) {
    console.error("remove device failed", error);
    await modal.inlineAlert({ title: REMOVE_DEVICE_COPY.failedTitle, message: removeDeviceErrorText(error) });
    return false;
  }
  return true;
}

function bindRemoveDevice(root) {
  root.querySelectorAll("[data-remove-device]").forEach((button) => button.addEventListener("click", async () => {
    const deviceId = button.getAttribute("data-remove-device");
    const device = state.devices.find((item) => item.deviceId === deviceId);
    if (!device || device.isCurrent) return;
    if (await removeDeviceFlow(device)) {
      toast(REMOVE_DEVICE_COPY.removed);
      await renderTrustedDevices();
    }
  }));
}

/**
 * Is the waiting recovery THIS device's own replacement (the key it would install next)? Then it
 * finalizes it; anyone else's is something an admin reviews and may reject. A snapshot that does
 * not name the new key is treated as this device's own, as before.
 */
async function isOwnReplacement(snapshot) {
  const named = snapshot?.pending?.newIrkPub;
  if (typeof named !== "string") return true;
  const umk = getSession()?.umk;
  if (!umk) return true;
  try {
    const { deriveIrkVersioned, bytesToHex } = await import("../keystore.js");
    const next = await deriveIrkVersioned(umk, currentIrkVersion() + 1);
    return bytesToHex(next.publicKey) === named.toLowerCase();
  } catch {
    return true;
  }
}

function bindPendingBanner() {
  if (!state.ownReplace && shouldRenderRecoveryReview(state.pendingRePair, isAdminDevice(getSession()))) {
    document.getElementById("reject-recovery-btn")?.addEventListener("click", async () => {
      const { inlineConfirm } = await import("../lib/modal.js");
      const ok = await inlineConfirm({ title: VETO_CONFIRM_TITLE, message: VETO_CONFIRM_MESSAGE, okLabel: tr("Reject recovery"), danger: true });
      if (!ok) return;
      try {
        const session = getSession();
        await submitRecoveryVeto({ username: state.username, pending: state.pendingRePair.pending, adminRootSeed: session.adminRootSeed });
        toast(tr("Recovery rejected"));
        await renderTrustedDevices();
      } catch (e) {
        toast(e?.message ?? tr("Couldn't reject the recovery"), "err");
      }
    });
    return;
  }
  if (!shouldRenderBanner(state.pendingRePair)) return;
  document.getElementById("finalize-replace-btn")?.addEventListener("click", () => {
    finalizePendingReplace().catch((e) => toast(e?.message ?? tr("Finalize failed"), "err"));
  });
}

async function finalizePendingReplace() {
  const session = getSession();
  if (!session.umk || !session.username) {
    toast(tr("Unlock the webapp first"), "err");
    return;
  }
  const phase = openPhaseToast(tr("Finalize replace"));
  try {
    phase.update("installing", tr("Installing new identity…"));
    const out = await completeReplaceDeviceCeremony({
      username: session.username,
      // The finalization is signed by the key being installed — the
      // next rotation slot after the one this device is signing with.
      umk: session.umk,
      newVersion: currentIrkVersion() + 1,
    });
    // Bump the local IRK slot so subsequent signs use the rotated key.
    setCurrentIrkVersion(currentIrkVersion() + 1);
    await unlockSession(session.umk, session.username);
    phase.update("done", tr("Replace complete."));
    toast(tr("Replace complete."));
    state.pendingRePair = null;
    await renderTrustedDevices();
  } catch (e) {
    phase.update("error", e?.message ?? tr("Couldn't finalize"));
    toast(e?.message ?? tr("Finalize failed"), "err");
  } finally {
    phase.dismissAfter(3500);
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
  setText("idle", tr("Starting…"));
  return {
    update: setText,
    dismissAfter(ms) {
      setTimeout(() => { bar.remove(); }, ms);
    },
  };
}

export function initTrustedDevicesView() {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-trusted-devices") {
      renderTrustedDevices().catch(() => {});
    }
  });
  $("trusted-devices-back")?.addEventListener("click", () => show("view-settings-tab"));
  // Phase 3b — cross-device QR pairing: the admin generates a pairing QR
  // and seals the account keys to a freshly-scanned-in collaborator
  // device (which joins QUARANTINED for 14 days).
  $("trusted-devices-add")?.addEventListener("click", async () => {
    if (!isAdminDevice(getSession())) return toast(ADD_DEVICE_ADMIN_ONLY, "err");
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
