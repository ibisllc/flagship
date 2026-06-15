// Build journal viewer (webapp). Shows the append-only history of how a
// service was built, across every mode. Two entry points:
//   enterBuildJournal()        → the list of past builds
//   enterBuildJournal(buildId) → that build's timeline directly

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-build-journal");

export function initBuildJournalView() {
  $("build-journal-back").addEventListener("click", () => show("view-build-source"));
}

export async function enterBuildJournal(buildId) {
  $("build-journal-detail").classList.add("hidden");
  $("build-journal-list").innerHTML = "";
  show("view-build-journal");
  if (buildId) {
    await renderDetail(buildId);
  } else {
    await renderList();
  }
}

async function renderList() {
  try {
    const r = await screensFetch("/api/build/sessions");
    const builds = r.builds || [];
    if (builds.length === 0) {
      $("build-journal-list").innerHTML = `<div class="card placeholder">No builds yet.</div>`;
      return;
    }
    $("build-journal-list").innerHTML = builds
      .map(
        (b) => `
        <button class="card full-width build-tile" data-build="${escapeHtml(b.buildId)}">
          <strong>${escapeHtml(b.serviceId || b.mode)} <span class="note">(${escapeHtml(b.mode)})</span></strong>
          <span class="note">${b.entryCount} step(s) · last: ${escapeHtml(b.lastKind)}</span>
        </button>`,
      )
      .join("");
    for (const el of $("build-journal-list").querySelectorAll("[data-build]")) {
      el.addEventListener("click", () => renderDetail(el.getAttribute("data-build")));
    }
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  }
}

async function renderDetail(buildId) {
  try {
    const r = await screensFetch(`/api/build/sessions/${encodeURIComponent(buildId)}/journal`);
    const entries = r.entries || [];
    const detail = $("build-journal-detail");
    detail.classList.remove("hidden");
    detail.innerHTML = `
      <div class="card">
        <h3>Build ${escapeHtml(buildId)}</h3>
        <ol class="build-journal-timeline">
          ${entries
            .map(
              (e) => `<li>
                <span class="note">${new Date(e.ts).toLocaleString()}</span>
                <span class="badge">${escapeHtml(e.kind)}</span>
                <span class="badge">${escapeHtml(e.actor)}</span>
                <div>${escapeHtml(e.summary)}</div>
                ${e.detail ? `<div class="note">${escapeHtml(e.detail)}</div>` : ""}
              </li>`,
            )
            .join("")}
        </ol>
      </div>`;
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  }
}
