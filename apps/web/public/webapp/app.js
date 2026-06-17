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
import { setSubtitle, show, $, registerView, setViewTab, isDebug, currentViewId } from "./lib/router.js";
import { toast } from "./lib/toast.js";
import { humanError } from "./lib/humanError.js";
import {
  initOperationsBar,
  refreshOperationsBar,
  setOperationsBarUnlockedResolver,
} from "./lib/operationsBar.js";
import { installComFetchGuard } from "./lib/comFetch.js";
import { refreshServerTrust, serverTrust } from "./lib/serverTrust.js";
import { initTrustSliver, setTrustSliverTapHandler } from "./lib/trustSliver.js";
import { grantTrustException, loadAndApplyExceptions } from "./lib/trustOverride.js";
import { inlinePrompt } from "./lib/modal.js";
import { verifyPin, hasPin } from "./lib/pinLock.js";
import {
  activityIcon,
  packageIcon,
  serverIcon,
  settingsIcon,
  sparklesIcon,
  shieldIcon,
  keyIcon,
  usersIcon,
  monitorIcon,
  userIcon,
  hardDriveIcon,
  unlockIcon,
  chevronRightIcon,
} from "./lib/icons.js";
import { profileCard } from "./lib/uikit.js";
import { getSession } from "./lib/state.js";
import { initBootstrapView } from "./views/bootstrap.js";
import { initUnlockView } from "./views/unlock.js";
import { initPinViews } from "./views/pinLock.js";
import { hasPin } from "./lib/pinLock.js";
import { initHomeView, enterHome } from "./views/home.js";
import { initPairView, startPairing } from "./views/pair.js";
import { initSettingsView, renderProviders } from "./views/settings.js";
import { initPodPairView, enterPodPair } from "./views/pod-pair.js";
import { initServerDetailView, enterServerDetail } from "./views/server-detail.js";
import { initServicesListView, enterServicesList } from "./views/services-list.js";
import { initServiceDetailView } from "./views/service-detail.js";
import { initInviteIssueView } from "./views/invite-issue.js";
import { initInviteManageView } from "./views/invite-manage.js";
import { initPairedSessionsView, enterPairedSessions } from "./views/paired-sessions.js";
import { initPeerBackupView, enterPeerBackup } from "./views/peer-backup.js";
import { initCompanionDockView, enterCompanionDock } from "./views/companion-dock.js";
import {
  initCompanionRequestsView,
  enterCompanionRequests,
  refreshBadgeOnce as refreshCompanionRequestsBadge,
} from "./views/companion-requests.js";
import { initVibeCodeView, enterVibeCode } from "./views/vibe-code.js";
import { initServiceEnvView, enterServiceEnv } from "./views/service-env.js";
import { initVibeCodeChatView, enterVibeCodeChat } from "./views/vibecode-chat.js";
import { initBuildSourceView, enterBuildSource } from "./views/build-source.js";
import { initBuildKeyView } from "./views/build-key.js";
import { initBuildGitView } from "./views/build-git.js";
import { initBuildMcpView } from "./views/build-mcp.js";
import { initBuildJournalView } from "./views/build-journal.js";
import { initRecoveryView, enterRecovery } from "./views/recovery.js";
import { initInstallProgressView, enterInstallProgress } from "./views/install-progress.js";
import { initOrdersDebugView, enterOrdersDebug } from "./views/orders-debug.js";
import { initBrowserViewerView } from "./views/browser-viewer.js";
import { initCreateServerView, enterCreateServer } from "./views/create-server.js";
import { initActivityView, renderActivity } from "./views/activity.js";
import { initAccountAuditView } from "./views/account-audit.js";
import { initBootApprovalView, enterBootApproval } from "./views/boot-approval.js";
import { initPendingServerView, enterPendingServer } from "./views/pending-server.js";
import { initTrustedDevicesView } from "./views/trusted-devices.js";
import { initAccountSecurityView } from "./views/account-security.js";
import { initAddDeviceView } from "./views/add-device.js";
import { initJoinView, enterJoin } from "./views/join.js";
import { initProfilesView, enterProfiles, renderProfiles, setProfileSwitchHandler } from "./views/profiles.js";
import { joinLinkFromLocation } from "./lib/crossDevicePairing.js";
import {
  migrateLegacy as migrateProfilesStore,
  cleanupLegacyKeys as cleanupProfilesLegacyKeys,
} from "./lib/profilesStore.js";
import {
  companionPayloadFromLocation,
  redeemCompanionAndPersist,
} from "./lib/companionReceiver.js";

