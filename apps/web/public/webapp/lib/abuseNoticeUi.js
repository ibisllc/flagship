// The abuse notices' screens (docs/abuse-handling.md §4-§5): a banner per notice on Home (admin devices only) with
// "I've done this" and "Appeal", and the full-screen "This account was suspended" (every device). The suspended
// screen can be put aside for the session ("Continue to my data") so backups and the rest stay reachable; a banner
// then stays above the header with "Details".

import {
  ABUSE_COPY,
  abuseState,
  appealHref,
  markNoticeDone,
  noticeBannerModels,
  onAbuseStateChange,
  refreshAbuseNotices,
  showsNoticeBanners,
  suspendedModel,
} from "./abuseNotices.js";
import { dismissOverlays } from "./lockSweep.js";
import { inlinePrompt } from "./modal.js";
import { getSession } from "./state.js";
import { toast } from "./toast.js";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const HOME_HOST_ID = "home-abuse-notices";
let screenEl = null;
let bannerEl = null;
let putAside = false;
let shownFor = null;

function sessionName() {
  try {
    return getSession().username ?? null;
  } catch {
    return null;
  }
}

/* ---------- Home banners ---------- */

/** Paint the notice banners above the server list (Home), or remove them. */
export function renderAbuseNoticeBanners(doc = typeof document === "undefined" ? null : document) {
  if (!doc) return;
  const list = doc.getElementById("servers-list");
  let host = doc.getElementById(HOME_HOST_ID);
  let isAdmin = false;
  try { isAdmin = showsNoticeBanners(); } catch { isAdmin = false; }
  const models = noticeBannerModels(abuseState().notices, { isAdmin });
  if (!list || models.length === 0) {
    host?.remove();
    return;
  }
  if (!host) {
    host = doc.createElement("div");
    host.id = HOME_HOST_ID;
    list.parentNode?.insertBefore(host, list);
  }
  const appeal = appealHref(sessionName());
  host.innerHTML = models
    .map(
      (m) => `
    <div class="fs-announcement fs-announcement--danger abuse-notice" role="alert" data-testid="abuse-notice" data-notice-id="${esc(m.id)}">
      <div class="fs-announcement-head">
        <span class="fs-announcement-text">
          <span class="fs-announcement-title">${esc(m.title)}</span>
          <span class="fs-announcement-message">${esc(m.about)}</span>
          <span class="fs-announcement-message">${esc(m.reason)}</span>
          <span class="fs-announcement-message">${esc(m.action)}</span>
          <span class="fs-announcement-message" data-testid="abuse-notice-deadline"><strong>${esc(m.deadline)}</strong></span>
          ${m.detail ? `<span class="fs-announcement-message abuse-notice-detail">${esc(m.detail)}</span>` : ""}
          <span class="fs-announcement-message">${esc(m.warning)}</span>
          ${m.doneLine ? `<span class="fs-announcement-message" data-testid="abuse-notice-done-line">${esc(m.doneLine)}</span>` : ""}
        </span>
      </div>
      <div class="notice-banner-actions">
        ${m.canMarkDone ? `<button type="button" class="fs-announcement-cta" data-abuse-done="${esc(m.id)}" data-testid="abuse-notice-mark-done">${esc(ABUSE_COPY.done)}</button>` : ""}
        <a class="secondary button-link" href="${esc(appeal)}" data-testid="abuse-notice-appeal">${esc(ABUSE_COPY.appeal)}</a>
      </div>
    </div>`,
    )
    .join("");
  for (const b of host.querySelectorAll("[data-abuse-done]")) {
    b.addEventListener("click", () => void askDone(b.getAttribute("data-abuse-done")));
  }
}

async function askDone(noticeId) {
  const note = await inlinePrompt({ title: ABUSE_COPY.doneTitle, placeholder: ABUSE_COPY.notePlaceholder, okLabel: ABUSE_COPY.send });
  if (note === null || note === undefined) return;
  const r = await markNoticeDone(noticeId, note);
  if (!r.ok) toast(r.message);
}

/* ---------- the suspended screen ---------- */

