// P2.8 — paired-sessions list + revoke. Calls P1.12 / P1.13.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-paired-sessions");

export async function renderPairedSessions() {
  const root = $("paired-sessions-content");
  root.innerHTML = '<div class="card placeholder">loading…</div>';
  try {
    const body = await screensFetch("/api/screens/paired-sessions/list");
    if (!body.sessions?.length) {
      root.innerHTML = '<div class="card placeholder">no paired sessions</div>';
      return;
    }
    root.innerHTML = body.sessions.map((s) => `
      <div class="card">
        <div class="row" style="align-items:flex-start;">
          <div>
            <div style="font-weight:600;">${escapeHtml(s.label)} ${s.current ? '<span class="pill ok">this device</span>' : ""}</div>
            <div class="value" style="font-size:0.78rem;">${escapeHtml(s.tokenPrefix)}…</div>
            <div style="color:var(--fg-mute); font-size:0.78rem;">added ${escapeHtml(new Date(s.addedAt).toLocaleString())}</div>
          </div>
          ${s.current
            ? '<button class="secondary" disabled>can\'t revoke self</button>'
            : `<button class="secondary" data-action="revoke" data-prefix="${escapeHtml(s.tokenPrefix)}">revoke</button>`}
        </div>
      </div>
    `).join("");
    root.querySelectorAll('[data-action="revoke"]').forEach((b) => {
      b.addEventListener("click", () => revoke(b.getAttribute("data-prefix")));
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function revoke(prefix) {
  if (!confirm(`Revoke session ${prefix}…?`)) return;
  try {
    await screensFetch(
      `/api/screens/paired-sessions/${encodeURIComponent(prefix)}`,
      { method: "DELETE" },
    );
    toast("revoked");
    await renderPairedSessions();
  } catch (e) {
    toast(e.message, "err");
  }
}

export function initPairedSessionsView() {
  $("paired-sessions-back")?.addEventListener("click", () => show("view-home"));
  $("paired-sessions-refresh")?.addEventListener("click", () => {
    renderPairedSessions().catch((e) => toast(String(e), "err"));
  });
}

export async function enterPairedSessions() {
  show("view-paired-sessions");
  await renderPairedSessions();
}