// Register the tab-bar landing sections (#23). They have no per-view
// module — the tab bar simply toggles them.
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
  "view-services-list": "apps",
  "view-service-detail": "apps",
  "view-invite-issue": "apps",
  "view-invite-manage": "apps",
  "view-vibe-code": "apps",
  "view-vibecode-chat": "apps",
  "view-build-source": "apps",
  "view-build-key": "apps",
  "view-build-git": "apps",
  "view-build-mcp": "apps",
  "view-build-journal": "apps",
  "view-service-env": "apps",
  "view-browser-viewer": "apps",
  "view-install-progress": "activity",
  "view-account-audit": "activity",
  "view-boot-approval": "activity",
  "view-settings": "settings",
  "view-account-security": "settings",
  "view-add-device": "settings",
  "view-recovery": "settings",
  "view-post-recovery": "settings",
  "view-paired-sessions": "settings",
  "view-peer-backup": "settings",
  "view-companion-dock": "settings",
  "view-companion-requests": "settings",
  "view-profiles": "settings",
  "view-orders-debug": "settings",
};

async function enterActivityTab() {
  show("view-activity");
}

// Settings-tab row icon map (data-row-icon → SVG body). Stamped once on
// first entry so the grouped rows carry their teal icon squares + chevrons.
const SETTINGS_ROW_ICONS = {
  providers: sparklesIcon,
  security: shieldIcon,
  push: activityIcon,
  tier: activityIcon,
  recovery: keyIcon,
  devices: usersIcon,
  sessions: monitorIcon,
  backup: hardDriveIcon,
  dock: monitorIcon,
  requests: usersIcon,
  profiles: userIcon,
  reset: unlockIcon,
  chevron: chevronRightIcon,
};

/** Populate the Settings profile hero + stamp the row icon squares. */
function decorateSettingsTab() {
  // Profile hero — teal monogram + username + account status. Tapping it
  // opens AI providers (the primary account surface), matching the iOS
  // profile card's drill-down into account.
  const hero = $("settings-profile-hero");
  if (hero) {
    let username = "";
    try { username = getSession().username || ""; } catch { /* locked */ }
    hero.innerHTML = profileCard({
      name: username,
      subtitle: username ? "Your Flagship account" : "Signed in",
    });
    hero.querySelector("[data-profile-card]")?.addEventListener("click", async () => {
      show("view-settings");
      await renderProviders();
    });
  }
  // Stamp the row icon squares + chevrons once.
  for (const span of document.querySelectorAll("#view-settings-tab [data-row-icon]")) {
    if (span.dataset.iconWired === "1") continue;
    const k = span.getAttribute("data-row-icon");
    if (k && SETTINGS_ROW_ICONS[k]) {
      span.innerHTML = SETTINGS_ROW_ICONS[k];
      span.dataset.iconWired = "1";
    }
  }
}

async function enterSettingsTab() {
  show("view-settings-tab");
  decorateSettingsTab();
  // Reflect the debug toggle's current state every time the tab is opened.
  const toggle = $("settings-debug-toggle");
  const row = $("settings-developer-row");
  if (toggle && row) {
    const on = isDebug();
    toggle.checked = on;
    row.classList.toggle("hidden", !on);
  }
  // P14 Phase 2 — refresh the companion-requests badge on Settings entry.
  // Best-effort; an older daemon (503) leaves the badge at 0.
  refreshCompanionRequestsBadge().catch(() => { /* swallow */ });
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
      else if (tab === "apps") await enterServicesList();
      else if (tab === "activity") await enterActivityTab();
      else if (tab === "settings") await enterSettingsTab();
    } catch (e) {
      console.error("tab switch failed", e);
      toast(humanError(e), "err");
    }
  };
  for (const btn of document.querySelectorAll("[data-tab-target]")) {
    btn.addEventListener("click", () => go(btn.getAttribute("data-tab-target")));
  }
}

function wireSettingsTabEntries() {
  const wire = (id, fn) =>
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => { console.error(e); toast(humanError(e), "err"); }));
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
  wire("settings-tab-trusted-devices", () => show("view-trusted-devices"));
  wire("settings-tab-account-security", () => show("view-account-security"));
  wire("settings-tab-sessions", enterPairedSessions);
  wire("settings-tab-peer-backup", enterPeerBackup);
  wire("settings-tab-companion-dock", enterCompanionDock);
  wire("settings-tab-companion-requests", enterCompanionRequests);
  wire("settings-tab-profiles", enterProfiles);
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
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => { console.error(e); toast(humanError(e), "err"); }));
  wire("activity-open-install-progress", enterInstallProgress);
  wire("activity-open-boot-approval", enterBootApproval);
}

