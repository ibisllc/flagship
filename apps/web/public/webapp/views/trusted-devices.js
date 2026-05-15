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
        </div>`;
      return;
    }
    root.innerHTML = state.devices.map(renderDeviceCard).join("");
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
  } catch (e) {
    root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(e.message ?? "Couldn't load devices")}</div>`;
  }
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
