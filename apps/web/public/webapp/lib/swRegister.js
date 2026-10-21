// Service-worker registration + update-available toast.
//
// The SW no longer auto-skipWaiting (see service-worker.js v12 —
// doing so on every install means one bad asset can evict a
// live session). Instead the page watches for a waiting SW and
// shows a non-modal "Update available — tap to refresh" toast.
// The user can defer indefinitely; nothing breaks if they
// ignore it (the old SW keeps serving them just fine).
import { tr } from "./i18n.js";
if ("serviceWorker" in navigator) {
  (async () => {
    const reg = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
    const onWaiting = (worker) => {
      if (!worker) return;
      const toastEl = document.getElementById("toast");
      if (!toastEl) return;
      toastEl.textContent = tr("Update available — tap to refresh");
      toastEl.classList.remove("hidden", "err");
      const accept = () => {
        toastEl.removeEventListener("click", accept);
        try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (_e) {}
      };
      toastEl.addEventListener("click", accept);
    };
    // Case 1: a waiting SW was already there when the page loaded.
    if (reg.waiting && navigator.serviceWorker.controller) {
      onWaiting(reg.waiting);
    }
    // Case 2: a new SW shows up while the page is open.
    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          onWaiting(installing);
        }
      });
    });
    // After the user accepts, the new SW activates and takes
    // control — reload so it serves the page from the new shell.
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
    // #29 — deep-link push notifications. SW posts { type: "DEEP_LINK",
    // target: "/?view=..." } when a notification click hits an already-
    // open tab. We don't have a single SPA router for the whole webapp;
    // honor it by setting location.href, which the existing
    // ?view= query handler in app.js picks up at boot.
    navigator.serviceWorker.addEventListener("message", (ev) => {
      const data = ev.data;
      if (!data || data.type !== "DEEP_LINK" || typeof data.target !== "string") return;
      try {
        const url = new URL(data.target, window.location.origin);
        if (url.origin !== window.location.origin) return; // never honor cross-origin
        window.location.href = url.pathname + url.search + url.hash;
      } catch (_e) { /* malformed deep-link */ }
    });
  })().catch(() => { /* SW registration is best-effort */ });
}
