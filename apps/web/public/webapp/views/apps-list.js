// P2.2 — apps-list view. Calls /api/screens/apps-list (P1.2).
// V3 — surfaces the per-app voi.ci short link + canonical alongside
// the daemon's slug/summary/status. Each row fans out to
// /api/users/:u/apps/:appId/links on .com after the initial list
// renders, then patches the URL slot in place — keeps the first
// paint snappy while the network catches up.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

const COM_BASE = "https://flagshipserver.com";

registerView("view-apps-list");

function stripScheme(s) {
  return s.replace(/^https?:\/\//, "");
}

/** V7 — short link on its own line (bold, no icon) with a copy
 *  control; canonical BELOW it, full-width, single-line truncate.
 *  Placeholder shape stays vertically stable when links haven't
 *  loaded yet so the list doesn't jump as fetches resolve. */
function urlRowHtml(app, links) {
  const canonical = links?.canonicalUrl ?? app.url;
  const short = links?.shortUrl ?? null;
  return `
    <div class="mt-1" data-section="urls">
      <div class="row">
        ${short
          ? `<a class="weight-600 mono text-xs truncate" href="${escapeHtml(short)}" target="_blank" rel="noopener" style="min-width:0;">
                ${escapeHtml(stripScheme(short))}
             </a>
             <button class="ghost mini" data-copy="${escapeHtml(short)}" aria-label="Copy short link">📋</button>`
          : `<span class="muted-sm mono text-xs">voi.ci/…</span>`
        }
      </div>
      <div class="muted-sm mono text-xs truncate">${escapeHtml(stripScheme(canonical))}</div>
    </div>
  `;
}

export async function renderAppsList() {
  const root = $("apps-list-content");
  root.innerHTML = skeletonCards(3);
  try {
    const body = await screensFetch("/api/screens/apps-list");
    if (!body.apps?.length) {
      root.innerHTML = '<div class="card placeholder">no apps installed yet</div>';
      return;
    }
    root.innerHTML = body.apps.map((a) => `
      <div class="card" data-app-id="${escapeHtml(a.appId)}">
        <div class="row row-top">
          <div style="flex:1; min-width:0;">
            <div class="weight-600">${escapeHtml(a.slug)} <span class="pill">${escapeHtml(a.version || "")}</span></div>
            <div class="muted-sm">${escapeHtml(a.summary || "")}</div>
            <div class="row mt-1" style="gap:6px; flex-wrap:wrap;">
              <span class="pill ${a.status === "running" ? "ok" : ""}">${escapeHtml(a.status || "")}</span>
            </div>
            <div data-url-slot="${escapeHtml(a.appId)}">${urlRowHtml(a, null)}</div>
          </div>
          <button class="secondary" data-action="open" data-id="${escapeHtml(a.appId)}">open</button>
        </div>
      </div>
    `).join("");
    bindAppsListHandlers();
    // Fan out the per-app /links fetch in the background — patches
    // each row's URL slot as the response lands.
    void hydrateAppLinks(body.apps);
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

function bindAppsListHandlers() {
  document.querySelectorAll('[data-action="open"]').forEach((b) => {
    b.addEventListener("click", async () => {
      const { enterAppDetail } = await import("./app-detail.js");
      await enterAppDetail(b.getAttribute("data-id"));
    });
  });
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      const url = ev.currentTarget.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(url);
        toast("Copied.");
      } catch (e) {
        toast("Couldn't copy.", "err");
      }
    });
  });
}

async function hydrateAppLinks(apps) {
  const username = getSession().username;
  if (!username) return;
  await Promise.all(apps.map(async (a) => {
    try {
      const r = await fetch(
        `${COM_BASE}/api/users/${encodeURIComponent(username)}/apps/${encodeURIComponent(a.appId)}/links`,
        { cache: "no-store" },
      );
      if (!r.ok) return;
      const links = await r.json();
      const slot = document.querySelector(`[data-url-slot="${cssEscape(a.appId)}"]`);
      if (slot) {
        slot.innerHTML = urlRowHtml(a, links);
        // Re-bind copy buttons inside this slot.
        slot.querySelectorAll("[data-copy]").forEach((btn) => {
          btn.addEventListener("click", async (ev) => {
            const url = ev.currentTarget.getAttribute("data-copy");
            try {
              await navigator.clipboard.writeText(url);
              toast("Copied.");
            } catch {
              toast("Couldn't copy.", "err");
            }
          });
        });
      }
    } catch {
      // Per-app failure tolerated — leave the placeholder + canonical
      // fallback in place rather than nuking the row.
    }
  }));
}

/** CSS.escape isn't on every browser version; this is a safe subset
 *  for the alphanumerics + hyphens an appId actually contains. */
function cssEscape(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
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
