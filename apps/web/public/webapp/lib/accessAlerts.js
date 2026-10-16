// "<App> wants to reach <host>" alerts (docs/ai-privacy-and-staging.md §3a).
//
// The box records a request when its egress gateway denies an app a host no
// rule matched, and for the hosts a manifest declares at install. The Web Push
// it sends is generic (category `generic`, `app-access` from older boxes); the
// details come from the box over the paired session: GET
// /api/screens/access-requests, on load, on focus, after a notification click
// and on the screens socket's `access-request` event. Each request gets a sheet
// with Allow / Deny / Not now; an answer edits the list with withRule, signs it
// and sends it, then confirms with Close and View access list. Companion
// sessions never get the sheet (read-only), and nobody does with the Push
// notifications switch off (lib/pushSetting.js): the requests still wait on
// each app's page.
//
// A suggested list (a draft, `kind: "draft"`, listed first) gets its own sheet:
// "<App> suggests an access list" with its hosts, Review (opens the app's
// access-list editor with the draft) and Not now.

import { boxClient, getPodBaseUrl, getSessionToken, makeCurrentPod } from "./api.js";
import { loadAccountPods, sessionServers } from "./appPlacement.js";
import { getSession } from "./state.js";
import { sensitiveSigner } from "./adminRoot.js";
import { isCompanionProfile } from "./companionGuard.js";
import { canSignAdminOrders } from "./addServerGate.js";
import { pushNotificationsEnabled } from "./pushSetting.js";
import { toast } from "./toast.js";
import { humanError } from "./humanError.js";
import { escapeHtml } from "./util.js";
import {
  ACCESS_ALLOW,
  ACCESS_CLOSE,
  ACCESS_DENY,
  ACCESS_DRAFT_REVIEW,
  ACCESS_NOT_NOW,
  ACCESS_VIEW_LIST,
  accessAnsweredText,
  accessDraftAlertTitle,
  accessErrorMessage,
  accessRequestNote,
  accessRequestTitle,
  answerAccessRequest,
  fetchAccessRequests,
  isAccessDraft,
} from "./appAccess.js";

/** The screens socket the box sends `access-request` events on. */
export const ACCESS_EVENTS_PATH = "/api/screens/events";
export const ACCESS_EVENT = "access-request";
/** A request put off with Not now (or one that failed) comes back after this. */
export const ACCESS_SNOOZE_MS = 24 * 60 * 60 * 1000;
/** Focus and navigation re-check at most this often; pushes and socket
 *  events always check. */
export const ACCESS_RECHECK_MS = 15 * 1000;
/** The page asks the service worker's notification click to post this. */
export const ACCESS_SW_MESSAGE = "ACCESS_REQUESTS";

export const accessRequestKey = (r) =>
  `${r.serverDomain ?? ""}\n${isAccessDraft(r) ? `${r.serviceId}\ndraft\n${r.createdAt ?? ""}` : `${r.serviceId}\n${r.host}`}`;

/**
 * The waiting requests of every server this device has a session for, each
 * tagged with its `serverDomain`, as iOS's AppAccessAlertCenter and Android's
 * AccessRequestCenter ask every box they manage: an app on the second server
 * asks for the internet as much as one on the current server. A server that
 * can't be reached is left out until the next check.
 * `servers` are `{fqdn, fetchJson}` (lib/appPlacement.js sessionServers).
 */
export async function fetchAccessRequestsOnServers(servers) {
  const lists = await Promise.all(
    (servers ?? []).map(async (s) => {
      try {
        return (await fetchAccessRequests(s.fetchJson)).map((r) => ({ ...r, serverDomain: s.fqdn }));
      } catch {
        return [];
      }
    }),
  );
  return lists.flat();
}

/**
 * Fetches the pending requests and hands each one, in order, to `handle`
 * (which resolves to "allow" | "deny" | "later" | "review" | "failed"). One
 * pass at a time; a forced check during a pass runs another pass after it.
 * Answered, put-off and failed requests are not shown again for `snoozeMs`;
 * a failure or a Review (the editor is now open) ends the pass.
 */
export function createAccessAlertController({
  fetchRequests,
  handle,
  isActive,
  now = Date.now,
  snoozeMs = ACCESS_SNOOZE_MS,
  minIntervalMs = ACCESS_RECHECK_MS,
}) {
  const snoozed = new Map();
  let running = false;
  let again = false;
  let lastAt = -Infinity;

  async function pass() {
    lastAt = now();
    let requests;
    try {
      requests = await fetchRequests();
    } catch {
      return;
    }
    for (const r of requests) {
      if (!isActive()) return;
      const key = accessRequestKey(r);
      const until = snoozed.get(key);
      if (until !== undefined && until > now()) continue;
      const outcome = await handle(r);
      snoozed.set(key, now() + snoozeMs);
      if (outcome === "failed" || outcome === "review") return;
    }
  }

  async function check({ force = false } = {}) {
    if (!isActive()) return;
    if (running) {
      if (force) again = true;
      return;
    }
    if (!force && now() - lastAt < minIntervalMs) return;
    running = true;
    try {
      do {
        again = false;
        await pass();
      } while (again && isActive());
    } finally {
      running = false;
    }
  }

  return { check, snoozed };
}

