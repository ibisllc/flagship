// The security notice's screens (docs/security-notices.md): a dismissible
// banner above the header for a maintenance or update notice, and the
// full-screen "Update required" lock for a verified update-required notice.
//
// The lock is an overlay, not a view: it sits above whichever view is on
// screen, makes the rest of the page inert, and first runs the lock sweep so
// no menu, dialog or sheet stays open and operable behind it. It never
// deletes anything. It keeps three things reachable: the update itself, the
// account key backup, and Sign out. The network side of the lock (nothing
// leaves the page but the shell and reads from `.com`) is lib/updateLock.js,
// enforced by the global fetch guard in lib/comFetch.js.

import {
  bannerVisible,
  dismissNotice,
  formatNoticeDate,
  loadStore,
  securityNoticeText,
  securityNotices,
} from "./securityNotice.js";
import { isUpdateLocked } from "./updateLock.js";
import { dismissOverlays, isLockView } from "./lockSweep.js";
import { currentViewId } from "./router.js";
import { getSession } from "./state.js";
import { toast } from "./toast.js";

import { tr } from "./i18n.js";
export const NOTICE_COPY = Object.freeze({
  bannerDismiss: "Dismiss",
  updateButton: tr("Reload to update"),
  updating: "Updating",
  updateFailed: tr("Couldn't update yet. Check your connection and try again."),
  lockKicker: tr("Security update"),
  lockTitle: tr("Update required"),
  lockReassure:
    tr("Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update."),
  whyLabel: "Why",
  backup: tr("Back up my account key"),
  unlockFirst: tr("Unlock to back up my account key"),
  signOut: tr("Sign out"),
  signedBy: tr("Signed by the Flagship maintainers"),
  advisory: (id) => `Advisory ${id}`,
});

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let bannerEl = null;
let lockEl = null;
let peek = false;
let sessionDismissed = false;
let wasShown = false;

/* ---------- banner ---------- */

function ensureBanner() {
  if (bannerEl) return bannerEl;
  if (typeof document === "undefined") return null;
  bannerEl = document.createElement("div");
  bannerEl.id = "notice-banner";
  bannerEl.className = "notice-banner hidden";
  bannerEl.setAttribute("role", "status");
  const header = document.querySelector("body > header");
  if (header) document.body.insertBefore(bannerEl, header);
  else document.body.insertBefore(bannerEl, document.body.firstChild);
  return bannerEl;
}

/** The banner's contents for an outcome: pure, so a test can read the exact strings. */
export function bannerModel(outcome, formatDate = formatNoticeDate) {
  if (outcome.action !== "banner") return null;
  const n = outcome.notice;
  return {
    style: outcome.style,
    text: securityNoticeText(n, formatDate),
    update: outcome.style === "update",
    dismiss: NOTICE_COPY.bannerDismiss,
    action: outcome.style === "update" ? NOTICE_COPY.updateButton : null,
  };
}

function renderBanner(outcome) {
  const el = ensureBanner();
  if (!el) return;
  const model = bannerModel(outcome);
  if (!model || !bannerVisible(outcome, loadStore(), { sessionDismissed })) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.className = `notice-banner notice-${model.style}`;
  el.dataset.testid = "notice-banner";
  el.innerHTML = `
    <p class="notice-banner-text" data-testid="notice-banner-text">${esc(model.text)}</p>
    <div class="notice-banner-actions">
      ${model.action ? `<button type="button" class="notice-banner-update" data-testid="notice-banner-update">${esc(model.action)}</button>` : ""}
      <button type="button" class="secondary notice-banner-dismiss" data-testid="notice-banner-dismiss">${esc(model.dismiss)}</button>
    </div>`;
  el.querySelector(".notice-banner-dismiss")?.addEventListener("click", () => {
    if (outcome.notice.kind === "update-required") sessionDismissed = true;
    else dismissNotice(outcome.notice);
    el.classList.add("hidden");
    el.innerHTML = "";
  });
  el.querySelector(".notice-banner-update")?.addEventListener("click", (ev) => void applyWebUpdate(ev.currentTarget));
}

/* ---------- the lock ---------- */

/** The lock screen's contents for a notice: pure, so a test can read the exact strings. */
export function lockModel(notice, { unlocked = true, formatDate = formatNoticeDate } = {}) {
  return {
    kicker: NOTICE_COPY.lockKicker,
    title: NOTICE_COPY.lockTitle,
    body: securityNoticeText(notice, formatDate),
    why: notice.reason ? `${NOTICE_COPY.whyLabel}: ${notice.reason}` : "",
    reassure: NOTICE_COPY.lockReassure,
    update: NOTICE_COPY.updateButton,
    backup: unlocked ? NOTICE_COPY.backup : NOTICE_COPY.unlockFirst,
    signOut: NOTICE_COPY.signOut,
    meta: `${NOTICE_COPY.advisory(notice.advisoryId)} · ${NOTICE_COPY.signedBy}`,
  };
}

function ensureLock() {
  if (lockEl) return lockEl;
  if (typeof document === "undefined") return null;
  lockEl = document.createElement("div");
  lockEl.id = "update-lock";
  lockEl.className = "update-lock hidden";
  lockEl.setAttribute("role", "alertdialog");
  lockEl.setAttribute("aria-modal", "true");
  lockEl.setAttribute("aria-labelledby", "update-lock-title");
  lockEl.setAttribute("aria-describedby", "update-lock-body");
  document.body.appendChild(lockEl);
  return lockEl;
}

function isUnlockedSession() {
  try {
    return !!getSession().umk;
  } catch {
    return false;
  }
}

