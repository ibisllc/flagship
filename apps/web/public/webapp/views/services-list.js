// P2.2 — services-list view. Calls /api/screens/apps-list (P1.2).
// V3 — surfaces the per-service voi.ci short link + canonical alongside
// the daemon's slug/summary/status. Each row fans out to
// /api/users/:u/apps/:serviceId/links on .com after the initial list
// renders, then patches the URL slot in place — keeps the first
// paint snappy while the network catches up.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

const COM_BASE = "https://flagshipserver.com";

registerView("view-services-list");

function stripScheme(s) {
  return s.replace(/^https?:\/\//, "");
}

/** V7 — short link on its own line (bold, no icon) with a copy
 *  control; canonical BELOW it, full-width, single-line truncate.
 *  Placeholder shape stays vertically stable when links haven't
 *  loaded yet so the list doesn't jump as fetches resolve. */
function urlRowHtml(service, links) {
  const canonical = links?.canonicalUrl ?? service.url;
  // A bound custom domain takes the short link's slot ONLY once .com
  // has confirmed it (order flipped active) — that swap is the subtle
  // "it's live" cue. Mirrors iOS ServicesTab.urlRow + the service-detail view.
  const confirmedCustom =
    links?.customDomainConfirmed === true && links?.customDomain
      ? `https://${links.customDomain}`
      : null;
  const short = confirmedCustom ?? links?.shortUrl ?? null;
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

export async function renderServicesList() {
  const root = $("services-list-content");
  root.innerHTML = skeletonCards(3);
  try {
    const body = await screensFetch("/api/screens/apps-list");
    if (!body.apps?.length) {
      root.innerHTML = '<div class="card placeholder">no services installed yet</div>';
      return;
    }
    root.innerHTML = body.apps.map((s) => `
      <div class="card" data-service-id="${escapeHtml(s.serviceId)}">
        <div class="row row-top">
          <div style="flex:1; min-width:0;">
            <div class="weight-600">${escapeHtml(s.slug)} <span class="pill">${escapeHtml(s.version || "")}</span></div>
            <div class="muted-sm truncate">${escapeHtml(s.summary || "")}</div>
            <div class="row mt-1" style="gap:6px; flex-wrap:wrap;">
              <span class="pill ${s.status === "running" ? "ok" : ""}">${escapeHtml(s.status || "")}</span>
            </div>
            <div data-url-slot="${escapeHtml(s.serviceId)}">${urlRowHtml(s, null)}</div>
          </div>
          <button class="secondary" data-action="open" data-id="${escapeHtml(s.serviceId)}">open</button>
        </div>
      </div>
    `).join("");
    bindServicesListHandlers();
    // Fan out the per-service /links fetch in the background — patches
    // each row's URL slot as the response lands.
    void hydrateServiceLinks(body.apps);
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

function bindServicesListHandlers() {
  document.querySelectorAll('[data-action="open"]').forEach((b) => {
    b.addEventListener("click", async () => {
      const { enterServiceDetail } = await import("./service-detail.js");
      await enterServiceDetail(b.getAttribute("data-id"));
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

async function hydrateServiceLinks(services) {
  const username = getSession().username;
  if (!username) return;
  await Promise.all(services.map(async (s) => {
    try {
      const r = await fetch(
        `${COM_BASE}/api/users/${encodeURIComponent(username)}/apps/${encodeURIComponent(s.serviceId)}/links`,
        { cache: "no-store" },
      );
      if (!r.ok) return;
      const links = await r.json();
      const slot = document.querySelector(`[data-url-slot="${cssEscape(s.serviceId)}"]`);
      if (slot) {
        slot.innerHTML = urlRowHtml(s, links);
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
      // Per-service failure tolerated — leave the placeholder + canonical
      // fallback in place rather than nuking the row.
    }
  }));
}

/** CSS.escape isn't on every browser version; this is a safe subset
 *  for the alphanumerics + hyphens a serviceId actually contains. */
function cssEscape(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

export function initServicesListView() {
  $("services-list-back")?.addEventListener("click", () => show("view-home"));
  $("services-list-refresh")?.addEventListener("click", () => {
    renderServicesList().catch((e) => toast(String(e), "err"));
  });
}

export async function enterServicesList() {
  show("view-services-list");
  await renderServicesList();
}
