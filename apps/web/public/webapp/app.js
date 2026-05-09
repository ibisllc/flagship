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

  // Home → screens nav
  $("open-pod-pair")?.addEventListener("click", () => enterPodPair().catch((e) => toast(String(e), "err")));
  $("open-server-detail")?.addEventListener("click", () => enterServerDetail().catch((e) => toast(String(e), "err")));
  $("open-apps-list")?.addEventListener("click", () => enterAppsList().catch((e) => toast(String(e), "err")));
  $("open-paired-sessions")?.addEventListener("click", () => enterPairedSessions().catch((e) => toast(String(e), "err")));
  $("open-tier-status")?.addEventListener("click", () => enterTierStatus().catch((e) => toast(String(e), "err")));

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