function paintLock(notice) {
  const el = ensureLock();
  if (!el) return;
  const m = lockModel(notice, { unlocked: isUnlockedSession() });
  el.innerHTML = `
    <div class="update-lock-card" data-testid="update-lock">
      <p class="update-lock-kicker">${esc(m.kicker)}</p>
      <h2 id="update-lock-title" class="update-lock-title">${esc(m.title)}</h2>
      <p id="update-lock-body" class="update-lock-body" data-testid="update-lock-body">${esc(m.body)}</p>
      ${m.why ? `<p class="update-lock-why" data-testid="update-lock-why">${esc(m.why)}</p>` : ""}
      <p class="update-lock-reassure">${esc(m.reassure)}</p>
      <div class="update-lock-actions">
        <button type="button" id="update-lock-update" class="full-width" data-testid="update-lock-update">${esc(m.update)}</button>
        <button type="button" id="update-lock-backup" class="secondary full-width" data-testid="update-lock-backup">${esc(m.backup)}</button>
        <button type="button" id="update-lock-signout" class="secondary full-width" data-testid="update-lock-signout">${esc(m.signOut)}</button>
      </div>
      <p class="update-lock-meta">${esc(m.meta)}</p>
    </div>`;
  el.querySelector("#update-lock-update")?.addEventListener("click", (ev) => void applyWebUpdate(ev.currentTarget));
  el.querySelector("#update-lock-backup")?.addEventListener("click", () => void backupAccountKey());
  el.querySelector("#update-lock-signout")?.addEventListener("click", () => {
    document.getElementById("settings-signout")?.click();
  });
}

const KEEP_LIVE = new Set(["update-lock", "account-gone", "toast", "flagship-modal-host"]);

function setPageInert(on) {
  for (const child of Array.from(document.body.children)) {
    if (KEEP_LIVE.has(child.id) || child.tagName === "SCRIPT") continue;
    if (on) child.setAttribute("inert", "");
    else child.removeAttribute("inert");
  }
}

function lockShouldShow() {
  if (!isUpdateLocked()) return false;
  if (peek && isLockView(currentViewId())) return false;
  return true;
}

function syncLock(outcome) {
  const el = ensureLock();
  if (!el) return;
  const show = lockShouldShow() && outcome.action === "lock";
  if (show && !wasShown) {
    // Nothing of a menu, dialog or sheet may stay open and operable behind the lock.
    dismissOverlays();
    paintLock(outcome.notice);
    el.classList.remove("hidden");
    setPageInert(true);
    wasShown = true;
    document.body.classList.add("update-locked");
    queueMicrotask(() => el.querySelector("#update-lock-update")?.focus({ preventScroll: true }));
  } else if (show) {
    paintLock(outcome.notice);
  } else if (!show && wasShown) {
    el.classList.add("hidden");
    el.innerHTML = "";
    setPageInert(false);
    wasShown = false;
    document.body.classList.remove("update-locked");
  }
}

async function backupAccountKey() {
  if (!isUnlockedSession()) {
    // The key lives behind the unlock screen: step aside to it, and come back after.
    peek = true;
    syncLock(securityNotices.outcome);
    return;
  }
  try {
    const { runKeyfileExportCeremony } = await import("../views/recovery.js");
    await runKeyfileExportCeremony();
  } catch (e) {
    console.error("key backup failed", e);
    toast(tr("Couldn't start the backup. Try again."), "err");
  }
}

/* ---------- the web update ---------- */

function waitForWaiting(reg, ms) {
  return new Promise((resolve) => {
    if (reg.waiting) return resolve(reg.waiting);
    const done = (w) => {
      clearTimeout(t);
      resolve(w);
    };
    const t = setTimeout(() => resolve(reg.waiting ?? null), ms);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener("statechange", () => {
        if (w.state === "installed") done(reg.waiting ?? w);
      });
    });
  });
}

/**
 * Get the newest shell: ask the service worker to update and activate, which
 * reloads the page (lib/swRegister.js); if there is no newer worker, drop the
 * shell cache and reload from the network. Never deletes account data.
 */
export async function applyWebUpdate(button) {
  const label = button?.textContent ?? "";
  if (button) {
    button.disabled = true;
    button.textContent = NOTICE_COPY.updating;
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg) {
      await reg.update().catch(() => {});
      const waiting = await waitForWaiting(reg, 8000);
      if (waiting) {
        waiting.postMessage({ type: "SKIP_WAITING" });
        return;
      }
    }
    for (const key of await caches.keys()) {
      if (key.startsWith("flagship-webapp-shell-")) await caches.delete(key);
    }
    await reg?.unregister();
    location.reload();
  } catch {
    toast(NOTICE_COPY.updateFailed, "err");
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

/* ---------- wiring ---------- */

function render(outcome) {
  renderBanner(outcome);
  syncLock(outcome);
}

/** Mount the banner and the lock and keep them in step with the notice state. Idempotent. */
export function initNoticeUi() {
  if (typeof document === "undefined" || initNoticeUi._done) return;
  initNoticeUi._done = true;
  securityNotices.subscribe((outcome) => render(outcome));
  document.addEventListener("flagship:view-shown", (ev) => {
    const id = ev?.detail?.id;
    if (peek && id && !isLockView(id)) peek = false;
    render(securityNotices.outcome);
  });
  render(securityNotices.outcome);
}

/** Test seam. */
export function _resetNoticeUiForTests() {
  bannerEl?.remove();
  lockEl?.remove();
  bannerEl = null;
  lockEl = null;
  peek = false;
  sessionDismissed = false;
  wasShown = false;
  initNoticeUi._done = false;
}
