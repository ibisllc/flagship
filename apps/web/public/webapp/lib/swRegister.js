// Service-worker registration + update-available toast.
//
// The SW no longer auto-skipWaiting (see service-worker.js v12 —
// doing so on every install means one bad asset can evict a
// live session). Instead the page watches for a waiting SW and
// shows a non-modal "Update available — tap to refresh" toast.
// The user can defer indefinitely; nothing breaks if they
// ignore it (the old SW keeps serving them just fine).
//
// Before it offers the update, the page checks the new shell's release signature
// (lib/shellTrust.js, docs/webapp-key-custody.md item 5). While signatures are required an
// unsigned shell is never activated from here, and the page says so.
import { tr } from "./i18n.js";
import { SHELL_SIGNATURE_REQUIRED, checkDeployedShell } from "./shellTrust.js";

export const SHELL_UNSIGNED = tr("This version of the webapp isn't signed by Flagship.");

/** The waiting worker's SHELL_VERSION, or null. */
function workerVersion(worker) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 3000);
    ch.port1.onmessage = (ev) => {
      clearTimeout(t);
      resolve(typeof ev.data?.shellVersion === "string" ? ev.data.shellVersion : null);
    };
    try {
      worker.postMessage({ type: "SHELL_VERSION" }, [ch.port2]);
    } catch {
      clearTimeout(t);
      resolve(null);
    }
  });
}

/** Whether to offer this waiting shell: `{ offer, signed }`. */
export async function vetUpdate(worker, { required = SHELL_SIGNATURE_REQUIRED, check = checkDeployedShell, version = workerVersion } = {}) {
  const v = await version(worker);
  const status = await check({ expectVersion: v });
  return { offer: status.signed || !required, signed: status.signed, reason: status.reason ?? null };
}

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  (async () => {
    const reg = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
    const onWaiting = async (worker) => {
      if (!worker) return;
      const toastEl = document.getElementById("toast");
      if (!toastEl) return;
      const vet = await vetUpdate(worker).catch(() => ({ offer: !SHELL_SIGNATURE_REQUIRED, signed: false }));
      if (!vet.offer) {
        toastEl.textContent = SHELL_UNSIGNED;
        toastEl.classList.remove("hidden");
        toastEl.classList.add("err");
        return;
      }
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
      // A device-removed push (docs/revocation-ui.md): ask `.com`; only its answer erases anything.
      // An account-key-rotated push: fetch and check this browser's new key (lib/accountKeyUpkeep.js).
      if (data && data.type === "ACCOUNT_KEY_CHECK") {
        void import("./accountKeyUpkeep.js").then((m) => m.onAccountKeyRotatedPush()).catch(() => {});
        return;
      }
      if (data && data.type === "DEVICE_REMOVED_CHECK") {
        void import("./accountGoneUi.js").then((m) => m.checkStillOnAccount()).catch(() => {});
        return;
      }
      if (!data || data.type !== "DEEP_LINK" || typeof data.target !== "string") return;
      try {
        const url = new URL(data.target, window.location.origin);
        if (url.origin !== window.location.origin) return; // never honor cross-origin
        window.location.href = url.pathname + url.search + url.hash;
      } catch (_e) { /* malformed deep-link */ }
    });
  })().catch(() => { /* SW registration is best-effort */ });
}
