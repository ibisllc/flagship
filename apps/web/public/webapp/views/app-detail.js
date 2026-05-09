// P2.3 — app-detail view. Calls /api/screens/app-detail/:appId (P1.3).
// Includes a "backup this app" button that calls P1.19.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-app-detail");

let currentAppId = null;

export async function renderAppDetail(appId) {
  currentAppId = appId;
  const root = $("app-detail-content");
  root.innerHTML = '<div class="card placeholder">loading…</div>';
  try {
    const body = await screensFetch(
      `/api/screens/app-detail/${encodeURIComponent(appId)}`,
    );
    const a = body.app;
    root.innerHTML = `
      <div class="card">
        <div style="font-weight:600; font-size:1.1rem;">${escapeHtml(a.slug)} <span class="pill">${escapeHtml(a.version || "")}</span></div>
        <div style="color:var(--fg-mute); font-size:0.85rem; margin-top:0.25rem;">${escapeHtml(a.summary || "")}</div>
        <div class="row" style="margin-top:0.6rem;">
          <span class="label">creator</span><span class="value">${escapeHtml(a.creator)}</span>
        </div>
        <div class="row">
          <span class="label">url</span>
          <span class="value" style="font-size:0.78rem;"><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.url)}</a></span>
        </div>
        <div class="row">
          <span class="label">app id</span><span class="value" style="font-size:0.78rem;">${escapeHtml(a.appId)}</span>
        </div>
      </div>
      <h2 style="margin-top:1.2rem;">Manifest</h2>
      <div class="card">
        <pre style="margin:0; white-space:pre-wrap; font-size:0.78rem; color:var(--fg-mute);">${escapeHtml(JSON.stringify(body.manifest, null, 2))}</pre>
      </div>
      <h2 style="margin-top:1.2rem;">Data layer</h2>
      ${(body.dataLayerInstances ?? []).length === 0
        ? '<div class="card placeholder">no stores</div>'
        : (body.dataLayerInstances ?? []).map((i) => `
          <div class="card">
            <div class="row"><span class="label">${escapeHtml(i.store)}</span><span class="value">${escapeHtml(i.instanceName)}</span></div>
          </div>
        `).join("")
      }
      <h2 style="margin-top:1.2rem;">Members</h2>
      ${(body.members ?? []).length === 0
        ? '<div class="card placeholder">none</div>'
        : (body.members ?? []).map((m) => `
          <div class="card">
            <div class="row">
              <span class="value" style="font-size:0.78rem;">${escapeHtml(m.stableIdPrefix)}…</span>
              <span class="pill">${escapeHtml(m.role)}</span>
            </div>
          </div>
        `).join("")
      }
      <h2 style="margin-top:1.2rem;">Backup</h2>
      <div class="card">
        <p style="margin:0 0 0.6rem; color:var(--fg-mute); font-size:0.85rem;">
          Phone-driven backup of this app's source + (optionally) user data.
          Bytes flow daemon → this device only — flagshipserver.com is never
          in the path.
        </p>
        <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.85rem;">
          <input type="checkbox" id="ad-include-data" /> Include user data
        </label>
        <input type="password" id="ad-password" placeholder="Optional password (encrypts archive)" autocomplete="off" style="margin-top:0.6rem;" />
        <button id="ad-backup-go" style="margin-top:0.6rem; width:100%;">Create backup</button>
        <div id="ad-backup-status" style="margin-top:0.6rem; font-size:0.85rem;"></div>
      </div>
    `;

    $("ad-backup-go")?.addEventListener("click", () => triggerBackup(a.appId));
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function triggerBackup(appId) {
  const status = $("ad-backup-status");
  const password = $("ad-password").value;
  const includeUserData = $("ad-include-data").checked;
  status.textContent = "creating backup…";
  try {
    const body = await screensFetch("/api/screens/app-backup/start", {
      method: "POST",
      body: JSON.stringify({
        appId,
        includeUserData,
        password: password || undefined,
      }),
    });
    const fetchUrl = `${getPodBaseUrl()}${body.fetchPath}`;
    status.innerHTML = `
      ready (${(body.bytes / 1024).toFixed(1)} KB${body.encrypted ? ", encrypted" : ""})
      — <a href="${escapeHtml(fetchUrl)}" download>download</a>
    `;
  } catch (e) {
    if (e instanceof ScreensError) {
      status.textContent = `failed: ${e.message}`;
    } else {
      status.textContent = `failed: ${e.message}`;
    }
  }
}

export function initAppDetailView() {
  $("app-detail-back")?.addEventListener("click", async () => {
    const { enterAppsList } = await import("./apps-list.js");
    await enterAppsList();
  });
  $("app-detail-refresh")?.addEventListener("click", () => {
    if (currentAppId) renderAppDetail(currentAppId).catch((e) => toast(String(e), "err"));
  });
}

export async function enterAppDetail(appId) {
  show("view-app-detail");
  await renderAppDetail(appId);
}
