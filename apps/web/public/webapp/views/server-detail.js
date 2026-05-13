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
import { escapeHtml, skeletonCards } from "../lib/util.js";

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
  root.innerHTML = skeletonCards(2);
  try {
    const body = await screensFetch("/api/screens/server-detail");
    root.innerHTML = `
      <div class="card">
        <div class="row"><span class="label">FQDN</span><span class="value">${escapeHtml(body.serverFqdn)}</span></div>
        <div class="row"><span class="label">Username</span><span class="value">${escapeHtml(body.username)}</span></div>
        <div class="row"><span class="label">Daemon</span><span class="value">${escapeHtml(body.daemonVersion)}</span></div>
        <div class="row"><span class="label">Uptime</span><span class="value">${escapeHtml(fmtUptime(body.uptimeMs))}</span></div>
      </div>
      <h2 class="mt-4">Cert</h2>
      <div class="card">
        <div class="row"><span class="label">Not after</span><span class="value">${escapeHtml(fmtDate(body.certNotAfter))}</span></div>
        <div class="row"><span class="label">SANs</span><span class="value text-xs">${escapeHtml((body.certSans ?? []).join(", ") || "—")}</span></div>
      </div>
      <h2 class="mt-4">Counters</h2>
      <div class="card">
        <div class="row"><span class="label">Apps installed</span><span class="value">${body.appCount}</span></div>
        <div class="row"><span class="label">Paired sessions</span><span class="value">${body.pairedSessionCount}</span></div>
      </div>
      <h2 class="mt-4">Auto-unlock</h2>
      <div class="card" id="auto-unlock-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p class="note">
          Off by default — every reboot waits for you. Turn on a long-lived
          lease to let this server reboot freely (power blips, kernel
          updates) for up to a week. If you go offline longer than the
          lease, the next reboot waits for you again.
        </p>
        <div id="auto-unlock-status" class="row">
          <span class="label">Status</span>
          <span class="pill" id="auto-unlock-pill">checking…</span>
        </div>
        <div id="auto-unlock-leases-list" class="mt-1"></div>
        <button id="auto-unlock-enable" class="full-width mt-2">Enable for 7 days</button>
      </div>
      <h2 class="mt-4">Live metrics</h2>
      <div class="card" id="server-metrics-card">
        <div class="row"><span class="label">CPU</span><span class="value" id="metrics-cpu">…</span></div>
        <div class="row"><span class="label">Memory</span><span class="value" id="metrics-mem">…</span></div>
        <div class="row"><span class="label">Disk</span><span class="value" id="metrics-disk">…</span></div>
        <div class="row"><span class="label">Network</span><span class="value" id="metrics-net">…</span></div>
        <p class="note small" id="metrics-collected-at">Loading…</p>
      </div>
      <h2 class="mt-4">Recent install events</h2>
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
    startMetricsPolling(body.serverFqdn);
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
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
    <div class="row mt-1">
      <span class="value text-xs">
        ${escapeHtml(l.leaseId.slice(0, 12))}…
        · until ${escapeHtml(fmtDate(l.expiresAt))}
      </span>
      <button class="secondary btn-xs" data-action="revoke-lease" data-lease-id="${escapeHtml(l.leaseId)}">Revoke</button>
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

// Format bytes → human (1.4 GB / 312 KB / ...). Mirrors the
// `humanBytes` helper in iOS/Android ServerDetailScreen.
function humanBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "—";
  const k = 1024;
  if (n < k) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / k;
  let i = 0;
  while (v >= k && i < units.length - 1) { v /= k; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

let metricsTimer = null;
function startMetricsPolling(serverFqdn) {
  // Cancel any prior poller (back+forward navigation re-enters this).
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
  const tick = async () => {
    // Stop polling when the user navigates away.
    if ($("view-server-detail")?.classList.contains("hidden")) {
      if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
      return;
    }
    try {
      const m = await screensFetch(
        `/api/screens/server-metrics/${encodeURIComponent(serverFqdn)}`,
      );
      const cpu = $("metrics-cpu");
      const mem = $("metrics-mem");
      const disk = $("metrics-disk");
      const net = $("metrics-net");
      const at = $("metrics-collected-at");
      if (cpu) cpu.textContent = `${(m.cpuPercent ?? 0).toFixed(1)}%`;
      if (mem) mem.textContent = `${humanBytes(m.memUsedBytes)} / ${humanBytes(m.memTotalBytes)}`;
      if (disk) disk.textContent = `${humanBytes(m.diskUsedBytes)} / ${humanBytes(m.diskTotalBytes)}`;
      if (net) net.textContent =
        `↓ ${humanBytes(m.netRxBytesPerSec)}/s · ↑ ${humanBytes(m.netTxBytesPerSec)}/s`;
      if (at) at.textContent = `Collected ${new Date(m.collectedAt).toLocaleTimeString()}`;
    } catch (e) {
      const at = $("metrics-collected-at");
      if (at) at.textContent = `Couldn't reach daemon: ${e.message ?? e}`;
    }
  };
  void tick();
  metricsTimer = setInterval(tick, 15_000);
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
