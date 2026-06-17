// P14 — Companion-browser dock view.
//
// Router slot: section id `view-companion-dock`. Reached from
// Settings → Dock a browser. Surfaces:
//   1. "Dock a browser" mint button → renders a QR + raw URL in a dialog;
//      the companion device scans + lands at the receiver-flow in app.js.
//   2. Active-companions list (tokenPrefix + label + expiresAt), with a
//      revoke button per row.
//   3. Empty state ("no companion browsers docked").
//
// The QR payload is `https://web.flagshipserver.com/?companion=<base64url
// JSON>` where the JSON is `{ ticketId, ticketSecret, podBaseUrl, username }`.
// The ticket TTL on the daemon is 60s, so even a leaked screenshot of the
// QR can't be redeemed after a minute.
//
// BFF endpoints consumed (P14 wave 1):
//   POST /api/screens/companion/mint-ticket  → { ticketId, ticketSecret, expiresAt }
//   GET  /api/screens/companion/list         → { companions: [{...}] }
//   POST /api/screens/companion/revoke       { tokenPrefix }

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import {
  buildCompanionReceiverUrl,
  companionList,
  companionMintTicket,
  companionRevoke,
} from "../lib/companionClient.js";

registerView("view-companion-dock");

function fmtDate(unixMs) {
  if (typeof unixMs !== "number" || unixMs <= 0) return "—";
  return new Date(unixMs).toLocaleString();
}

