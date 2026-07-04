// J.4 — post-recovery membership re-attach progress view.
//
// After a J.3 IRK rotation binds, every app on every pod has user
// records keyed to the OLD IRK pubkey. The daemon rewrites them to the
// new IRK and journals the change (encrypted, 7-day undo window). This
// view polls /api/screens/post-recovery/status until the daemon reports
// `status: "complete"`, then surfaces a per-app summary and an "undo
// available until" line.
//
// The view registers itself with the shell via registerView() like
// every other view module. It's wired into the main router from
// recovery.js (which kicks it off after a successful recovery bind).

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-post-recovery");

const POLL_MS = 1500;
let pollTimer = null;

async function pollOnce() {
  try {
    const body = await screensFetch("/api/screens/post-recovery/status");
    renderReport(body.report);
    if (!body.report || body.report.status === "complete" || body.report.status === "failed") {
      stopPolling();
    }
  } catch (e) {
    stopPolling();
    if (e instanceof ScreensError) {
      const root = $("post-recovery-content");
      if (root) root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      console.error(e);
      toast(humanError(e), "err");
    }
  }
}

function renderReport(report) {
  const root = $("post-recovery-content");
  if (!root) return;
  if (!report) {
    root.innerHTML = '<div class="card placeholder">no recovery has run on this daemon yet</div>';
    return;
  }
  const statusPill =
    report.status === "complete"
      ? '<span class="pill ok">Done</span>'
      : report.status === "failed"
      ? '<span class="pill err">Failed</span>'
      : '<span class="pill">Running…</span>';
  const undoText = report.undoWindowExpiresAt
    ? new Date(report.undoWindowExpiresAt).toLocaleString()
    : "—";
  root.innerHTML = `
    <div class="card">
      <div class="row"><span class="label">status</span><span class="value">${statusPill}</span></div>
      <div class="row"><span class="label">apps reattached</span><span class="value">${report.reattachedCount}</span></div>
      <div class="row"><span class="label">apps unchanged</span><span class="value">${report.unchangedCount}</span></div>
      <div class="row"><span class="label">total rows rewritten</span><span class="value">${report.totalRewritten}</span></div>
      <div class="row"><span class="label">old IRK prefix</span><span class="value text-xs">${escapeHtml(report.oldIrkPrefix ?? "")}…</span></div>
      <div class="row"><span class="label">new IRK prefix</span><span class="value text-xs">${escapeHtml(report.newIrkPrefix ?? "")}…</span></div>
      <div class="row"><span class="label">undo available until</span><span class="value text-xs">${escapeHtml(undoText)}</span></div>
    </div>
    <h3 class="mt-4">Per-app</h3>
    ${(report.apps ?? []).length === 0
      ? '<div class="card placeholder">no apps walked</div>'
      : (report.apps ?? []).map((a) => `
        <div class="card">
          <div class="row"><span class="label">${escapeHtml(a.slug ?? a.serviceId)}</span><span class="value text-xs">${escapeHtml(a.serviceId)}</span></div>
          <div class="row"><span class="value">${a.rewrittenCount} reattached</span><span class="value">${a.unchangedCount} unchanged</span></div>
          ${a.error ? `<div class="row"><span class="value err-text">${escapeHtml(a.error)}</span></div>` : ""}
        </div>
      `).join("")
    }
  `;
}

function startPolling() {
  stopPolling();
  void pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function initPostRecoveryView() {
  $("post-recovery-back")?.addEventListener("click", () => {
    stopPolling();
    show("view-home");
  });
  $("post-recovery-refresh")?.addEventListener("click", () => {
    void pollOnce();
  });
}

export function enterPostRecovery() {
  show("view-post-recovery");
  startPolling();
}
