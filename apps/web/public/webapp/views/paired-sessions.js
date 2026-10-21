// P2.8 — paired-sessions list + revoke. Calls P1.12 / P1.13.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";

import { tr } from "../lib/i18n.js";
registerView("view-paired-sessions");

/**
 * Browser sessions are browsers docked through Remote (`kind: "remote"`).
 * The box also lists the session each of the account's own devices paired
 * itself with (`kind: "device"`): those are Trusted devices, so they stay
 * out. A box from before `kind` existed lists everything; there, at least
 * this device's own session is never shown as a browser.
 */
export function browserSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) =>
    s?.kind === "remote" || (s?.kind == null && !s?.current),
  );
}

export async function renderPairedSessions() {
  const root = $("paired-sessions-content");
  root.innerHTML = skeletonCards(3);
  try {
    const body = await screensFetch("/api/screens/paired-sessions/list");
    const sessions = browserSessions(body.sessions);
    if (!sessions.length) {
      root.innerHTML = '<div class="card placeholder">No browser sessions. Browsers you open through Remote show here.</div>';
      return;
    }
    root.innerHTML = sessions.map((s) => `
      <div class="card">
        <div class="row row-top">
          <div>
            <div class="weight-600">${tr("Session {0} {1}", escapeHtml(s.tokenPrefix), s.current ? '<span class="pill ok">this device</span>' : "")}</div>
            <div class="value text-xs">${escapeHtml(s.tokenPrefix)}…</div>
            <div class="faint-sm">${tr("added {0}", escapeHtml(formatWhen(s.addedAt)))}</div>
          </div>
          ${s.current
            ? '<button class="secondary" disabled>can\'t revoke self</button>'
            : `<button class="secondary" data-action="revoke" data-prefix="${escapeHtml(s.tokenPrefix)}">${tr("revoke")}</button>`}
        </div>
      </div>
    `).join("");
    root.querySelectorAll('[data-action="revoke"]').forEach((b) => {
      b.addEventListener("click", () => revoke(b.getAttribute("data-prefix")));
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function revoke(prefix) {
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: tr("Revoke session {0}…?", prefix),
    message: tr("The device using this session token will be signed out immediately."),
    okLabel: tr("Revoke"),
    danger: true,
  });
  if (!ok) return;
  try {
    await screensFetch(
      `/api/screens/paired-sessions/${encodeURIComponent(prefix)}`,
      { method: "DELETE" },
    );
    toast(tr("Revoked"));
    await renderPairedSessions();
  } catch (e) {
    toast(e.message, "err");
  }
}

export function initPairedSessionsView() {
  $("paired-sessions-back")?.addEventListener("click", () => show("view-settings-tab"));
  $("paired-sessions-refresh")?.addEventListener("click", () => {
    renderPairedSessions().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterPairedSessions() {
  show("view-paired-sessions");
  await renderPairedSessions();
}