function timeLeft(expiresAt, nowMs = Date.now()) {
  const ms = expiresAt - nowMs;
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export async function renderCompanionDock() {
  const root = $("companion-dock-content");
  if (!root) return;
  root.innerHTML = '<div class="card placeholder">loading…</div>';

  let body;
  try {
    body = await companionList();
  } catch (e) {
    if (e instanceof ScreensError) {
      if (e.status === 503) {
        root.innerHTML = `
          <div class="card placeholder">
            Companion dock isn't available on this server yet — the daemon
            is running an older build (pre-P14). Update the daemon to
            enable docking a browser as a remote-control surface.
          </div>
        `;
        return;
      }
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
      return;
    }
    throw e;
  }

  const companions = body.companions ?? [];
  const mintCard = `
    <div class="card">
      <div class="weight-600">Dock a browser</div>
      <p class="note">
        Pair a regular browser (e.g. a library iMac, a friend's laptop)
        as a read-only companion for the next 4 hours. The companion
        can view your dashboards but can't sign — to approve a change,
        come back to this device.
      </p>
      <input id="companion-mint-label" type="text" placeholder="Label (e.g. 'Library iMac')" autocomplete="off" maxlength="64" />
      <button id="companion-mint-btn" class="full-width mt-2">Mint a QR</button>
    </div>
  `;

  const listCard = companions.length === 0
    ? `
      <h3 class="mt-4">Active companions</h3>
      <div class="card placeholder">no companion browsers docked</div>
    `
    : `
      <h3 class="mt-4">Active companions</h3>
      ${companions.map((c) => `
        <div class="card">
          <div class="row row-top">
            <div>
              <div class="weight-600">${escapeHtml(c.label ?? "(no label)")}</div>
              <div class="value text-xs">${escapeHtml(c.tokenPrefix)}…</div>
              <div class="faint-sm">
                docked ${escapeHtml(fmtDate(c.redeemedAt))}
                · ${escapeHtml(timeLeft(c.expiresAt))}
              </div>
              ${c.userAgent ? `<div class="faint-sm">${escapeHtml(c.userAgent)}</div>` : ""}
            </div>
            <button class="secondary" data-action="revoke" data-prefix="${escapeHtml(c.tokenPrefix)}">revoke</button>
          </div>
        </div>
      `).join("")}
    `;

  root.innerHTML = mintCard + listCard;
  $("companion-mint-btn")?.addEventListener("click", () => runMint());
  root.querySelectorAll('[data-action="revoke"]').forEach((b) => {
    b.addEventListener("click", () => runRevoke(b.getAttribute("data-prefix")));
  });
}

async function runMint() {
  const btn = $("companion-mint-btn");
  const labelInput = $("companion-mint-label");
  const label = (labelInput?.value ?? "").trim().slice(0, 64) || null;
  if (btn) { btn.disabled = true; btn.textContent = "minting…"; }
  try {
    const mint = await companionMintTicket({ label });
    // Resolve the pod base URL + username for the QR payload. We get them
    // from the api.js + active profile so the receiver knows where to land.
    const { getPodBaseUrl } = await import("../lib/api.js");
    const { get: profileGet } = await import("../lib/profilesStore.js");
    const podBaseUrl = getPodBaseUrl();
    // `username` is device-wide-or-pre-profile, so the store's `get(...)`
    // already falls through to the legacy flat key when no profile is active.
    const username = profileGet("username") ?? "";
    if (!podBaseUrl) throw new Error("missing podBaseUrl — re-pair your device first");
    if (!username) throw new Error("missing username — finish first-run wizard first");

    const qrUrl = buildCompanionReceiverUrl({
      ticketId: mint.ticketId,
      ticketSecret: mint.ticketSecret,
      podBaseUrl,
      username,
    });
    await showQrDialog({
      url: qrUrl,
      expiresAt: mint.expiresAt,
      label,
    });
    await renderCompanionDock();
  } catch (e) {
    toast(e.message ?? String(e), "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Mint a QR"; }
  }
}

async function showQrDialog({ url, expiresAt, label }) {
  // Render an inline <dialog> with the QR SVG + the URL as fallback.
  // The qrEncoder module is the same one heroQr.js uses on the
  // marketing landing page; importing the absolute path keeps the
  // module shared across the bundle.
  let dialog = $("companion-qr-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "companion-qr-dialog";
    dialog.className = "modal";
    document.body.appendChild(dialog);
  }
  const ttlMs = expiresAt - Date.now();
  const ttlSec = Math.max(0, Math.floor(ttlMs / 1000));

  let qrSvg = "";
  try {
    const m = await import("/qrEncoder.js");
    qrSvg = m.renderQrSvg(url, {
      size: 260,
      foreground: "#0A0A09",
      background: "#ffffff",
    });
  } catch (e) {
    qrSvg = `<p class="err-text">QR render failed: ${escapeHtml(String(e?.message ?? e))}</p>`;
  }

  dialog.innerHTML = `
    <div class="modal-card">
      <h3>Dock this browser</h3>
      <p class="note">
        Open the companion browser, then either scan this QR or paste
        the link. The ticket expires in ${ttlSec}s — leaving this dialog
        open will not extend it.
      </p>
      <div class="qr-box" style="background:#fff;padding:12px;border-radius:8px;display:flex;justify-content:center">${qrSvg}</div>
      ${label ? `<p class="note">Label: <strong>${escapeHtml(label)}</strong></p>` : ""}
      <p class="note">Link (fallback):</p>
      <code class="break-all faint-sm" id="companion-qr-url">${escapeHtml(url)}</code>
      <div class="row-2 mt-2">
        <button id="companion-qr-copy">Copy link</button>
        <button class="secondary" id="companion-qr-close">Close</button>
      </div>
    </div>
  `;
  dialog.showModal?.();
  await new Promise((resolve) => {
    const close = () => {
      try { dialog.close(); } catch { /* ignore */ }
      resolve(undefined);
    };
    dialog.querySelector("#companion-qr-close")?.addEventListener("click", close, { once: true });
    dialog.querySelector("#companion-qr-copy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard?.writeText?.(url);
        toast("copied");
      } catch {
        toast("copy not supported in this browser", "err");
      }
    });
    dialog.addEventListener("close", () => resolve(undefined), { once: true });
  });
}

async function runRevoke(prefix) {
  if (!prefix) return;
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: `Revoke companion ${prefix}…?`,
    message: "The companion browser using this session will be signed out immediately.",
    okLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;
  try {
    await companionRevoke(prefix);
    toast("revoked");
    await renderCompanionDock();
  } catch (e) {
    toast(e.message ?? String(e), "err");
  }
}

export function initCompanionDockView() {
  $("companion-dock-back")?.addEventListener("click", () => show("view-settings-tab"));
  $("companion-dock-refresh")?.addEventListener("click", () => {
    renderCompanionDock().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterCompanionDock() {
  show("view-companion-dock");
  await renderCompanionDock();
}
