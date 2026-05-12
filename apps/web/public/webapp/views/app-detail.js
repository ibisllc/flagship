// P2.3 — app-detail view. Calls /api/screens/app-detail/:appId (P1.3).
// Includes a "backup this app" button that calls P1.19, and (when the
// app declares a browser bundle) a "Open browser viewer" button that
// drives the user into views/browser-viewer.js with appId pre-set.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl } from "../lib/api.js";
import { enterBrowserViewer } from "./browser-viewer.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-app-detail");

let currentAppId = null;

/**
 * #32 — browser-viewer is only reachable from here, only when the
 * manifest claims a browser bundle. We treat a non-empty `browserTabs`
 * array OR an explicit `browser:` block in the manifest as proof. The
 * legacy home-grid entry point (with its window.prompt fallback) is
 * gone — see views/browser-viewer.js.
 */
function hasBrowserBundle(body) {
  if ((body.browserTabs ?? []).length > 0) return true;
  const m = body.manifest;
  return !!(m && typeof m === "object" && (m.browser || m.browserBundle));
}

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
        <div class="card-title">${escapeHtml(a.slug)} <span class="pill">${escapeHtml(a.version || "")}</span></div>
        <div class="muted-sm mt-2">${escapeHtml(a.summary || "")}</div>
        <div class="row mt-2">
          <span class="label">creator</span><span class="value">${escapeHtml(a.creator)}</span>
        </div>
        <div class="row">
          <span class="label">url</span>
          <span class="value text-xs"><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.url)}</a></span>
        </div>
        <div class="row">
          <span class="label">app id</span><span class="value text-xs">${escapeHtml(a.appId)}</span>
        </div>
      </div>
      <h2 class="mt-4">Manifest</h2>
      <div class="card">
        <pre class="json-block">${escapeHtml(JSON.stringify(body.manifest, null, 2))}</pre>
      </div>
      <h2 class="mt-4">Data layer</h2>
      ${(body.dataLayerInstances ?? []).length === 0
        ? '<div class="card placeholder">no stores</div>'
        : (body.dataLayerInstances ?? []).map((i) => `
          <div class="card">
            <div class="row"><span class="label">${escapeHtml(i.store)}</span><span class="value">${escapeHtml(i.instanceName)}</span></div>
          </div>
        `).join("")
      }
      <h2 class="mt-4">Members</h2>
      ${(body.members ?? []).length === 0
        ? '<div class="card placeholder">none</div>'
        : (body.members ?? []).map((m) => `
          <div class="card">
            <div class="row">
              <span class="value text-xs">${escapeHtml(m.stableIdPrefix)}…</span>
              <span class="pill">${escapeHtml(m.role)}</span>
            </div>
          </div>
        `).join("")
      }
      ${hasBrowserBundle(body) ? `
        <h2 class="mt-4">Browser bundle</h2>
        <div class="card">
          <p class="note">
            This app ships a Chromium tab the daemon runs on your pod. Open
            the viewer to drive a sign-in or paste-a-cookie flow against it
            from your webapp — frames stream over the paired-session WS.
          </p>
          <button id="ad-open-browser" class="full-width">Open browser viewer</button>
        </div>
      ` : ""}
      <h2 class="mt-4">Invites</h2>
      <div class="card">
        <p class="note">
          Share access via single-use bearer links. Names you attach to an
          invite stay on this device (encrypted user-blob synced lazily); the
          daemon and flagshipserver.com never see them.
        </p>
        <div class="row-2 mt-2">
          <button id="ad-invite-issue" class="secondary">Invite people</button>
          <button id="ad-invite-manage" class="secondary">Manage invites</button>
        </div>
      </div>
      <h2 class="mt-4">Backup</h2>
      <div class="card">
        <p class="note">
          Phone-driven backup of this app's source + (optionally) user data.
          Bytes flow daemon → this device only — flagshipserver.com is never
          in the path.
        </p>
        <label class="inline-check">
          <input type="checkbox" id="ad-include-data" /> Include user data
        </label>
        <input type="password" id="ad-password" placeholder="Optional password (encrypts archive)" autocomplete="off" class="mt-2" />
        <button id="ad-backup-go" class="full-width mt-2">Create backup</button>
        <div id="ad-backup-status" class="mt-2 text-sm"></div>
      </div>
    `;

    $("ad-backup-go")?.addEventListener("click", () => triggerBackup(a.appId));
    $("ad-open-browser")?.addEventListener("click", () => {
      enterBrowserViewer(a.appId).catch((e) => toast(String(e), "err"));
    });
    $("ad-invite-issue")?.addEventListener("click", async () => {
      const { enterInviteIssue } = await import("./invite-issue.js");
      await enterInviteIssue(a);
    });
    $("ad-invite-manage")?.addEventListener("click", async () => {
      const { enterInviteManage } = await import("./invite-manage.js");
      await enterInviteManage(a);
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
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
