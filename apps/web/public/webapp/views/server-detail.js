// P2.1 — server-detail view. Calls /api/screens/server-detail (P1.1).

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-server-detail");

function fmtUptime(ms) {
  if (typeof ms !== "number" || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

function fmtDate(unixMs) {
  if (typeof unixMs !== "number") return "—";
  return new Date(unixMs).toLocaleString();
}

export async function renderServerDetail() {
  const root = $("server-detail-content");
  root.innerHTML = '<div class="card placeholder">loading…</div>';
  try {
    const body = await screensFetch("/api/screens/server-detail");
    root.innerHTML = `
      <div class="card">
        <div class="row"><span class="label">FQDN</span><span class="value">${escapeHtml(body.serverFqdn)}</span></div>
        <div class="row"><span class="label">Username</span><span class="value">${escapeHtml(body.username)}</span></div>
        <div class="row"><span class="label">Daemon</span><span class="value">${escapeHtml(body.daemonVersion)}</span></div>
        <div class="row"><span class="label">Uptime</span><span class="value">${escapeHtml(fmtUptime(body.uptimeMs))}</span></div>
      </div>
      <h2 style="margin-top: 1.2rem;">Cert</h2>
      <div class="card">
        <div class="row"><span class="label">Not after</span><span class="value">${escapeHtml(fmtDate(body.certNotAfter))}</span></div>
        <div class="row"><span class="label">SANs</span><span class="value" style="font-size:0.8rem;">${escapeHtml((body.certSans ?? []).join(", ") || "—")}</span></div>
      </div>
      <h2 style="margin-top: 1.2rem;">Counters</h2>
      <div class="card">
        <div class="row"><span class="label">Apps installed</span><span class="value">${body.appCount}</span></div>
        <div class="row"><span class="label">Paired sessions</span><span class="value">${body.pairedSessionCount}</span></div>
      </div>
      <h2 style="margin-top: 1.2rem;">Recent install events</h2>
      ${(body.recentInstallEvents ?? []).length === 0
        ? '<div class="card placeholder">none</div>'
        : (body.recentInstallEvents ?? []).map((e) => `
          <div class="card">
            <div class="row">
              <span class="value">${escapeHtml(e.kind)}: ${escapeHtml(e.appId)}</span>
              <span class="pill">${escapeHtml(fmtDate(e.at))}</span>
            </div>
          </div>
        `).join("")}
    `;
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

export function initServerDetailView() {
  $("server-detail-back")?.addEventListener("click", () => show("view-home"));
  $("server-detail-refresh")?.addEventListener("click", () => {
    renderServerDetail().catch((e) => toast(String(e), "err"));
  });
}

export async function enterServerDetail() {
  show("view-server-detail");
  await renderServerDetail();
}
