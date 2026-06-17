// Single-screen-at-a-time router for the webapp.
//
// Views register themselves with `registerView(id)` so the dispatcher
// table stays append-only — adding a P2 screen is a one-line change.
// `show(id)` toggles the `hidden` class on each registered section.
//
// Task #23 / #29 — view ids may declare a parent tab so the bottom/top
// tab bar lights up the right entry while a sub-screen is on stage.
// The router also exposes `parseViewQuery()` so app.js can route a
// `?view=…` deep-link (Web Push notificationclick) at boot.

const VIEWS = new Set();
const VIEW_TABS = new Map(); // view-id → tab id ("home" | "apps" | "activity" | "settings")
let currentView = null;

export function registerView(id, opts = {}) {
  VIEWS.add(id);
  if (opts.tab) VIEW_TABS.set(id, opts.tab);
}

/**
 * Attach a parent tab id to an already-registered view (lets app.js
 * declare the IA mapping centrally instead of forcing every view
 * module to import the tab id). Idempotent.
 */
export function setViewTab(viewId, tab) {
  VIEW_TABS.set(viewId, tab);
}

export function show(id) {
  currentView = id;
  for (const v of VIEWS) {
    const el = document.getElementById(v);
    if (el) el.classList.toggle("hidden", v !== id);
  }
  syncTabBar(id);
  // Hide the tab bar for pre-paired surfaces — bootstrap, unlock,
  // first-run wizard (#25). The wizard shell sets its own class.
  const noTabs = id === "view-bootstrap" || id === "view-unlock"
    || id === "view-pin-unlock" || id === "view-pin-set"
    || id === "view-wizard";
  document.body.classList.toggle("no-tabs", noTabs);
  // Side-channel so views can lazy-refresh on activation without
  // wiring per-route callbacks into the shell.
  document.dispatchEvent(new CustomEvent("flagship:view-shown", { detail: { id } }));
}

export function currentViewId() {
  return currentView;
}

export function listViews() {
  return [...VIEWS];
}

export function $(id) {
  return document.getElementById(id);
}

export function setSubtitle(text) {
  const el = $("subtitle");
  if (el) el.textContent = text;
}

/**
 * Highlight the tab bar entry matching the active view (if any).
 * Sub-screens (server-detail, app-detail, vibe-code, browser-viewer,
 * orders-debug, pair, pod-pair, create-server) inherit their parent
 * tab via VIEW_TABS so users always know where they are.
 */
function syncTabBar(viewId) {
  const tab = VIEW_TABS.get(viewId) ?? null;
  for (const btn of document.querySelectorAll("[data-tab-target]")) {
    btn.classList.toggle("is-active", btn.getAttribute("data-tab-target") === tab);
    if (btn.getAttribute("data-tab-target") === tab) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  }
}

/**
 * Parse `?view=<id>&serverId=<sid>` from the current URL. Used at boot
 * to honour Web Push notification deep-links (#29). The router resolves
 * view aliases to the canonical id; unknown ids fall through silently.
 */
export function parseViewQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("view");
    if (!raw) return null;
    return {
      view: resolveViewAlias(raw),
      serverId: params.get("serverId") ?? null,
      serviceId: params.get("serviceId") ?? null,
      // The W10 `vibecode-needs-you` push deep-links to
      // `?view=vibecode-chat&sessionId=<id>` (service-worker.js); carry the
      // session id so the cold-start dispatcher can open that session's chat.
      sessionId: params.get("sessionId") ?? null,
      debug: params.get("debug") === "1",
    };
  } catch {
    return null;
  }
}

/**
 * Service-worker / notification deep-links use short verb aliases
 * (unlock-approvals, recovery, activity, …). Map them onto the
 * canonical `view-<id>` ids registered above.
 */
function resolveViewAlias(alias) {
  const a = String(alias).toLowerCase();
  if (a.startsWith("view-")) return a;
  const aliases = {
    home: "view-home",
    apps: "view-apps-list",
    "apps-list": "view-apps-list",
    activity: "view-activity",
    settings: "view-settings",
    recovery: "view-recovery",
    "install-progress": "view-install-progress",
    "pod-pair": "view-pod-pair",
    "server-detail": "view-server-detail",
    "create-server": "view-create-server",
    // W10 vibecode-needs-you chat — the service worker emits `vibecode-chat`;
    // accept the hyphenated `vibe-code-chat` spelling too. Both land on the
    // registered `view-vibecode-chat`.
    "vibecode-chat": "view-vibecode-chat",
    "vibe-code-chat": "view-vibecode-chat",
  };
  return aliases[a] ?? `view-${a}`;
}

export function isDebug() {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "1"
      || localStorage.getItem("flagship.debug") === "1";
  } catch {
    return false;
  }
}

/**
 * Strip ?view= / ?serverId= / ?serviceId= / ?debug= from the URL bar once
 * we've consumed them, so a deep-link doesn't keep firing on every
 * subsequent reload. Kept side-effecting (no return) — callers don't
 * need the URL object.
 */
export function clearViewQuery() {
  try {
    const u = new URL(window.location.href);
    let touched = false;
    for (const k of ["view", "serverId", "serviceId", "sessionId"]) {
      if (u.searchParams.has(k)) {
        u.searchParams.delete(k);
        touched = true;
      }
    }
    if (touched) window.history.replaceState({}, "", u.toString());
  } catch { /* old browsers — ignore */ }
}
