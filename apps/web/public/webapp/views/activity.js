// Activity tab: one time-sorted list of what the servers did (their own log at
// /api/screens/activity: updates, migration, backups, imports, app changes,
// shares) merged with the account events from flagshipserver.com, plus the
// post-recovery card. Mirrors apps/mobile/{ios,android} ActivityScreen +
// ActivityViewModel. Sources are fetched in parallel.
// A filter at the top (All / Servers / Social, docs/activity-social.md) adds the calls and social entries built in this
// browser (lib/socialActivity.js) and can show them alone.

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
import { getSession } from "../lib/state.js";

import { tr } from "../lib/i18n.js";
import { noServerCardHtml } from "../lib/noServerCard.js";
import { renderChatSection } from "../lib/chatAlerts.js";
import { renderBrowserGrantSection } from "../lib/browserGrantAlerts.js";
import { buildSocialActivity, socialEntryDetail, socialEntryIcon, socialEntryTitle } from "../lib/socialActivity.js";
import { refreshWorld, visibleConversations, visitorName, world } from "../lib/voiciWorld.js";
import { isRequest } from "../lib/voiciOwner.js";
import { callHistory } from "../lib/voiciCallOut.js";
registerView("view-activity", { tab: "activity" });

// The user's online pods (statusByDomain map values), fetched alongside the
// feed so the multi-pod switcher can render. Empty until the first load.
let activityPods = [];

/** "all", "servers" or "social" (docs/activity-social.md). */
let activityFilter = "all";
const FILTERS = ["all", "servers", "social"];

function filterLabel(f) {
  return f === "servers" ? tr("Servers") : f === "social" ? tr("Social") : tr("All");
}

/** All / Servers / Social, above everything else on the tab. */
function renderFilter() {
  const slot = $("activity-filter-slot");
  if (!slot) return;
  slot.innerHTML = `
    <div class="fs-chip-row" role="radiogroup" aria-label="${escapeHtml(tr("Show"))}" data-testid="activity-filter">
      ${FILTERS.map(
        (f) =>
          `<button type="button" class="fs-chip${f === activityFilter ? " is-selected" : ""}" role="radio" aria-checked="${f === activityFilter}" data-activity-filter="${f}">${escapeHtml(filterLabel(f))}</button>`,
      ).join("")}
    </div>`;
  slot.querySelectorAll("[data-activity-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      const next = b.getAttribute("data-activity-filter");
      if (next === activityFilter) return;
      activityFilter = next;
      renderActivity().catch(() => {});
    }),
  );
}

/** The calls, conversations and page entries this browser can build (empty for a sample account or while locked). */
export function currentSocialEntries() {
  if (world.sample) return [];
  return buildSocialActivity({
    history: callHistory(world.missedCalls),
    conversations: visibleConversations(),
    isRequest: (cv) => isRequest(cv, world.state),
    name: visitorName,
    page: world.page,
  });
}

async function openSocialEntry(e) {
  if (e.target.kind === "thread") {
    const { enterThread } = await import("./thread.js");
    return enterThread(e.target.conv);
  }
  if (e.target.kind === "calls") {
    const { enterCalls } = await import("./calls.js");
    return enterCalls();
  }
  const { enterYourPage } = await import("./messages.js");
  return enterYourPage();
}

/** The "Calls and messages" section: a tap opens the conversation, the Calls page or the page. */
async function renderSocialSection() {
  const root = $("activity-social");
  if (!root) return;
  if (activityFilter === "servers") {
    root.hidden = true;
    root.replaceChildren();
    return;
  }
  root.hidden = false;
  if (!world.pageLoaded && !world.sample) await refreshWorld().catch(() => {});
  const entries = currentSocialEntries();
  const list = entries.length === 0
    ? `<div class="card placeholder" data-testid="activity-social-empty">${escapeHtml(tr("No calls or messages yet."))}</div>`
    : `<div class="fs-group">${entries
        .map(
          (e, i) => `
      <button type="button" class="fs-row" data-social-entry="${i}" data-testid="activity-social-${escapeHtml(e.kind)}">
        <span class="fs-row-icon icon${e.kind === "call.missed" ? " fs-row-icon--warn" : ""}" aria-hidden="true">${socialEntryIcon(e)}</span>
        <span class="fs-row-body">
          <span class="fs-row-title">${escapeHtml(socialEntryTitle(e))}</span>
          ${socialEntryDetail(e) ? `<span class="fs-row-subtitle">${escapeHtml(socialEntryDetail(e))}</span>` : ""}
          <span class="fs-row-subtitle">${escapeHtml(fmtDate(e.at))}</span>
        </span>
      </button>`,
        )
        .join("")}</div>`;
  root.innerHTML = `
    <h2 id="activity-social-heading" class="${activityFilter === "social" ? "" : "mt-5"}">${escapeHtml(tr("Calls and messages"))}</h2>
    ${list}`;
  root.querySelectorAll("[data-social-entry]").forEach((b) =>
    b.addEventListener("click", () => {
      const e = entries[Number(b.getAttribute("data-social-entry"))];
      if (e) openSocialEntry(e).catch(() => {});
    }),
  );
}

