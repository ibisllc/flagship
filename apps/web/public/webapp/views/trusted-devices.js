// Trusted devices — peer-class devices on the user's account (push-
// token holders). Mirror of FlagshipUI/Screens/SettingsScreen.swift
// and TrustedDevicesScreen.kt; on the webapp the surface is
// read+manage-only (the webapp itself is a per-pod browser session,
// not a peer trusted device — it never gets its own UMK).
//
// Wire shapes match the Worker (packages/control-plane/src/usersDevices.ts):
//   GET /api/users/:u/devices       → { devices: [{tokenId,…}] } + ETag
//   DELETE /api/push/<tokenId>      → revoke push tether (soft revoke)

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";

registerView("view-trusted-devices");

const COM_BASE = "https://flagshipserver.com";

/** Cached state: last-fetched devices + ETag for the If-Match flow. */
const state = {
  username: "",
  devices: [],
  etag: null,
};

function platformIcon(p) {
  return ({
    apns: "📱",
    fcm: "🤖",
    webpush: "🌐",
  })[p] ?? "❔";
}

function platformDisplay(p) {
  return ({
    apns: "iPhone / iPad",
    fcm: "Android",
    webpush: "Web",
  })[p] ?? p;
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
    state.etag = null;
    return;
  }
  state.username = username;
  const r = await fetch(`${COM_BASE}/api/users/${encodeURIComponent(username)}/devices`, {
    method: "GET",
    cache: "no-store",
  });
  if (!r.ok) {
    state.devices = [];
    state.etag = null;
    throw new Error(`Couldn't fetch trusted devices (${r.status})`);
  }
  state.etag = r.headers.get("etag");
  const body = await r.json();
  state.devices = body.devices ?? [];
}

async function disconnectDevice(device) {
  // Same DELETE endpoint mobile uses. Webapp doesn't sign the request
  // body (mobile does for IRK proof) — the Worker accepts un-signed
  // DELETE today (per packages/control-plane/src/push.ts comment).
  // A future commit can layer an IRK signature via the umk in
  // localStorage if available.
  const r = await fetch(`${COM_BASE}/api/push/${encodeURIComponent(device.tokenId)}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`Disconnect failed (${r.status})`);
  }
}

function renderDeviceCard(device) {
  return `
    <div class="card" data-token-prefix="${escapeHtml(device.tokenPrefix)}">
      <div class="row">
        <div class="weight-600">
          <span aria-hidden="true">${platformIcon(device.platform)}</span>
          ${escapeHtml(device.label || `Untitled ${device.platform}`)}
        </div>
        <button class="secondary danger" data-disconnect="${escapeHtml(device.tokenId)}">
          Disconnect
        </button>
      </div>
      <div class="note small">
        ${escapeHtml(platformDisplay(device.platform))}
        · added ${escapeHtml(relative(device.addedAt))}
        ${
          device.lastSeenAt > device.addedAt
            ? `· last seen ${escapeHtml(relative(device.lastSeenAt))}`
            : ""
        }
      </div>
    </div>
  `;
}

/** Danger zone: visible-but-explanatory v1 Wipe & restart entry.
 *  Mirrors the iOS B8 / Android C8 "Coming soon" pattern — the option
 *  needs to be visible so users see it exists and is being designed
 *  (hiding it leaves them wondering what their last-resort options
 *  are), and the actual ceremony lands as E6's v1.1 follow-up. */
function renderDangerZone() {
  return `
    <hr class="mt-4" />
    <h3 class="mt-2">Danger zone</h3>
    <p class="note small">
      Lost a device or worried about a stolen one? These actions rotate
      your account's identity keys, disconnecting every device on this
      account in one shot.
    </p>
    <div class="card" data-section="wipe-restart">
      <div class="row">
        <div class="weight-600">
          <span aria-hidden="true">🗑️</span>
          Wipe &amp; restart
        </div>
        <button class="secondary" id="wipe-restart-btn">Learn more</button>
      </div>
      <p class="note small">
        Coming in v1.1. Rotates your account identity + recovery passkey
        in one ceremony. Pods stay running; apps stay installed; every
        other device re-pairs fresh on next open.
      </p>
    </div>
  `;
}

async function showWipeComingSoon() {
  const { inlineConfirm } = await import("../lib/modal.js");
  await inlineConfirm({
    title: "Wipe & restart — coming in v1.1",
    message:
      "Rotates your account identity AND recovery passkey in one ceremony. " +
      "Every device currently on this account — including this browser — " +
      "gets disconnected and re-pairs fresh. Pods keep running; apps stay " +
      "installed. Shipping in v1.1 once the ceremony has been live-exercised " +
      "across iPhone, Android, and webapp. For now use Disconnect above, or " +
      "wait for Replace device to land first.",
    okLabel: "Got it",
    danger: false,
  });
}

async function renderTrustedDevices() {
  const root = $("trusted-devices-list");
  if (!root) return;
  root.innerHTML = `<div class="card placeholder">Loading devices…</div>`;
  try {
    await fetchDevices();
    if (state.devices.length === 0) {
      root.innerHTML = `
        <div class="card">
          <div class="weight-600">Just this device</div>
          <p class="note small">
            Sign in on a phone or tablet to add a trusted device. Browser
            sessions like this webapp aren't trusted devices — they're
            per-pod paired tokens, listed under "Browser sessions" instead.
          </p>
        </div>
        ${renderDangerZone()}`;
      bindDangerZone();
      return;
    }
    root.innerHTML = state.devices.map(renderDeviceCard).join("") + renderDangerZone();
    root.querySelectorAll("[data-disconnect]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const tokenId = ev.currentTarget.getAttribute("data-disconnect");
        const device = state.devices.find((d) => d.tokenId === tokenId);
        if (!device) return;
        const { inlineConfirm } = await import("../lib/modal.js");
        const ok = await inlineConfirm({
          title: `Disconnect ${device.label}?`,
          message: `We'll stop sending alerts to ${device.label}. It can sign back in with your passkey.`,
          okLabel: "Disconnect",
          danger: true,
        });
        if (!ok) return;
        try {
          await disconnectDevice(device);
          toast(`Disconnected ${device.label}`);
          await renderTrustedDevices();
        } catch (e) {
          toast(e.message ?? "Couldn't disconnect", "err");
        }
      });
    });
    bindDangerZone();
  } catch (e) {
    root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(e.message ?? "Couldn't load devices")}</div>`;
  }
}

function bindDangerZone() {
  document.getElementById("wipe-restart-btn")?.addEventListener("click", () => {
    showWipeComingSoon().catch(() => {});
  });
}

export function initTrustedDevicesView() {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-trusted-devices") {
      renderTrustedDevices().catch(() => {});
    }
  });
  $("trusted-devices-back")?.addEventListener("click", () => show("view-settings"));
}

// Public re-render hook for tests and integration code that wants to
// pump the view without a router event.
export { renderTrustedDevices };
