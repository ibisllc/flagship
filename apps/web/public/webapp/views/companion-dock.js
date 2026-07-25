// P14 — browser-remote view.
//
// Router slot: section id `view-companion-dock`. Reached from
// Settings → Remote. Surfaces:
//   1. A pointer to the browser-initiated ceremony at remote.<apex>. The
//      desktop owns the QR; the keyholder phone only scans and approves it.
//   2. Active-remotes list (tokenPrefix + label + expiresAt), with a
//      revoke button per row.
//   3. Empty state ("no browsers connected").
//
// BFF endpoints consumed:
//   GET  /api/screens/companion/list         → { companions: [{...}] }
//   POST /api/screens/companion/revoke       { tokenPrefix }

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import {
  companionList,
  companionRevoke,
} from "../lib/companionClient.js";
import { remoteOrigin } from "../lib/apex.js";

registerView("view-companion-dock");

function fmtDate(unixMs) {
  if (typeof unixMs !== "number" || unixMs <= 0) return "—";
  return formatWhen(unixMs);
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
            Remote isn't available on this server yet — the daemon is
            running an older build (pre-P14). Update the daemon to let a
            browser drive this server.
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
  const startCard = `
    <div class="card">
      <div class="weight-600">Use a browser as a remote</div>
      <p class="note">
        On the computer you want to use, open <code>${escapeHtml(new URL(remoteOrigin()).host)}</code>.
        It will show a one-time QR for this phone to scan and approve on your phone.
      </p>
      <a class="btn full-width mt-2" href="${escapeHtml(remoteOrigin())}/" target="_blank" rel="noopener">Open the remote page</a>
    </div>
  `;

  const listCard = companions.length === 0
    ? `
      <h3 class="mt-4">Connected browsers</h3>
      <div class="card placeholder">no browsers connected</div>
    `
    : `
      <h3 class="mt-4">Connected browsers</h3>
      ${companions.map((c) => `
        <div class="card">
          <div class="row row-top">
            <div>
              <div class="weight-600">Session ${escapeHtml(c.tokenPrefix)}</div>
              <div class="value text-xs">${escapeHtml(c.tokenPrefix)}…</div>
              <div class="faint-sm">
                connected ${escapeHtml(fmtDate(c.redeemedAt))}
                · ${escapeHtml(timeLeft(c.expiresAt))}
              </div>
              ${c.userAgent ? `<div class="faint-sm">${escapeHtml(c.userAgent)}</div>` : ""}
            </div>
            <button class="secondary" data-action="revoke" data-prefix="${escapeHtml(c.tokenPrefix)}">revoke</button>
          </div>
        </div>
      `).join("")}
    `;

  root.innerHTML = startCard + listCard;
  root.querySelectorAll('[data-action="revoke"]').forEach((b) => {
    b.addEventListener("click", () => runRevoke(b.getAttribute("data-prefix")));
  });
}

async function runRevoke(prefix) {
  if (!prefix) return;
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: `Disconnect remote ${prefix}…?`,
    message: "The browser using this session will be signed out immediately.",
    okLabel: "Disconnect",
    danger: true,
  });
  if (!ok) return;
  try {
    await companionRevoke(prefix);
    toast("Disconnected");
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
