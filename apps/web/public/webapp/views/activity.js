// Activity tab: live feed of recent install events + post-recovery
// status + account audit. Mirrors apps/mobile/{ios,android}
// ActivityScreen + ActivityViewModel.
//
// Fan-out fetch the sources in parallel, then render recovery as its
// own card and the rest as a merged time-sorted "Recent" list.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { get as profileGet } from "../lib/profilesStore.js";

registerView("view-activity", { tab: "activity" });

function fmtDate(unixMs) {
  if (typeof unixMs !== "number") return "—";
  return new Date(unixMs).toLocaleString();
}

const COM_BASE = "https://flagshipserver.com";

async function fanOut() {
  // The fetch helpers throw ScreensError on non-2xx; recovery + detail
  // are tolerated as missing (a fresh pod has no install history yet,
  // and not every daemon ships post-recovery). The audit feed lives
  // on .com (not on the daemon) so it uses a separate fetch keyed
  // by the user's username.
  const username = (() => {
    try {
      const raw = profileGet("sessionV1");
      return raw ? JSON.parse(raw).username ?? "" : "";
    } catch { return ""; }
  })();
  const [detail, recovery, audit] = await Promise.all([
    screensFetch("/api/screens/server-detail")
      .then((b) => b.recentInstallEvents ?? [])
      .catch((e) => { if (e instanceof ScreensError) return []; throw e; }),
    screensFetch("/api/screens/post-recovery/status")
      .then((b) => b.report ?? null)
      .catch((e) => { if (e instanceof ScreensError) return null; throw e; }),
    username
      ? fetch(`${COM_BASE}/api/users/${encodeURIComponent(username)}/audit?since=0&limit=20`, { cache: "no-store" })
          .then((r) => r.ok ? r.json() : { events: [] })
          .then((b) => b.events ?? [])
          .catch(() => [])
      : Promise.resolve([]),
  ]);
  return { detail, recovery, audit };
}

function eventKindIcon(kind) {
  return ({
    "device-disconnected": "🔌",
    "device-replaced":     "🔄",
    "device-added":        "➕",
    "wipe-restart":        "🗑️",
    "recovery-set-up":     "🔐",
    "recovery-rotated":    "🔁",
    "app-renamed":         "🔗",
  })[kind] ?? "•";
}

function eventKindLabel(kind) {
  return ({
    "device-disconnected": "Disconnected",
    "device-replaced":     "Replaced",
    "device-added":        "Added device",
    "wipe-restart":        "Wiped & restarted",
    "recovery-set-up":     "Recovery set up",
    "recovery-rotated":    "Recovery rotated",
    "app-renamed":         "Renamed app URL",
  })[kind] ?? kind;
}

export async function renderActivity() {
  const root = $("activity-feed");
  if (!root) return;  // shell renders the static section without the feed slot
  root.innerHTML = skeletonCards(2);
  try {
    const { detail, recovery, audit } = await fanOut();

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
            <span class="value">${escapeHtml(e.kind)}: ${escapeHtml(e.serviceId)}</span>
            <span class="pill">${escapeHtml(fmtDate(e.at))}</span>
          </div>
          ${e.detail ? `<p class="note small">${escapeHtml(e.detail)}</p>` : ""}
        </div>`)
      .join("") || '<div class="card placeholder">No recent activity.</div>';

    const auditCard = audit.length === 0
      ? ""
      : `
        <h2 class="mt-4">Account events</h2>
        ${audit.map((e) => `
          <div class="card">
            <div class="row">
              <span class="value">
                <span aria-hidden="true">${eventKindIcon(e.eventKind)}</span>
                ${escapeHtml(eventKindLabel(e.eventKind))}
              </span>
              <span class="pill">${escapeHtml(fmtDate(e.postedAt))}</span>
            </div>
            ${e.detail ? `<p class="note small">${escapeHtml(e.detail)}</p>` : ""}
          </div>`).join("")}
      `;

    root.innerHTML = `
      ${recoveryCard}
      ${auditCard}
      <h2 class="mt-4">Recent</h2>
      ${recentRows}
    `;
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
