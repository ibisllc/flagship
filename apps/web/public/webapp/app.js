// Flagship webapp — entry point.
//
// All view logic lives in `views/<name>.js`. This file:
//   1. Imports each view module (each registers itself with the
//      router via registerView() on load).
//   2. Calls each view's init function to bind DOM event listeners.
//   3. Decides which view to show based on the keystore state.
//
// Sensitive material (UMK seed, IRK private key) is held only in
// `lib/state.js`'s closure — never on `window`, never logged.

import { hasWrappedUmk } from "./keystore.js";
import { setSubtitle, show, $, registerView, setViewTab, isDebug } from "./lib/router.js";
import { toast } from "./lib/toast.js";
import {
  activityIcon,
  packageIcon,
  serverIcon,
  settingsIcon,
} from "./lib/icons.js";
import { initBootstrapView } from "./views/bootstrap.js";
import { initUnlockView } from "./views/unlock.js";
import { initHomeView, enterHome } from "./views/home.js";
import { initPairView, startPairing } from "./views/pair.js";
import { initSettingsView, renderProviders } from "./views/settings.js";
import { initPodPairView, enterPodPair } from "./views/pod-pair.js";
import { initServerDetailView, enterServerDetail } from "./views/server-detail.js";
import { initAppsListView, enterAppsList } from "./views/apps-list.js";
import { initAppDetailView } from "./views/app-detail.js";
import { initInviteIssueView } from "./views/invite-issue.js";
import { initInviteManageView } from "./views/invite-manage.js";
import { initPairedSessionsView, enterPairedSessions } from "./views/paired-sessions.js";
import { initTierStatusView, enterTierStatus } from "./views/tier-status.js";
import { initMarketplaceView, enterMarketplace } from "./views/marketplace.js";
import { initVibeCodeView, enterVibeCode } from "./views/vibe-code.js";
import { initUnlockApprovalsView, enterUnlockApprovals } from "./views/unlock-approvals.js";
import { initRecoveryView, enterRecovery } from "./views/recovery.js";
import { initInstallProgressView, enterInstallProgress } from "./views/install-progress.js";
import { initOrdersDebugView, enterOrdersDebug } from "./views/orders-debug.js";
import { initBrowserViewerView } from "./views/browser-viewer.js";
import { initCreateServerView, enterCreateServer } from "./views/create-server.js";

// Register the tab-bar landing sections (#23). They have no per-view
// module — the tab bar simply toggles them.
registerView("view-activity", { tab: "activity" });
registerView("view-settings-tab", { tab: "settings" });

// Sub-views inherit a parent tab so the tab bar lights up the right
// entry when the user drills into a detail screen. Centralised here
// (instead of per-view) so the IA map lives in one file.
const SUB_VIEW_TABS = {
  "view-home": "home",
  "view-server-detail": "home",
  "view-pod-pair": "home",
  "view-pair": "home",
  "view-create-server": "home",
  "view-apps-list": "apps",
  "view-app-detail": "apps",
  "view-invite-issue": "apps",
  "view-invite-manage": "apps",
  "view-marketplace": "apps",
  "view-vibe-code": "apps",
  "view-browser-viewer": "apps",
  "view-unlock-approvals": "activity",
  "view-install-progress": "activity",
  "view-settings": "settings",
  "view-recovery": "settings",
  "view-post-recovery": "settings",
  "view-tier-status": "settings",
  "view-paired-sessions": "settings",
  "view-orders-debug": "settings",
};

async function enterActivityTab() {
  show("view-activity");
}

async function enterSettingsTab() {
  show("view-settings-tab");
  // Reflect the debug toggle's current state every time the tab is opened.
  const toggle = $("settings-debug-toggle");
  const row = $("settings-developer-row");
  if (toggle && row) {
    const on = isDebug();
    toggle.checked = on;
    row.classList.toggle("hidden", !on);
  }
}

/**
 * #33 — promote ?debug=1 in the URL to a sticky localStorage flag the
 * first time we see it. Power users can curl-style enable the
 * developer surfaces by reloading with ?debug=1; subsequent reloads
 * remember the setting until they untick it from Settings → Advanced.
 */
function persistDebugFlagFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("debug") === "1") {
      localStorage.setItem("flagship.debug", "1");
    }
  } catch { /* ignore */ }
}

