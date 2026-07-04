// P2.8 — paired-sessions list + revoke. Calls P1.12 / P1.13.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";

registerView("view-paired-sessions");

export async function renderPairedSessions() {
  const root = $("paired-sessions-content");
  root.innerHTML = skeletonCards(3);
  try {
    const body = await screensFetch("/api/screens/paired-sessions/list");
    if (!body.sessions?.length) {
      root.innerHTML = '<div class="card placeholder">no browser sessions</div>';
      return;
    }
    root.innerHTML = body.sessions.map((s) => `
      <div class="card">
        <div class="row row-top">
          <div>
            <div class="weight-600">${escapeHtml(s.label)} ${s.current ? '<span class="pill ok">this device</span>' : ""}</div>
            <div class="value text-xs">${escapeHtml(s.tokenPrefix)}…</div>
            <div class="faint-sm">added ${escapeHtml(formatWhen(s.addedAt))}</div>
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
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function revoke(prefix) {
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: `Revoke session ${prefix}…?`,
    message: "The device using this session token will be signed out immediately.",
    okLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;
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
    renderPairedSessions().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterPairedSessions() {
  show("view-paired-sessions");
  await renderPairedSessions();
}