function wireServicesTabEntries() {
  const wire = (id, fn) =>
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => { console.error(e); toast(humanError(e), "err"); }));
  wire("services-list-open-vibe-code", enterBuildSource);
}

/**
 * The biometric/PIN-gated per-cert override. Tapping a red trust-sliver line
 * runs this: the browser has no biometric, so the gate is the tier-1 PIN
 * (lib/pinLock.js) — proves the owner is present, like Face ID on native.
 * On success it signs + persists + propagates a cert-hash-scoped
 * TrustException; calls then resume for that cert, but the red line STAYS
 * (now flagged "accepted") so the degraded state remains visible.
 */
async function runTrustOverride(certHash) {
  let session;
  try { session = getSession(); } catch { session = null; }
  if (!session?.umk) {
    toast("Unlock first to accept a certificate.", "err");
    return;
  }
  const cert = serverTrust.failingCerts().find((c) => c.certHash === certHash);
  if (!cert) return;
  if (cert.overridden) {
    toast("You already accepted this certificate on this device.");
    return;
  }
  // Gate: require the PIN when one is set; otherwise a deliberate typed
  // confirmation (the owner is already unlocked, so this is the present-owner
  // check the native biometric provides).
  const pinSet = await hasPin().catch(() => false);
  if (pinSet) {
    const pin = await inlinePrompt({
      title: "Accept this certificate?",
      message:
        "Someone may be intercepting your connection. Only accept if you understand the risk. Enter your PIN to confirm.",
      type: "password",
      okLabel: "Accept",
      validate: async (v) => ((await verifyPin(v)) ? "" : "Incorrect PIN"),
    });
    if (pin === null) return; // cancelled
  } else {
    const ok = await inlinePrompt({
      title: "Accept this certificate?",
      message:
        "Someone may be intercepting your connection. Only accept if you understand the risk. Type ACCEPT to confirm.",
      okLabel: "Accept",
      validate: (v) => (v.trim().toUpperCase() === "ACCEPT" ? "" : 'Type "ACCEPT" to confirm'),
    });
    if (ok === null) return;
  }
  let username = "";
  try { username = session.username || ""; } catch { /* none */ }
  try {
    await grantTrustException(
      { umk: session.umk, certClass: cert.certClass, certHash: cert.certHash, username },
      {},
    );
    toast("Certificate accepted on this device.");
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
}

async function boot() {
  persistDebugFlagFromUrl();
  // Maintainer-trust enforcement: install the global .com fetch guard BEFORE
  // any backend call so that, the moment a verdict flips untrusted, every
  // .com call short-circuits — no matter which lib makes it. (No verdict yet ⇒
  // trusted, so this never bricks a normal boot.) The blessing probe is exempt.
  try { installComFetchGuard(); } catch { /* best-effort */ }
  // P12 — auto-migrate legacy single-profile localStorage into the new
  // per-profile namespace. Idempotent; gated by `flagship.profiles.migrated.v2`.
  try { migrateProfilesStore(); } catch { /* swallow — best-effort */ }
  // P12 hard cut-over — sweep legacy flat keys that the per-profile store
  // has fully superseded. Safe to run every boot; idempotent (gated by
  // `flagship.profiles.legacy.cleaned.v2`). Excludes device-wide-or-pre-
  // profile slots (wizardState, username) which keep their legacy mirror.
  try { cleanupProfilesLegacyKeys(); } catch { /* swallow — best-effort */ }
  initBootstrapView();
  initUnlockView();
  initPinViews();
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
  initServicesListView();
  initServiceDetailView();
  initInviteIssueView();
  initInviteManageView();
  initPairedSessionsView();
  initPeerBackupView();
  initCompanionDockView();
  initCompanionRequestsView();
  initTrustedDevicesView();
  initAccountSecurityView();
  initAddDeviceView();
  initJoinView();
  initVibeCodeView();
  initBuildSourceView();
  initBuildKeyView();
  initBuildGitView();
  initBuildMcpView();
  initBuildJournalView();
  initServiceEnvView();
  initVibeCodeChatView();
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
  initActivityView();
  initAccountAuditView();
  initBootApprovalView();
  initPendingServerView();
  initProfilesView();
  // When the user flips profiles, re-render the surfaces that read per-
  // profile state so the new active cloud's view is what they see.
  setProfileSwitchHandler(() => {
    try { renderProfiles(); } catch { /* swallow */ }
    // Home + Settings render lazily on enter — the profile switch only needs
    // to re-render the Profiles view itself; entering home/settings later
    // picks up the new active cloud automatically through profilesStore.
  });

  // Home-tab → in-tab nav (the legacy home-grid is gone; what remains
  // are the two session-row buttons "pair-with-server" + "open-pod-pair").
  const wire = (id, fn) =>
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => { console.error(e); toast(humanError(e), "err"); }));
  wire("open-pod-pair", enterPodPair);

  // Tag every sub-view with its parent tab — `setViewTab` requires
  // the view to be registered first, which init*View() above guarantees.
  for (const [id, tab] of Object.entries(SUB_VIEW_TABS)) setViewTab(id, tab);

  wireTabBar();
  wireSettingsTabEntries();
  wireActivityEntries();
  wireServicesTabEntries();

  // Global operations sliver (WhatsApp-style active-operations bar). It reads
  // lib/activeOperations.js (fed by Home's pod sync + the vibe-code build
  // lifecycle) and pins a teal strip the shell slides down to reveal. Hide it
  // on the pre-paired / locked surfaces so operation names never slide in over
  // the bootstrap/unlock/PIN screens — same intent as iOS's hide-under-lock.
  setOperationsBarUnlockedResolver(() => {
    const v = currentViewId();
    return (
      v !== "view-bootstrap" &&
      v !== "view-unlock" &&
      v !== "view-pin-unlock" &&
      v !== "view-pin-set" &&
      v !== "view-wizard" &&
      v != null
    );
  });
  initOperationsBar();
  // Re-evaluate the bar's visibility on every navigation (the lock surfaces
  // hide it; unlocking back into the app reveals any running operations).
  document.addEventListener("flagship:view-shown", () => refreshOperationsBar());

  // ── Maintainer-trust enforcement (docs/maintainer-trust-enforcement.md) ──
  // The persistent ALARMING-RED top sliver: one non-dismissible line per
  // failing cert while the control-server blessing is broken. It pins ABOVE
  // the teal ops bar and pushes the whole shell down. Tapping a line runs the
  // biometric/PIN-gated per-cert override.
  initTrustSliver();
  setTrustSliverTapHandler((certHash) => runTrustOverride(certHash));
  // Fetch + verify the control-server blessing (CLIENT clock; a network error
  // is NOT a verdict), then re-apply any accepted exceptions so one acceptance
  // per cert holds fleet-wide. Best-effort + non-blocking — boot never waits
  // on it, and a .com outage can't brick the app.
  void (async () => {
    let username = "";
    try { username = getSession().username || ""; } catch { /* locked */ }
    try { await refreshServerTrust(); } catch { /* no verdict on error */ }
    try { await loadAndApplyExceptions(username); } catch { /* best-effort */ }
  })();

  // Phase 3b — cross-device QR pairing: a /join?sid=&pk= deep-link routes
  // straight into the add-profile pairing receiver, BEFORE the normal
  // unlock/first-run dispatch. It adds a NEW profile (it never clobbers
  // an existing one), so it runs whether or not this browser already
  // holds an identity.
  const joinLink = joinLinkFromLocation();
  if (joinLink) {
    setSubtitle("join");
    enterJoin(joinLink);
    return;
  }

  // P14 — companion receiver flow. `?companion=<base64url JSON>` means
  // a regular browser is being docked as a read-only companion. We
  // redeem the ticket against the owner's pod, mint a new profile slot
  // flagged kind:"companion", and continue normal boot under that
  // profile. UMK seed + IRK private key are NOT present on this device
  // — that's the marker for "this profile can't sign".
  const companionPayload = companionPayloadFromLocation();
  if (companionPayload) {
    setSubtitle("docking");
    const result = await redeemCompanionAndPersist(companionPayload);
    if (result.error) {
      toast(result.error, "err");
      // Fall through to normal boot — the URL has not been stripped
      // (we only strip on success), but the user can still navigate
      // around the existing webapp if they had a prior profile.
    } else {
      toast(`docked as companion (${result.label ?? "no label"})`);
      // Companion sessions skip the unlock view entirely — there's no
      // UMK to unwrap. Render the home tab so they land somewhere
      // meaningful.
      setSubtitle("companion");
      show("view-home");
      await enterHome();
      return;
    }
  }

  if (await hasWrappedUmk()) {
    setSubtitle("locked");
    // Prefer the PIN screen when a PIN is set; the passphrase remains
    // reachable from there via "Unlock with passphrase instead".
    let pinSet = false;
    try {
      pinSet = await hasPin();
    } catch {
      pinSet = false;
    }
    show(pinSet ? "view-pin-unlock" : "view-unlock");
  } else {
    setSubtitle("first run");
    show("view-bootstrap");
  }
}

boot().catch((e) => {
  console.error("boot failed", e);
  setSubtitle("startup failed");
  toast(humanError(e), "err");
});