function wireTabBar() {
  // Lucide icons rendered into the tab strip — matches the existing
  // home-grid decoration pattern so colour cascades on hover/active.
  const map = {
    home: serverIcon,
    apps: packageIcon,
    activity: activityIcon,
    settings: settingsIcon,
  };
  for (const span of document.querySelectorAll("[data-tab-icon]")) {
    const k = span.getAttribute("data-tab-icon");
    if (k && map[k]) span.innerHTML = map[k];
  }
  const go = async (tab) => {
    try {
      if (tab === "home") await enterHome();
      else if (tab === "apps") await enterAppsList();
      else if (tab === "activity") await enterActivityTab();
      else if (tab === "settings") await enterSettingsTab();
    } catch (e) {
      toast(String(e), "err");
    }
  };
  for (const btn of document.querySelectorAll("[data-tab-target]")) {
    btn.addEventListener("click", () => go(btn.getAttribute("data-tab-target")));
  }
}

function wireSettingsTabEntries() {
  const wire = (id, fn) =>
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => toast(String(e), "err")));
  // Account stack
  wire("settings-tab-providers", async () => {
    show("view-settings");
    await renderProviders();
  });
  wire("settings-tab-push", async () => {
    show("view-settings");
    await renderProviders();
    document.querySelector("#push-enable")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  wire("settings-tab-recovery", enterRecovery);
  wire("settings-tab-tier", enterTierStatus);
  wire("settings-tab-sessions", enterPairedSessions);
  wire("settings-tab-orders-debug", enterOrdersDebug);
  wire("settings-tab-create-server", enterCreateServer);
  $("settings-tab-reset")?.addEventListener("click", async () => {
    const { handleReset } = await import("./views/unlock.js");
    await handleReset();
  });

  // Debug toggle — flips localStorage and reveals the developer row.
  const toggle = $("settings-debug-toggle");
  const row = $("settings-developer-row");
  toggle?.addEventListener("change", () => {
    const on = !!toggle.checked;
    try {
      if (on) localStorage.setItem("flagship.debug", "1");
      else localStorage.removeItem("flagship.debug");
    } catch { /* private-mode storage failure — non-fatal */ }
    row?.classList.toggle("hidden", !on);
  });
}

function wireActivityEntries() {
  const wire = (id, fn) =>
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => toast(String(e), "err")));
  wire("activity-open-unlock-approvals", enterUnlockApprovals);
  wire("activity-open-install-progress", enterInstallProgress);
}

function wireAppsTabEntries() {
  const wire = (id, fn) =>
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => toast(String(e), "err")));
  wire("apps-list-open-marketplace", enterMarketplace);
  wire("apps-list-open-vibe-code", enterVibeCode);
}

async function boot() {
  persistDebugFlagFromUrl();
  initBootstrapView();
  initUnlockView();
  initHomeView({
    onPair: () => startPairing(),
    onSettings: async () => {
      show("view-settings");
      await renderProviders();
    },
  });
  initPairView();
  initSettingsView();
  initPodPairView();
  initServerDetailView();
  initAppsListView();
  initAppDetailView();
  initInviteIssueView();
  initInviteManageView();
  initPairedSessionsView();
  initTierStatusView();
  initMarketplaceView();
  initVibeCodeView();
  initUnlockApprovalsView();
  initRecoveryView();
  // post-recovery is owned by another worker; init it best-effort so
  // the shell loads cleanly whether or not it's on disk yet.
  try {
    const mod = await import("./views/post-recovery.js");
    mod.initPostRecoveryView?.();
  } catch { /* not shipped yet — fine */ }
  initInstallProgressView();
  initOrdersDebugView();
  initBrowserViewerView();
  initCreateServerView();

  // Home-tab → in-tab nav (the legacy home-grid is gone; what remains
  // are the two session-row buttons "pair-with-server" + "open-pod-pair").
  const wire = (id, fn) =>
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => toast(String(e), "err")));
  wire("open-pod-pair", enterPodPair);

  // Tag every sub-view with its parent tab — `setViewTab` requires
  // the view to be registered first, which init*View() above guarantees.
  for (const [id, tab] of Object.entries(SUB_VIEW_TABS)) setViewTab(id, tab);

  wireTabBar();
  wireSettingsTabEntries();
  wireActivityEntries();
  wireAppsTabEntries();

  if (await hasWrappedUmk()) {
    setSubtitle("locked");
    show("view-unlock");
  } else {
    setSubtitle("first run");
    show("view-bootstrap");
  }
}

boot().catch((e) => {
  setSubtitle("startup failed");
  toast(String(e), "err");
});