function ensureScreen() {
  if (screenEl || typeof document === "undefined") return screenEl;
  screenEl = document.createElement("div");
  screenEl.id = "account-suspended";
  screenEl.className = "update-lock account-suspended hidden";
  screenEl.setAttribute("role", "alertdialog");
  screenEl.setAttribute("aria-modal", "true");
  screenEl.setAttribute("aria-labelledby", "account-suspended-title");
  document.body.appendChild(screenEl);
  return screenEl;
}

function ensureBanner() {
  if (bannerEl || typeof document === "undefined") return bannerEl;
  bannerEl = document.createElement("div");
  bannerEl.id = "account-suspended-banner";
  bannerEl.className = "notice-banner notice-security hidden";
  bannerEl.setAttribute("role", "status");
  const header = document.querySelector("body > header");
  if (header) document.body.insertBefore(bannerEl, header);
  else document.body.insertBefore(bannerEl, document.body.firstChild);
  return bannerEl;
}

function paintScreen(m) {
  const el = ensureScreen();
  if (!el) return;
  el.innerHTML = `
    <div class="update-lock-card" data-testid="account-suspended">
      <h2 id="account-suspended-title" class="update-lock-title">${esc(m.title)}</h2>
      <p class="update-lock-body" data-testid="account-suspended-reason"><strong>${esc(m.reason)}</strong></p>
      <p class="update-lock-body" data-testid="account-suspended-detail">${esc(m.detail)}</p>
      <p class="update-lock-body">${esc(m.offline)}</p>
      <p class="update-lock-body" data-testid="account-suspended-data">${esc(m.data)}</p>
      <p class="update-lock-meta">${esc(m.appealText)}</p>
      <div class="update-lock-actions">
        <a class="button-link full-width" href="${esc(m.appealHref)}" data-testid="account-suspended-appeal">${esc(m.appeal)}</a>
        <button type="button" class="ghost full-width" data-testid="account-suspended-continue">${esc(m.continueLabel)}</button>
      </div>
    </div>`;
  el.querySelector('[data-testid="account-suspended-continue"]')?.addEventListener("click", () => {
    putAside = true;
    sync();
  });
}

function paintBanner() {
  const el = ensureBanner();
  if (!el) return;
  el.className = "notice-banner notice-security";
  el.dataset.testid = "account-suspended-banner";
  el.innerHTML = `
    <p class="notice-banner-text">${esc(ABUSE_COPY.suspendedBanner)}</p>
    <div class="notice-banner-actions"><button type="button" class="secondary" data-testid="account-suspended-details">${esc(ABUSE_COPY.details)}</button></div>`;
  el.querySelector("button")?.addEventListener("click", () => {
    putAside = false;
    sync();
  });
}

function sync() {
  const st = abuseState();
  const m = suspendedModel(st.suspension, st.username ?? sessionName());
  renderAbuseNoticeBanners();
  if (!m) {
    putAside = false;
    shownFor = null;
    screenEl?.classList.add("hidden");
    bannerEl?.classList.add("hidden");
    return;
  }
  const key = `${st.username}|${st.suspension.suspendedAt}`;
  if (shownFor !== key) {
    shownFor = key;
    putAside = false;
  }
  if (putAside) {
    screenEl?.classList.add("hidden");
    paintBanner();
    return;
  }
  bannerEl?.classList.add("hidden");
  dismissOverlays();
  paintScreen(m);
  screenEl?.classList.remove("hidden");
}

/** Mount the screens, read the notices now, on focus and when the push says so. Idempotent. */
export function initAbuseNoticeUi() {
  if (typeof document === "undefined" || initAbuseNoticeUi._done) return;
  initAbuseNoticeUi._done = true;
  onAbuseStateChange(() => sync());
  const refresh = () => void refreshAbuseNotices();
  refresh();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  navigator.serviceWorker?.addEventListener?.("message", (e) => {
    if (e?.data?.kind === "abuse-notice" || e?.data?.category === "abuse-notice") refresh();
  });
}

/** Test seam. */
export function _resetAbuseNoticeUiForTests() {
  screenEl?.remove();
  bannerEl?.remove();
  screenEl = null;
  bannerEl = null;
  putAside = false;
  shownFor = null;
  initAbuseNoticeUi._done = false;
}
