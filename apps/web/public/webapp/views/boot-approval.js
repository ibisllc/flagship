// The Box Request Inbox surface (docs/box-request-inbox.md) — the webapp's
// view of "things your boxes are asking you to approve". Generalises the old
// unlock-only boot-approval screen: it now lists EVERY pending request type
// (unlock-key AND entitlement) from one registry, satisfies any of them with
// one dispatch, and auto-refreshes on a foreground poll so there's no
// drag-to-refresh. Mirror of the iOS/Android inbox.
//
// It lives in the Activity tab's "Server approvals" section (there is no
// separate page): the list, its count badge, an empty state, a loading state
// and a "Try again" state. The section is static markup, so it stays
// reachable when the activity feed can't load. `enterBootApproval` is the
// alias for the old route: push and deep links open Activity at this section.

import { $, show } from "../lib/router.js";
import { boxErrorText, humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { getSession } from "../lib/state.js";
import {
  fetchVerifiedRequests,
  satisfy,
  BOX_REQUEST_TYPES,
} from "../lib/bootApproval.js";
import { fetchFirstBootMap } from "../lib/boxInbox.js";

import { tr } from "../lib/i18n.js";
let inFlightId = null;
let pollTimer = null;
const POLL_MS = 5000;

function typeTitle(purpose, ctx) {
  const spec = BOX_REQUEST_TYPES[purpose];
  if (spec) return spec.title(ctx);
  return tr("Approval request");
}

function infoRow(label, value) {
  if (!value) return "";
  return `
    <div class="row">
      <span class="label">${escapeHtml(label)}</span>
      <span class="value text-xs">${escapeHtml(String(value))}</span>
    </div>
  `;
}

function requestCard(req, firstBootMap = {}) {
  const info = req.deviceInfo || {};
  // First boot vs established reboot, derived from the cheap /pods directory:
  // unknown ⇒ first-boot (the fuller copy, today's wording).
  const firstBoot = firstBootMap[req.serverDomain] ?? true;
  // Any type the registry knows how to satisfy is actionable here (the webapp
  // is now at parity with mobile — it answers unlock-key AND entitlement).
  const actionable = !!BOX_REQUEST_TYPES[req.purpose];
  const busy = inFlightId === req.id;
  const action = actionable
    ? `<button class="primary full-width mt-2" data-approve-id="${escapeHtml(req.id)}" ${busy ? "disabled" : ""}>
         ${busy ? tr("Working…") : tr("Yes, this is my box")}
       </button>`
    : `<p class="faint-sm mt-2">${tr("Approve this request from your phone.")}</p>`;
  return `
    <div class="card" data-boot-request-id="${escapeHtml(req.id)}">
      <div class="value server-fqdn">${escapeHtml(req.serverDomain)}</div>
      <p class="note small">${escapeHtml(typeTitle(req.purpose, { firstBoot }))}</p>
      ${req.deviceInfo
          ? `<div class="mt-1">
               ${infoRow("IP", info.ip)}
               ${infoRow("Region", info.region)}
               ${infoRow("OS", info.os)}
               ${infoRow("Host", info.hostname)}
             </div>`
          : ""}
      <p class="faint-sm mt-1">
        ${tr("Is this the machine in front of you? Only approve if you recognise it.")}
      </p>
      ${action}
    </div>
  `;
}

/** The count badge on the section header: hidden at 0. */
function setCount(n) {
  const badge = $("activity-approvals-count");
  if (!badge) return;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

/** "already answered": another device (or an earlier tap) did it. Done, not an error. */
export function isAlreadyAnswered(e) {
  return e?.status === 409;
}

let lastVerified = [];

function paintList(root, verified, firstBootMap) {
  setCount(verified.length);
  root.dataset.painted = "1";
  if (!verified.length) {
    root.innerHTML = `<div class="card placeholder">${tr("Nothing waiting for you")}</div>`;
    return;
  }
  root.innerHTML = verified.map((req) => requestCard(req, firstBootMap)).join("");
  bindCards(root, verified, firstBootMap);
}

let lastFirstBootMap = {};

export async function renderBootApproval() {
  const root = $("boot-approval-content");
  if (!root) return;
  const session = getSession();
  if (!session.username) {
    setCount(0);
    root.innerHTML = `<div class="card placeholder">${tr("Sign in to approve a box.")}</div>`;
    return;
  }
  if (!session.umk) {
    setCount(0);
    root.innerHTML = `<div class="card placeholder">${tr("Unlock the webapp first.")}</div>`;
    return;
  }
  // Don't blow away the list (and any in-flight button) under the poll — only
  // show skeletons on the very first paint.
  if (!root.dataset.painted) root.innerHTML = skeletonCards(2);
  let verified;
  try {
    verified = await fetchVerifiedRequests();
  } catch (e) {
    console.error("approvals load failed", e);
    // A poll that fails behind a painted list leaves the list alone.
    if (!root.dataset.painted || root.dataset.failed === "1") {
      root.dataset.failed = "1";
      root.innerHTML = `
        <div class="card">
          <p class="err-text">${escapeHtml(boxErrorText(e))}</p>
          <button class="secondary full-width mt-2" id="boot-approval-retry">${tr("Try again")}</button>
        </div>`;
      $("boot-approval-retry")?.addEventListener("click", () => {
        delete root.dataset.painted;
        renderBootApproval().catch((err) => toast(humanError(err), "err"));
      });
    }
    return;
  }
  delete root.dataset.failed;
  lastVerified = verified;
  if (!verified.length) {
    lastFirstBootMap = {};
    paintList(root, verified, lastFirstBootMap);
    return;
  }
  // Cheap, non-biometric: which boxes are on their FIRST boot (so the unlock
  // copy reads fuller). Best-effort — a blip leaves the map empty ⇒ every card
  // defaults to first-boot (today's wording), never a worse state.
  lastFirstBootMap = await fetchFirstBootMap().catch(() => ({}));
  paintList(root, verified, lastFirstBootMap);
}

function bindCards(root, verified, firstBootMap) {
  for (const btn of root.querySelectorAll("[data-approve-id]")) {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-approve-id");
      const req = verified.find((r) => r.id === id);
      if (!req || inFlightId) return;
      inFlightId = id;
      btn.disabled = true;
      btn.textContent = tr("Working…");
      let answered = false;
      try {
        await satisfy(req);
        answered = true;
        toast(tr("Approved {0}. Your box will pick it up.", req.serverDomain));
      } catch (e) {
        if (isAlreadyAnswered(e)) {
          answered = true; // someone answered it already: done, no error
        } else {
          console.error("approval failed", e);
          toast(tr("Couldn't approve {0}. {1}", req.serverDomain, boxErrorText(e)), "err");
        }
      } finally {
        inFlightId = null;
        if (answered) {
          // The card clears at once; the re-fetch below confirms it.
          lastVerified = lastVerified.filter((r) => r.id !== id);
          paintList(root, lastVerified, firstBootMap);
        } else {
          paintList(root, lastVerified, firstBootMap);
        }
        renderBootApproval().catch(() => {});
      }
    });
  }
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (inFlightId) return; // never refresh over an in-flight approval
    renderBootApproval().catch(() => {});
  }, POLL_MS);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** The old route's alias: land on Activity with the approvals section in view. */
export async function enterBootApproval() {
  show("view-activity");
  const root = $("boot-approval-content");
  if (root) delete root.dataset.painted;
  await renderBootApproval();
  $("activity-approvals")?.scrollIntoView?.({ block: "start" });
}

export function initBootApprovalView() {
  // The section is part of Activity: it loads and polls while that tab shows.
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id === "view-activity") {
      const root = $("boot-approval-content");
      if (root) delete root.dataset.painted;
      renderBootApproval().catch(() => {});
      startPoll();
    } else {
      stopPoll();
    }
  });
}
