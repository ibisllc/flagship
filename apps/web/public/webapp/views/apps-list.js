// P2.2 — apps-list view. Calls /api/screens/apps-list (P1.2).

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-apps-list");

export async function renderAppsList() {
  const root = $("apps-list-content");
  root.innerHTML = '<div class="card placeholder">loading…</div>';
  try {
    const body = await screensFetch("/api/screens/apps-list");
    if (!body.apps?.length) {
      root.innerHTML = '<div class="card placeholder">no apps installed yet</div>';
      return;
    }
    root.innerHTML = body.apps.map((a) => `
      <div class="card" data-app-id="${escapeHtml(a.appId)}">
        <div class="row row-top">
          <div>
            <div class="weight-600">${escapeHtml(a.slug)} ${a.creator !== a.urlLabel.split("-").pop() ? "" : ""}<span class="pill">${escapeHtml(a.version || "")}</span></div>
            <div class="muted-sm">${escapeHtml(a.summary || "")}</div>
            <div class="value text-xs"><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.url)}</a></div>
          </div>
          <button class="secondary" data-action="open" data-id="${escapeHtml(a.appId)}">open</button>
        </div>
      </div>
    `).join("");
    root.querySelectorAll('[data-action="open"]').forEach((b) => {
      b.addEventListener("click", async () => {
        const { enterAppDetail } = await import("./app-detail.js");
        await enterAppDetail(b.getAttribute("data-id"));
      });
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

export function initAppsListView() {
  $("apps-list-back")?.addEventListener("click", () => show("view-home"));
  $("apps-list-refresh")?.addEventListener("click", () => {
    renderAppsList().catch((e) => toast(String(e), "err"));
  });
}

export async function enterAppsList() {
  show("view-apps-list");
  await renderAppsList();
}
