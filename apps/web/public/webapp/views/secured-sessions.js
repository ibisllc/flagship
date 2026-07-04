// Web-experience gating — "Open secured sessions" list
// (docs/service-access-gating.md, "Web-experience gating").
//
// When the webapp authorizes a browser's QR-login knock, the box hands US (the
// phone/webapp) a `secretId` that handles that browser's session. This screen
// lists every held session — the site, the browser that's in, and when it
// started — and lets the owner re-check its liveness (Refresh, debounced ≥60s to
// respect the box's ~1/min/secretId rate limit) or Stop it (close → kills the
// browser cookie → drop the row).
//
// The secretId rides the request BODY (never a URL), so it never lands in any
// access log; status is default-offline for an unknown handle.

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import {
  listSecuredSessions,
  removeSecuredSession,
  canCheckStatus,
} from "../lib/securedSessions.js";
import { sessionStatus, closeSession } from "../lib/serviceInvite.js";

registerView("view-secured-sessions");

// secretId → { status: "online"|"offline"|"unknown", lastCheckedAt:number }
const liveness = new Map();

function statusPill(secretId) {
  const s = liveness.get(secretId);
  if (!s || s.status === "unknown") return '<span class="pill">Unknown</span>';
  return s.status === "online" ? '<span class="pill ok">Online</span>' : '<span class="pill">Offline</span>';
}

export function renderSecuredSessions() {
  const root = $("secured-sessions-content");
  const sessions = listSecuredSessions();
  if (!sessions.length) {
    root.innerHTML = '<div class="card placeholder">No secured sessions. Authorize a browser from a restricted site, then it shows up here.</div>';
    return;
  }
  root.innerHTML = sessions
    .map((s) => {
      const started = Number.isFinite(s.startedAt) ? formatWhen(s.startedAt) : "";
      return `
      <div class="card">
        <div class="row row-top">
          <div>
            <div class="weight-600">${escapeHtml(s.serviceUrl || s.serverId)} ${statusPill(s.secretId)}</div>
            ${s.browserAgent ? `<div class="value text-xs mt-1">${escapeHtml(s.browserAgent)}</div>` : ""}
            ${started ? `<div class="faint-sm">started ${escapeHtml(started)}</div>` : ""}
          </div>
          <div class="btn-row-sm">
            <button class="secondary" data-action="refresh" data-secret="${escapeHtml(s.secretId)}">Refresh</button>
            <button class="secondary" data-action="stop" data-secret="${escapeHtml(s.secretId)}">Stop</button>
          </div>
        </div>
      </div>`;
    })
    .join("");
  root.querySelectorAll('[data-action="refresh"]').forEach((b) => {
    b.addEventListener("click", () => refreshOne(b.getAttribute("data-secret"), b));
  });
  root.querySelectorAll('[data-action="stop"]').forEach((b) => {
    b.addEventListener("click", () => stopOne(b.getAttribute("data-secret")));
  });
}

async function refreshOne(secretId, btn) {
  const sessions = listSecuredSessions();
  const s = sessions.find((x) => x.secretId === secretId);
  if (!s) return;
  const prev = liveness.get(secretId);
  if (!canCheckStatus(prev?.lastCheckedAt)) {
    toast("Checked too recently — try again in a moment.", "warn");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking…";
  }
  try {
    const status = await sessionStatus({ serverId: s.serverId, secretId });
    liveness.set(secretId, { status, lastCheckedAt: Date.now() });
    renderSecuredSessions();
  } catch (e) {
    // 429: keep the last-known status (the box rate-limited us), but still
    // mark the check time so we back off. Other errors surface a toast.
    if (e?.code === "429") {
      liveness.set(secretId, { status: prev?.status ?? "unknown", lastCheckedAt: Date.now() });
      toast("Checked too recently — try again in a moment.", "warn");
      renderSecuredSessions();
    } else {
      toast(humanError(e), "err");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Refresh";
    }
  }
}

async function stopOne(secretId) {
  const sessions = listSecuredSessions();
  const s = sessions.find((x) => x.secretId === secretId);
  if (!s) return;
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: "Stop this session?",
    message: `The browser at ${s.serviceUrl || s.serverId} will be signed out of the site immediately.`,
    okLabel: "Stop",
    danger: true,
  });
  if (!ok) return;
  try {
    await closeSession({ serverId: s.serverId, secretId });
  } catch (e) {
    // Close is idempotent + oracle-free on the box; on a network failure we
    // surface it and keep the row so the owner can retry.
    toast(humanError(e), "err");
    return;
  }
  removeSecuredSession(secretId);
  liveness.delete(secretId);
  toast("Stopped");
  renderSecuredSessions();
}

export function initSecuredSessionsView() {
  $("secured-sessions-back")?.addEventListener("click", () => show("view-settings-tab"));
  $("secured-sessions-refresh")?.addEventListener("click", () => renderSecuredSessions());
}

export async function enterSecuredSessions() {
  show("view-secured-sessions");
  renderSecuredSessions();
}
