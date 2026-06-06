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
import { transferLinkFromLocation } from "./serverTransfer.js";

/** Strip the transfer `o=` param from the URL bar after we've ingested it, so
 *  a reload / re-dispatch can't re-open the claim sheet. Best-effort. */
function clearTransferQuery() {
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has("o")) {
      u.searchParams.delete("o");
      window.history.replaceState({}, "", u.toString());
    }
  } catch { /* old browsers — ignore */ }
}

export async function dispatchInitialView() {
  // Take-over deep link: a `/transfer?o=<b64url>` universal link (a phone
  // Camera opening the offer in the browser, or an in-app deep link) routes
  // straight into the acquirer claim view. The offer is verified (signature +
  // expiry) inside the claim view BEFORE any severe confirm / claim. Runs
  // before the normal ?view dispatch; only fires when this load carried a
  // /transfer link (else null → fall through).
  try {
    const offer = transferLinkFromLocation();
    if (offer) {
      clearTransferQuery();
      const { enterTransferClaim } = await import("../views/transfer-claim.js");
      await enterTransferClaim(offer).catch((e) => {
        // A user-cancelled claim dialog is not an error.
        if (e?.code !== "cancelled") throw e;
      });
      return;
    }
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }

  // Service-access friend deep-link: if this load was a /invite#<secret>
  // landing that detoured through bootstrap/unlock/PIN/recovery to get the
  // friend's key, resume the redeem now instead of the normal dispatch
  // (docs/service-access-gating.md). Best-effort + non-fatal.
  try {
    const { hasPendingInviteRedeem, resumePendingInviteRedeem } = await import(
      "../views/invite-redeem.js"
    );
    if (hasPendingInviteRedeem()) {
      await resumePendingInviteRedeem();
      return;
    }
  } catch {
    /* invite-redeem not loaded / no pending redeem — fall through */
  }

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
    if (q.view === "view-marketplace") {
      const { enterMarketplace } = await import("../views/marketplace.js");
      return enterMarketplace();
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
