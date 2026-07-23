// P14 — Companion-browser dock view.
//
// Router slot: section id `view-companion-dock`. Reached from
// Settings → Dock a browser. Surfaces:
//   1. A pointer to the browser-initiated `/dock` ceremony. The desktop owns
//      the QR; the keyholder phone only scans and approves it.
//   2. Active-companions list (tokenPrefix + label + expiresAt), with a
//      revoke button per row.
//   3. Empty state ("no companion browsers docked").
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
  const startCard = `
    <div class="card">
      <div class="weight-600">Dock a browser</div>
      <p class="note">
        On the browser you want to use, open the dock page. It will show a
        one-time QR for this phone to scan and approve with Face ID.
      </p>
      <a class="btn full-width mt-2" href="/dock" target="_blank" rel="noopener">Open dock page</a>
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
              <div class="weight-600">Session ${escapeHtml(c.tokenPrefix)}</div>
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

  root.innerHTML = startCard + listCard;
  root.querySelectorAll('[data-action="revoke"]').forEach((b) => {
    b.addEventListener("click", () => runRevoke(b.getAttribute("data-prefix")));
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
    toast("Revoked");
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
