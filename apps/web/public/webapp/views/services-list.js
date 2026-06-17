// P2.2 — services-list view. Calls /api/screens/apps-list (P1.2).
// V3 — surfaces the per-service voi.ci short link + canonical alongside
// the daemon's slug/summary/status. Each row fans out to
// /api/users/:u/apps/:serviceId/links on .com after the initial list
// renders, then patches the URL slot in place — keeps the first
// paint snappy while the network catches up.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { chipRow, searchField, listRow } from "../lib/uikit.js";
import { packageIcon } from "../lib/icons.js";
import { controlApex } from "../lib/apex.js";

const COM_BASE = controlApex();

registerView("view-services-list");

/**
 * Apps filter chips — mirror the iOS Services tab bucket set + labels:
 * All / Yours / Shared. "Yours" = an app whose creator is the signed-in
 * user; "Shared" = installed from another creator. Pure presentation.
 */
export const APPS_FILTERS = [
  { value: "all", label: "All" },
  { value: "yours", label: "Yours" },
  { value: "shared", label: "Shared" },
];

/** Which bucket an app belongs to, given the signed-in username. */
export function appBucket(app, username) {
  const creator = String(app?.creator ?? "").toLowerCase();
  const me = String(username ?? "").toLowerCase();
  return creator && me && creator === me ? "yours" : "shared";
}

export function appsFilterMatches(filter, bucket) {
  return filter === "all" || filter === bucket;
}

/** Case-insensitive search over an app's slug / summary / serviceId. */
export function appsSearchMatches(query, app) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const hay = [app?.slug ?? "", app?.summary ?? "", app?.serviceId ?? ""]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

// In-memory app model + active filter/search. Re-paints locally on
// chip/search change — never re-fetches.
let appEntries = [];
let appsFilter = "all";
let appsQuery = "";

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

/** Render one app as a clean list-row-style card: a teal package glyph, the
 *  slug + version pill, the summary, the running/stopped status pill, the
 *  voi.ci/canonical URL slot, and an Open button. Preserves every existing
 *  data hook (data-service-id, data-url-slot, data-action=open). */
function appCardHtml(s) {
  return `
    <div class="card fs-app-card" data-service-id="${escapeHtml(s.serviceId)}">
      <div class="fs-app-card-head">
        <span class="fs-listrow-icon icon" aria-hidden="true">${packageIcon}</span>
        <div class="fs-app-card-body">
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
  `;
}

/** Paint the hero (large title + search + All/Yours/Shared chips) followed by
 *  the filtered + searched app cards. Re-runnable on every chip/search change;
 *  reads the in-memory `appEntries` — never re-fetches. */
function renderAppCards() {
  const root = $("services-list-content");
  if (!root) return;
  const username = getSession().username;
  const counts = { all: appEntries.length, yours: 0, shared: 0 };
  for (const e of appEntries) counts[e.bucket] = (counts[e.bucket] ?? 0) + 1;
  const chips = APPS_FILTERS.map((f) => ({ value: f.value, label: f.label, count: counts[f.value] ?? 0 }));

  const visible = appEntries.filter(
    (e) => appsFilterMatches(appsFilter, e.bucket) && appsSearchMatches(appsQuery, e.app),
  );
  const cardsHtml = visible.length
    ? visible.map((e) => appCardHtml(e.app)).join("")
    : `<div class="card placeholder">${
        appsQuery || appsFilter !== "all" ? "No services match this filter." : "No services installed yet."
      }</div>`;

  root.innerHTML = `
    <div class="fs-hero-compact" data-apps-compact aria-hidden="true">Services</div>
    <div class="fs-hero">
      <h2 class="fs-hero-title" data-apps-title>Services</h2>
      ${searchField({ value: appsQuery, placeholder: "Search services", id: "apps-search" })}
      ${chipRow({ items: chips, selected: appsFilter, ariaLabel: "Filter services" })}
    </div>
    <div data-app-cards>${cardsHtml}</div>
  `;

  bindServicesListHandlers();
  wireAppsListControls(root);
  // Hydrate URL slots for the currently-visible apps (a re-paint re-creates
  // the slots, so re-fetch links for the visible set).
  void hydrateServiceLinks(visible.map((e) => e.app));
  void username;
}

/** Delegate chip / search / clear interactions on the freshly painted list. */
function wireAppsListControls(root) {
  root.querySelectorAll("[data-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appsFilter = btn.getAttribute("data-chip-value") || "all";
      renderAppCards();
    });
  });
  const search = root.querySelector("[data-search]");
  if (search) {
    search.addEventListener("input", () => {
      appsQuery = search.value;
      renderAppCards();
      const next = $("apps-search");
      if (next) {
        next.focus();
        const v = next.value;
        next.setSelectionRange(v.length, v.length);
      }
    });
  }
  root.querySelector("[data-search-clear]")?.addEventListener("click", () => {
    appsQuery = "";
    renderAppCards();
    $("apps-search")?.focus();
  });
}

export async function renderServicesList() {
  const root = $("services-list-content");
  root.innerHTML = skeletonCards(3);
  appsFilter = "all";
  appsQuery = "";
  try {
    const body = await screensFetch("/api/screens/apps-list");
    if (!body.apps?.length) {
      appEntries = [];
      renderAppCards();
      return;
    }
    const username = getSession().username;
    appEntries = body.apps.map((app) => ({ app, bucket: appBucket(app, username) }));
    renderAppCards();
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
    renderServicesList().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterServicesList() {
  show("view-services-list");
  await renderServicesList();
}