/** Social shows only the calls and social entries; the servers' parts hide. */
function applyFilterVisibility(noServer) {
  const social = activityFilter === "social";
  $("activity-approvals")?.toggleAttribute("hidden", social);
  const noServerSlot = $("activity-no-server");
  if (noServerSlot) noServerSlot.hidden = social || !noServer;
  $("activity-with-server")?.toggleAttribute("hidden", social || noServer);
  if (social) {
    $("activity-chat")?.toggleAttribute("hidden", true);
    $("activity-browser")?.toggleAttribute("hidden", true);
  }
}

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
        ? `<span class="icon pod-switcher-leader" aria-label="${tr("Main server")}" title="${tr("Main server")}">${flagIcon}</span>`
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
    <div class="fs-chip-row pod-switcher mt-1" role="group" aria-label="${tr("Switch server")}">
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
      renderActivity().catch(() => { toast(tr("Couldn't switch server."), "err"); });
    });
  });
}

function fmtDate(unixMs) {
  if (typeof unixMs !== "number") return "—";
  return formatDateTime(unixMs);
}

const COM_BASE = controlApex();

/** The signed-in account (the session, else this profile's username slot;
 *  the old `sessionV1` slot is read last for profiles that still carry it). */
function activeUsername() {
  const fromSession = getSession()?.username;
  if (fromSession) return fromSession;
  try {
    const name = profileGet("username");
    if (name) return name;
    const raw = profileGet("sessionV1");
    return raw ? JSON.parse(raw).username ?? "" : "";
  } catch {
    return "";
  }
}

async function fanOut() {
  // The fetch helpers throw ScreensError on non-2xx; recovery + detail
  // are tolerated as missing (a fresh pod has no install history yet,
  // and not every daemon ships post-recovery). The audit feed lives
  // on .com (not on the daemon) so it uses a separate fetch keyed
  // by the user's username.
  const username = activeUsername();
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
      return { serverName: label ? podShortName(fqdn) : "", fqdn, entries };
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
  renderFilter();
  void renderSocialSection().catch(() => {});
  if (activityFilter === "social") {
    applyFilterVisibility(false);
    return;
  }
  root.innerHTML = skeletonCards(2);
  // Refresh the online-pod set so the multi-pod switcher reflects the current
  // fleet (parity with the Services switcher). Best-effort + non-blocking: a
  // failure leaves the switcher hidden, never blocks the feed.
  const switcherUsername = activeUsername();
  let inventoryOk = false;
  try {
    const { statusByDomain } = await fetchPodInventory(switcherUsername);
    activityPods = [...statusByDomain.values()];
    inventoryOk = true;
  } catch {
    activityPods = [];
  }
  // No server yet: the same card Services shows, above the server approvals
  // (which stay, as a first boot asks there); the feed has nothing to show.
  const noServer = inventoryOk && activityPods.length === 0;
  const noServerSlot = $("activity-no-server");
  if (noServerSlot) {
    noServerSlot.innerHTML = noServer ? noServerCardHtml() : "";
    noServerSlot.hidden = !noServer;
  }
  $("activity-with-server")?.toggleAttribute("hidden", noServer);
  applyFilterVisibility(noServer);
  if (noServer) {
    $("activity-chat")?.toggleAttribute("hidden", true);
    $("activity-browser")?.toggleAttribute("hidden", true);
    return;
  }
  void renderChatSection().catch(() => {});
  void renderBrowserGrantSection().catch(() => {});
  try {
    const { boxes, recovery, audit } = await fanOut();

    const recoveryCard = recovery == null
      ? ""
      : `
        <div class="card">
          <div class="row">
            <span class="value">${tr("Post-recovery report")}</span>
            <span class="pill">${escapeHtml(recovery.status ?? "snapshot")}</span>
          </div>
          <p class="note small">
            ${tr("{0} rewrites · {1} apps reattached", recovery.totalRewritten ?? 0, recovery.reattachedCount ?? 0)}
          </p>
          <button class="secondary full-width mt-2" id="activity-feed-open-recovery">${tr("View report")}</button>
        </div>`;

    const rows = mergeFeed({
      boxes,
      audit,
      auditLabel: eventKindLabel,
      auditIcon: eventKindIcon,
      auditDetail: auditDisplayDetail,
    });
    const feed = rows.length === 0
      ? `<div class="card placeholder">${tr("Nothing has happened yet.")}</div>`
      : rows.map((r, i) => `
        <div class="card${r.ok ? "" : " warning"}${r.fqdn ? " is-clickable" : ""}"${r.fqdn ? ` role="button" tabindex="0" data-feed-server="${i}" title="${escapeHtml(tr("Opens the server"))}"` : ""}>
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
      <button class="secondary full-width mt-2" id="activity-see-all-audit">${tr("See all account history")}</button>
    `;
    wireActivityPodSwitcher(root);
    // A server's log entry opens that server.
    root.querySelectorAll("[data-feed-server]").forEach((card) => {
      const open = async () => {
        const fqdn = rows[Number(card.getAttribute("data-feed-server"))]?.fqdn;
        if (!fqdn) return;
        const { enterServerDetail } = await import("./server-detail.js");
        await enterServerDetail(fqdn);
      };
      card.addEventListener("click", () => { open().catch(() => {}); });
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open().catch(() => {}); }
      });
    });
    $("activity-feed-open-recovery")?.addEventListener("click", async () => {
      const { enterPostRecovery } = await import("./post-recovery.js");
      enterPostRecovery({ back: "view-activity" });
    });
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
