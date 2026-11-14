// Responsive shell (owner, 2026-11-14): the iPad layout of the iOS app on a
// wide window. Below 700 px the webapp is the phone app it always was (one
// screen, bottom tab bar). From there up the tab bar is a sidebar, and from
// 1100 px a detail screen opens beside the list it came from, as iOS splits
// them (servers + server page, apps + app page, Activity + an entry,
// Settings + a page, Social + a thread). The breakpoints are mirrored in
// style.css; keep both in step.

export const SIDEBAR_QUERY = "(min-width: 700px)";
export const SPLIT_QUERY = "(min-width: 1100px)";

/** detail view id → the list view it opens beside. */
const SPLIT_PARENT = new Map();

/** Open `detailId` beside `listId` on a wide window. Idempotent. */
export function registerSplit(detailId, listId) {
  SPLIT_PARENT.set(detailId, listId);
}

export function splitParentOf(viewId) {
  return SPLIT_PARENT.get(viewId) ?? null;
}

const HOME = ["view-server-detail", "view-pending-server", "view-shared-server", "view-local-ai"];
const APPS = [
  "view-service-detail", "view-service-access", "view-app-access", "view-app-db",
  "view-service-env", "view-edit-service", "view-edit-describe", "view-marketplace", "view-developer",
];
const SOCIAL = ["view-thread", "view-voici-sign-in", "view-signed-in-sites"];
const ACTIVITY = ["view-account-audit", "view-audit-log", "view-audit-entry", "view-install-progress"];
const SETTINGS = [
  "view-settings", "view-account-security", "view-quantum-safety", "view-add-device", "view-recovery",
  "view-paired-sessions", "view-secured-sessions", "view-peer-backup", "view-companion-dock",
  "view-companion-requests", "view-profiles", "view-trusted-devices", "view-account-delete",
  "view-appearance", "view-privacy", "view-about", "view-tier-status",
];
for (const id of HOME) registerSplit(id, "view-home");
for (const id of APPS) registerSplit(id, "view-services-list");
for (const id of SOCIAL) registerSplit(id, "view-messages");
for (const id of ACTIVITY) registerSplit(id, "view-activity");
for (const id of SETTINGS) registerSplit(id, "view-settings-tab");

/** True when `query` matches now; false where there is no window (tests, workers). */
export function matches(query) {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Call `fn` whenever the window crosses one of the layout breakpoints. */
export function onLayoutChange(fn) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  for (const q of [SIDEBAR_QUERY, SPLIT_QUERY]) {
    try {
      window.matchMedia(q).addEventListener("change", () => fn());
    } catch { /* an old engine without MediaQueryList events keeps the layout it started with */ }
  }
}
