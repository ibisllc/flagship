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
import { setSubtitle, show, $ } from "./lib/router.js";
import { toast } from "./lib/toast.js";
import { initBootstrapView } from "./views/bootstrap.js";
import { initUnlockView } from "./views/unlock.js";
import { initHomeView } from "./views/home.js";
import { initPairView, startPairing } from "./views/pair.js";
import { initSettingsView, renderProviders } from "./views/settings.js";
import { initPodPairView, enterPodPair } from "./views/pod-pair.js";
import { initServerDetailView, enterServerDetail } from "./views/server-detail.js";
import { initAppsListView, enterAppsList } from "./views/apps-list.js";
import { initAppDetailView } from "./views/app-detail.js";
import { initPairedSessionsView, enterPairedSessions } from "./views/paired-sessions.js";
import { initTierStatusView, enterTierStatus } from "./views/tier-status.js";
import { initMarketplaceView, enterMarketplace } from "./views/marketplace.js";
import { initVibeCodeView, enterVibeCode } from "./views/vibe-code.js";
import { initUnlockApprovalsView, enterUnlockApprovals } from "./views/unlock-approvals.js";
import { initRecoveryView, enterRecovery } from "./views/recovery.js";

async function boot() {
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
  initPairedSessionsView();
  initTierStatusView();
  initMarketplaceView();
  initVibeCodeView();
  initUnlockApprovalsView();
  initRecoveryView();

  // Home → screens nav
  const wire = (id, fn) =>
    $(id)?.addEventListener("click", () => Promise.resolve(fn()).catch((e) => toast(String(e), "err")));
  wire("open-pod-pair", enterPodPair);
  wire("open-server-detail", enterServerDetail);
  wire("open-apps-list", enterAppsList);
  wire("open-marketplace", enterMarketplace);
  wire("open-vibe-code", enterVibeCode);
  wire("open-unlock-approvals", enterUnlockApprovals);
  wire("open-paired-sessions", enterPairedSessions);
  wire("open-tier-status", enterTierStatus);
  wire("open-recovery", enterRecovery);

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
