// P2.1 — server-detail view. Calls /api/screens/server-detail (P1.1).
// Also hosts the per-server "auto-unlock" toggle (auto_unlock_lease_design.md).

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import {
  enableLongLived,
  listLeases,
  revokeLease,
} from "../lib/leases.js";
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
      <h2 style="margin-top: 1.2rem;">Auto-unlock</h2>
      <div class="card" id="auto-unlock-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p style="margin:0 0 0.5rem; color:var(--fg-mute); font-size:0.85rem;">
          Off by default — every reboot waits for you. Turn on a long-lived
          lease to let this server reboot freely (power blips, kernel
          updates) for up to a week. If you go offline longer than the
          lease, the next reboot waits for you again.
        </p>
        <div id="auto-unlock-status" class="row">
          <span class="label">Status</span>
          <span class="pill" id="auto-unlock-pill">checking…</span>
        </div>
        <div id="auto-unlock-leases-list" style="margin-top:0.4rem;"></div>
        <button id="auto-unlock-enable" style="margin-top:0.6rem; width:100%;">Enable for 7 days</button>
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
    wireAutoUnlock(body.serverFqdn);
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

function wireAutoUnlock(serverFqdn) {
  $("auto-unlock-enable")?.addEventListener("click", async () => {
    const btn = $("auto-unlock-enable");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Signing…";
    }
    try {
      const r = await enableLongLived(serverFqdn);
      toast(`auto-unlock on; lease expires ${new Date(r.expiresAt).toLocaleString()}`, "ok");
      await refreshLeases(serverFqdn);
    } catch (e) {
      toast(`enable failed: ${e.message ?? e}`, "err");
    } finally {
      const b = $("auto-unlock-enable");
      if (b) {
        b.disabled = false;
        b.textContent = "Renew for 7 more days";
      }
    }
  });
  refreshLeases(serverFqdn).catch(() => { /* fall through silently */ });
}

async function refreshLeases(serverFqdn) {
  const pill = $("auto-unlock-pill");
  const list = $("auto-unlock-leases-list");
  if (!pill || !list) return;
  let leases = [];
  try {
    leases = await listLeases(serverFqdn);
  } catch (_e) {
    pill.textContent = "unreachable";
    list.innerHTML = "";
    return;
  }
  const longLived = leases.filter((l) => l.multiUse);
  if (longLived.length === 0) {
    pill.textContent = "off";
    list.innerHTML = "";
    return;
  }
  pill.textContent = "on";
  list.innerHTML = longLived.map((l) => `
    <div class="row" style="margin-top:0.4rem; align-items:center;">
      <span class="value" style="font-size:0.78rem;">
        ${escapeHtml(l.leaseId.slice(0, 12))}…
        · until ${escapeHtml(fmtDate(l.expiresAt))}
      </span>
      <button class="secondary" data-action="revoke-lease" data-lease-id="${escapeHtml(l.leaseId)}" style="font-size:0.75rem; padding:0.3rem 0.6rem;">Revoke</button>
    </div>
  `).join("");
  list.querySelectorAll('[data-action="revoke-lease"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-lease-id");
      if (!id) return;
      btn.disabled = true;
      try {
        await revokeLease(serverFqdn, id);
        toast(`revoked lease ${id.slice(0, 8)}…`, "ok");
        await refreshLeases(serverFqdn);
      } catch (e) {
        toast(`revoke failed: ${e.message ?? e}`, "err");
        btn.disabled = false;
      }
    });
  });
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