/**
 * One request, start to finish: the sheet, then (on Allow or Deny) the signed
 * list, then the confirmation. Resolves to the outcome for the controller.
 * A draft gets `presentDraft` instead (Review / Not now); Review opens the
 * editor with it (`openDraft`), where Save signs it as usual.
 */
export async function handleAccessRequest(req, { present, answer, confirm, openList, notify, presentDraft, openDraft }) {
  if (isAccessDraft(req)) {
    if (!presentDraft || !openDraft) return "later";
    if ((await presentDraft(req)) !== "review") return "later";
    await openDraft(req);
    return "review";
  }
  const choice = await present(req);
  if (choice !== "allow" && choice !== "deny") return "later";
  try {
    await answer(req, choice);
  } catch (e) {
    notify(e);
    return "failed";
  }
  const next = await confirm(accessAnsweredText(req.appName, req.host, choice));
  if (next === "view") await openList(req);
  return choice;
}

/** The `type` (or `event`/`kind`) of a socket frame, or null. */
export function socketEventType(data) {
  try {
    const m = typeof data === "string" ? JSON.parse(data) : data;
    if (!m || typeof m !== "object") return null;
    const t = m.type ?? m.event ?? m.kind;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/**
 * The screens socket, kept open while there is a pod to talk to. It reconnects
 * after a drop; a box that refuses the upgrade three times in a row (an older
 * box without the socket) isn't asked again until the pod or token changes.
 */
export function createAccessEventSocket({
  url,
  onEvent,
  WebSocketImpl = globalThis.WebSocket,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  maxFailures = 3,
}) {
  let ws = null;
  let currentUrl = null;
  let failures = 0;
  let timer = null;

  function disconnect() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const s = ws;
    ws = null;
    try {
      s?.close();
    } catch {
      /* already closed */
    }
  }

  function open(u) {
    let s;
    try {
      s = new WebSocketImpl(u);
    } catch {
      failures++;
      return;
    }
    ws = s;
    let opened = false;
    s.addEventListener("open", () => {
      opened = true;
      failures = 0;
    });
    s.addEventListener("message", (ev) => {
      if (socketEventType(ev.data) === ACCESS_EVENT) onEvent();
    });
    s.addEventListener("close", () => {
      if (ws !== s) return;
      ws = null;
      if (!opened) failures++;
      if (failures >= maxFailures) return;
      timer = setTimer(() => {
        timer = null;
        ensure();
      }, opened ? 5_000 : 15_000 * failures);
    });
  }

  function ensure() {
    let u = null;
    try {
      u = url();
    } catch {
      u = null;
    }
    if (u !== currentUrl) {
      disconnect();
      currentUrl = u;
      failures = 0;
    }
    if (!u || !WebSocketImpl || ws || timer !== null || failures >= maxFailures) return;
    open(u);
  }

  return { ensure, disconnect, get failures() { return failures; } };
}

function screensSocketUrl() {
  const base = getPodBaseUrl();
  const tok = getSessionToken();
  if (!base || !tok) return null;
  const wsBase = base.replace(/^http/, "ws").replace(/\/+$/, "");
  return `${wsBase}${ACCESS_EVENTS_PATH}?sessionToken=${encodeURIComponent(tok)}`;
}

export function podServerDomain() {
  try {
    return new URL(getPodBaseUrl() ?? "").hostname;
  } catch {
    return "";
  }
}

function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function openSheet(html) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `<div class="modal-card" role="document">${html}</div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");
  return overlay;
}

function sheetChoice(overlay, fallback) {
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      if (!document.querySelector(".modal-overlay")) document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close(fallback);
      }
    };
    overlay.querySelectorAll("[data-choice]").forEach((b) => {
      b.addEventListener("click", () => close(b.getAttribute("data-choice")));
    });
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(fallback);
    });
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => overlay.querySelector("[data-choice]")?.focus({ preventScroll: true }));
  });
}

/** Allow / Deny / Not now. Resolves to "allow" | "deny" | "later". */
export function showAccessRequestSheet(req) {
  const overlay = openSheet(`
    <h3 class="modal-title" data-access-sheet>${escapeHtml(accessRequestTitle(req.appName, req.host))}</h3>
    <p class="modal-message">${escapeHtml(accessRequestNote(req))}</p>
    <p class="note">Only allow hosts you expect this app to need. You can change this later in its access list.</p>
    <div class="row-2 mt-3">
      <button class="secondary" data-choice="deny">${escapeHtml(ACCESS_DENY)}</button>
      <button data-choice="allow">${escapeHtml(ACCESS_ALLOW)}</button>
    </div>
    <div class="access-sheet-later mt-2"><button class="linklike" data-choice="later">${escapeHtml(ACCESS_NOT_NOW)}</button></div>
  `);
  return sheetChoice(overlay, "later");
}

function draftHostsHtml(hosts) {
  return `<ul class="sd-access-draft-hosts">${hosts
    .map(
      (h) =>
        `<li><span class="mono text-sm">${escapeHtml(h.host)}</span>${
          h.why ? `<div class="muted-sm">${escapeHtml(h.why)}</div>` : ""
        }</li>`,
    )
    .join("")}</ul>`;
}

/** "<App> suggests an access list" with its hosts, Review / Not now.
 *  Resolves to "review" | "later". */
export function showAccessDraftSheet(draft) {
  const overlay = openSheet(`
    <h3 class="modal-title" data-access-draft-sheet>${escapeHtml(accessDraftAlertTitle(draft.appName))}</h3>
    ${draftHostsHtml(draft.hosts ?? [])}
    <p class="note">Nothing changes until you review the list and save it.</p>
    <div class="row-2 mt-3">
      <button class="secondary" data-choice="later">${escapeHtml(ACCESS_NOT_NOW)}</button>
      <button data-choice="review">${escapeHtml(ACCESS_DRAFT_REVIEW)}</button>
    </div>
  `);
  return sheetChoice(overlay, "later");
}

/** "<App> can now reach <host>" with Close and View access list. */
export function showAccessAnsweredSheet(text) {
  const overlay = openSheet(`
    <h3 class="modal-title" data-access-answered>${escapeHtml(text)}</h3>
    <div class="row-2 mt-3">
      <button class="secondary" data-choice="view">${escapeHtml(ACCESS_VIEW_LIST)}</button>
      <button data-choice="close">${escapeHtml(ACCESS_CLOSE)}</button>
    </div>
  `);
  return sheetChoice(overlay, "close");
}

/** Allow or Deny one request with this session's sensitive-order key, on the
 *  server it came from. */
export async function answerWithSession(req, action) {
  const session = getSession();
  if (!session?.umk) throw new Error("Unlock the webapp first");
  const client = boxClient(req.serverDomain || "");
  return answerAccessRequest({
    serverDomain: client.fqdn || podServerDomain(),
    serviceId: req.serviceId,
    host: req.host,
    action,
    umk: session.umk,
    signWithIrk: sensitiveSigner(),
    fetchJson: client.fetch,
    bytesToHex,
  });
}

/** The app's access list opens on the server the request came from. */
async function openOnServer(r, opts) {
  if (r.serverDomain) makeCurrentPod(r.serverDomain);
  const { enterAppAccess } = await import("../views/app-access.js");
  await enterAppAccess(r.serviceId, r.appName, opts);
}

/**
 * Wire the alerts into the shell. `isUnlocked` is the shell's "past the lock
 * screens" predicate; nothing shows over the lock, on a companion, on a device
 * that can't sign the answer (not an admin device: lib/addServerGate.js), or without
 * a paired pod.
 */
export function startAccessAlerts({ isUnlocked }) {
  const isActive = () => {
    try {
      return (
        isUnlocked() &&
        pushNotificationsEnabled() &&
        !isCompanionProfile() &&
        canSignAdminOrders() &&
        !!getPodBaseUrl() &&
        !!getSession()?.umk
      );
    } catch {
      return false;
    }
  };
  const controller = createAccessAlertController({
    isActive,
    fetchRequests: async () => fetchAccessRequestsOnServers(sessionServers(await loadAccountPods(getSession()?.username))),
    handle: (req) =>
      handleAccessRequest(req, {
        present: showAccessRequestSheet,
        answer: answerWithSession,
        confirm: showAccessAnsweredSheet,
        openList: (r) => openOnServer(r),
        presentDraft: showAccessDraftSheet,
        openDraft: (r) => openOnServer(r, { draft: true }),
        notify: (e) => toast(e?.status || e?.name === "AccessListError" ? accessErrorMessage(e) : humanError(e), "err"),
      }),
  });
  const socket = createAccessEventSocket({
    url: () => (isActive() ? screensSocketUrl() : null),
    onEvent: () => void controller.check({ force: true }),
  });
  const poke = (force = false) => {
    socket.ensure();
    void controller.check({ force });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poke();
  });
  window.addEventListener("focus", () => poke());
  document.addEventListener("flagship:view-shown", () => poke());
  try {
    navigator.serviceWorker?.addEventListener("message", (ev) => {
      if (ev.data?.type === ACCESS_SW_MESSAGE) poke(true);
    });
  } catch {
    /* no service worker */
  }
  poke();
  return { controller, socket, check: (force = true) => poke(force) };
}
