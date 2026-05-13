// Activity tab: live feed of pending unlock-approvals + recent install
// events + post-recovery status. Mirrors apps/mobile/{ios,android}
// ActivityScreen + ActivityViewModel.
//
// Fan-out fetch the three sources in parallel, then render approvals
// as a header card, recovery as its own card, and the rest as a
// merged time-sorted "Recent" list.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

registerView("view-activity", { tab: "activity" });

function fmtDate(unixMs) {
  if (typeof unixMs !== "number") return "—";
  return new Date(unixMs).toLocaleString();
}

async function fanOut() {
  // The fetch helpers throw ScreensError on non-2xx; recovery + detail
  // are tolerated as missing (a fresh pod has no install history yet,
  // and not every daemon ships post-recovery).
  const [approvals, detail, recovery] = await Promise.all([
    screensFetch("/api/screens/unlock-approvals/pending")
      .then((b) => b.pending ?? [])
      .catch((e) => { if (e instanceof ScreensError) return []; throw e; }),
    screensFetch("/api/screens/server-detail")
      .then((b) => b.recentInstallEvents ?? [])
      .catch((e) => { if (e instanceof ScreensError) return []; throw e; }),
    screensFetch("/api/screens/post-recovery/status")
      .then((b) => b.report ?? null)
      .catch((e) => { if (e instanceof ScreensError) return null; throw e; }),
  ]);
  return { approvals, detail, recovery };
}

export async function renderActivity() {
  const root = $("activity-feed");
  if (!root) return;  // shell renders the static section without the feed slot
  root.innerHTML = skeletonCards(2);
  try {
    const { approvals, detail, recovery } = await fanOut();

    const approvalsCard = approvals.length === 0
      ? ""
      : `
        <div class="card" style="border-left:3px solid var(--accent);">
          <div class="row">
            <span class="value">Unlock requests</span>
            <span class="pill warn">${approvals.length} waiting</span>
          </div>
          <button class="secondary full-width mt-2" id="activity-feed-open-unlock">Open queue</button>
        </div>`;

    const recoveryCard = recovery == null
      ? ""
      : `
        <div class="card">
          <div class="row">
            <span class="value">Post-recovery report</span>
            <span class="pill">${escapeHtml(recovery.status ?? "snapshot")}</span>
          </div>
          <p class="note small">
            ${recovery.totalRewritten ?? 0} rewrites · ${recovery.reattachedCount ?? 0} apps reattached
          </p>
          <button class="secondary full-width mt-2" id="activity-feed-open-recovery">View report</button>
        </div>`;

    const recentRows = detail
      .slice()
      .sort((a, b) => b.at - a.at)
      .map((e) => `
        <div class="card">
          <div class="row">
            <span class="value">${escapeHtml(e.kind)}: ${escapeHtml(e.appId)}</span>
            <span class="pill">${escapeHtml(fmtDate(e.at))}</span>
          </div>
          ${e.detail ? `<p class="note small">${escapeHtml(e.detail)}</p>` : ""}
        </div>`)
      .join("") || '<div class="card placeholder">No recent activity.</div>';

    root.innerHTML = `
      ${approvalsCard}
      ${recoveryCard}
      <h2 class="mt-4">Recent</h2>
      ${recentRows}
    `;
    $("activity-feed-open-unlock")?.addEventListener("click", () => show("view-unlock-approvals"));
    $("activity-feed-open-recovery")?.addEventListener("click", () => show("view-post-recovery"));
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

export function initActivityView() {
  // Auto-refresh on tab activation. We piggyback on the router's
  // show() side-channel by re-rendering on every entry.
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-activity") {
      renderActivity().catch(() => { /* silent */ });
    }
  });
}
