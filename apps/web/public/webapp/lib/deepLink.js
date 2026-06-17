// Routes the user to the right view after a fresh unlock/bootstrap.
//
// Honours a `?view=<alias>&serverId=<sid>` query string set by:
//   1. service-worker.js notificationclick handler (#29 — Web Push
//      deep-link).
//   2. external links into the webapp (marketing site, mobile app).
//
// Lives outside views/* so it can pull every view's enter*() without
// creating a circular import through app.js. Falls through to enterHome()
// when there's no recognised alias.

import { parseViewQuery, clearViewQuery } from "./router.js";
import { humanError } from "./humanError.js";
import { toast } from "./toast.js";

export async function dispatchInitialView() {
  const q = parseViewQuery();
  clearViewQuery();
  if (!q?.view) {
    const { enterHome } = await import("../views/home.js");
    return enterHome();
  }
  try {
    if (q.view === "view-home") {
      const { enterHome } = await import("../views/home.js");
      return enterHome();
    }
    if (q.view === "view-services-list" || q.view === "view-apps-list") {
      const { enterServicesList } = await import("../views/services-list.js");
      return enterServicesList();
    }
    if (q.view === "view-install-progress") {
      const { enterInstallProgress } = await import("../views/install-progress.js");
      return enterInstallProgress();
    }
    if (q.view === "view-recovery") {
      const { enterRecovery } = await import("../views/recovery.js");
      return enterRecovery();
    }
    if (q.view === "view-server-detail") {
      const { enterServerDetail } = await import("../views/server-detail.js");
      return enterServerDetail();
    }
    if (q.view === "view-pod-pair") {
      const { enterPodPair } = await import("../views/pod-pair.js");
      return enterPodPair();
    }
    if (q.view === "view-create-server") {
      const { enterCreateServer } = await import("../views/create-server.js");
      return enterCreateServer();
    }
    if (q.view === "view-vibecode-chat" || q.view === "view-vibe-code-chat") {
      // W10 — a `vibecode-needs-you` push (the AI paused on a tool_use) cold-
      // starts the app at this session's chat so the owner can answer it.
      // iOS consumes the same deep-link via `.vibeCodeChat(sessionId:)`. With
      // no session id there's nothing to open — fall through to Home.
      if (q.sessionId) {
        const { enterVibeCodeChat } = await import("../views/vibecode-chat.js");
        return enterVibeCodeChat(q.sessionId);
      }
    }
    if (q.view === "view-activity") {
      const { show } = await import("./router.js");
      show("view-activity");
      return;
    }
    if (q.view === "view-settings" || q.view === "view-settings-tab") {
      const { show } = await import("./router.js");
      show("view-settings-tab");
      return;
    }
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
  const { enterHome } = await import("../views/home.js");
  return enterHome();
}
