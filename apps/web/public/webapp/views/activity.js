// Activity tab: one time-sorted list of what the servers did (their own log at
// /api/screens/activity: updates, migration, backups, imports, app changes,
// shares) merged with the account events from flagshipserver.com, plus the
// post-recovery card. Mirrors apps/mobile/{ios,android} ActivityScreen +
// ActivityViewModel. Sources are fetched in parallel.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl, setPodBaseUrl, boxClient } from "../lib/api.js";
import { mergeFeed } from "../lib/activityFeed.js";
import { podShortName } from "../lib/podSwitcher.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { get as profileGet } from "../lib/profilesStore.js";
import {
  auditKindLabel as auditLabel,
  auditKindIcon as auditIcon,
  auditDisplayDetail,
} from "../lib/auditLog.js";
import { enterAccountAudit } from "./account-audit.js";
import { controlApex } from "../lib/apex.js";
import { buildPodSwitcherModel } from "../lib/podSwitcher.js";
import { flagIcon } from "../lib/icons.js";
import { fetchPodInventory } from "./home.js";
import { toast } from "../lib/toast.js";
import { formatDateTime } from "../lib/dateFormat.js";
import { accountReadFetch } from "../lib/accountRead.js";

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
  return formatDateTime(unixMs);
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
  const [boxes, recovery, audit] = await Promise.all([
    fetchBoxEvents(),
    screensFetch("/api/screens/post-recovery/status")
      .then((b) => b.report ?? null)
      .catch((e) => { if (e instanceof ScreensError) return null; throw e; }),
    username
      ? accountReadFetch(`${COM_BASE}/api/users/${encodeURIComponent(username)}/audit?since=0&limit=20`, { cache: "no-store" })
          .then((r) => r.ok ? r.json() : { events: [] })
          .then((b) => b.events ?? [])
          .catch(() => [])
      : Promise.resolve([]),
  ]);
  return { boxes, recovery, audit };
}

/** Each server's own log: the selected server's, or every server this device has a session for. */
async function fetchBoxEvents() {
  const specific = (() => {
    try {
      const host = new URL(getPodBaseUrl()).hostname;
      return host || "";
    } catch {
      return "";
    }
  })();
  const fqdns = specific
    ? [specific]
    : activityPods.map((p) => String(p?.serverDomain ?? "").toLowerCase()).filter(Boolean);
  if (fqdns.length === 0) {
    const entries = await screensFetch("/api/screens/activity?limit=100")
      .then((b) => b.entries ?? [])
      .catch((e) => { if (e instanceof ScreensError) return []; throw e; });
    return [{ serverName: "", entries }];
  }
  const label = fqdns.length > 1;
  return Promise.all(
    fqdns.map(async (fqdn) => {
      const client = boxClient(fqdn);
      if (!client.hasSession()) return { serverName: "", entries: [] };
      const entries = await client
        .fetch("/api/screens/activity?limit=100")
        .then((b) => b?.entries ?? [])
        .catch(() => []);
      return { serverName: label ? podShortName(fqdn) : "", entries };
    }),
  );
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
    const { boxes, recovery, audit } = await fanOut();

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

    const rows = mergeFeed({
      boxes,
      audit,
      auditLabel: eventKindLabel,
      auditIcon: eventKindIcon,
      auditDetail: auditDisplayDetail,
    });
    const feed = rows.length === 0
      ? '<div class="card placeholder">Nothing has happened yet.</div>'
      : rows.map((r) => `
        <div class="card${r.ok ? "" : " card-warn"}">
          <div class="row">
            <span class="value"><span aria-hidden="true">${escapeHtml(r.icon)}</span> ${escapeHtml(r.title)}</span>
            <span class="pill">${escapeHtml(fmtDate(r.at))}</span>
          </div>
          ${r.server ? `<p class="note small">${escapeHtml(r.server)}</p>` : ""}
          ${r.detail ? `<p class="note small">${escapeHtml(r.detail)}</p>` : ""}
        </div>`).join("");

    root.innerHTML = `
      ${activityPodSwitcherHtml()}
      ${recoveryCard}
      ${feed}
      <button class="secondary full-width mt-2" id="activity-see-all-audit">See all account history</button>
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
