// Activity tab: live feed of recent install events + post-recovery
// status + account audit. Mirrors apps/mobile/{ios,android}
// ActivityScreen + ActivityViewModel.
//
// Fan-out fetch the sources in parallel, then render recovery as its
// own card and the rest as a merged time-sorted "Recent" list.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl, setPodBaseUrl } from "../lib/api.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { get as profileGet } from "../lib/profilesStore.js";
import {
  auditKindLabel as auditLabel,
  auditKindIcon as auditIcon,
} from "../lib/auditLog.js";
import { enterAccountAudit } from "./account-audit.js";
import { controlApex } from "../lib/apex.js";
import { buildPodSwitcherModel } from "../lib/podSwitcher.js";
import { flagIcon } from "../lib/icons.js";
import { fetchPodInventory } from "./home.js";
import { toast } from "../lib/toast.js";

registerView("view-activity", { tab: "activity" });

// The user's online pods (statusByDomain map values), fetched alongside the
// feed so the multi-pod switcher can render. Empty until the first load.
let activityPods = [];

/** Render the multi-pod switcher for the Activity feed (parity with the
 *  Services switcher). "All servers" (first option) = the default, combined
 *  feed; a specific server scopes the per-pod parts (install events +
 *  post-recovery). Account-wide audit (.com) is always shown regardless.
 *  Hidden with ≤1 pod. Leader flag + teal-only selection, same as Services. */
function activityPodSwitcherHtml() {
  const model = buildPodSwitcherModel(activityPods, getPodBaseUrl());
  if (!model.show) return "";
  const buttons = model.options
    .map((o) => {
      const flag = o.isLeader
        ? `<span class="icon pod-switcher-leader" aria-label="Main server" title="Main server">${flagIcon}</span>`
        : "";
      return (
        `<button type="button" class="fs-chip pod-switcher-chip${o.selected ? " is-selected" : ""}" ` +
        `data-pod-switch="${escapeHtml(o.baseUrl)}" ` +
        `aria-pressed="${o.selected ? "true" : "false"}" title="${escapeHtml(o.isAll ? o.name : o.fqdn)}">` +
        `${escapeHtml(o.name)}${flag}</button>`
      );
    })
    .join("");
  return `
    <div class="fs-chip-row pod-switcher mt-1" role="group" aria-label="Switch server">
      ${buttons}
    </div>
  `;
}

/** Delegate the activity pod-switch chips. "" = "All servers" (clears the
 *  active-pod scope → the per-pod feed parts fall back to the default pod /
 *  combined view); a specific URL scopes to that pod. */
function wireActivityPodSwitcher(root) {
  root.querySelectorAll("[data-pod-switch]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-pod-switch") ?? "";
      if (next === getPodBaseUrl()) return;
      setPodBaseUrl(next);
      renderActivity().catch(() => { toast("Couldn't switch server.", "err"); });
    });
  });
}

function fmtDate(unixMs) {
  if (typeof unixMs !== "number") return "—";
  return new Date(unixMs).toLocaleString();
}

const COM_BASE = controlApex();

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

// The label / icon mapping lives in lib/auditLog.js so the inline
// preview here and the full-page Account-history view stay in lockstep
// (and both cover the v1.2 account-type / TOTP kinds). Thin aliases.
const eventKindIcon = auditIcon;
const eventKindLabel = auditLabel;

export async function renderActivity() {
  const root = $("activity-feed");
  if (!root) return;  // shell renders the static section without the feed slot
  root.innerHTML = skeletonCards(2);
  // Refresh the online-pod set so the multi-pod switcher reflects the current
  // fleet (parity with the Services switcher). Best-effort + non-blocking: a
  // failure leaves the switcher hidden, never blocks the feed.
  const switcherUsername = (() => {
    try {
      const raw = profileGet("sessionV1");
      return raw ? JSON.parse(raw).username ?? "" : "";
    } catch { return ""; }
  })();
  try {
    const { statusByDomain } = await fetchPodInventory(switcherUsername);
    activityPods = [...statusByDomain.values()];
  } catch {
    activityPods = [];
  }
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

    // Inline preview of the latest account events (newest first, capped
    // at what the 20-row fetch returned), plus a "see all" link into the
    // full-page Account-history view (live .com feed, mirror of the iOS
    // AuditLogScreen). The card is omitted entirely when there's nothing
    // to show so a fresh account doesn't render an empty header.
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
        <button class="secondary full-width mt-2" id="activity-see-all-audit">See all account history</button>
      `;

    root.innerHTML = `
      ${activityPodSwitcherHtml()}
      ${recoveryCard}
      ${auditCard}
      <h2 class="mt-4">Recent</h2>
      ${recentRows}
    `;
    wireActivityPodSwitcher(root);
    $("activity-feed-open-recovery")?.addEventListener("click", () => show("view-post-recovery"));
    $("activity-see-all-audit")?.addEventListener("click", () => {
      enterAccountAudit().catch(() => { /* silent — toast on the view itself */ });
    });
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
