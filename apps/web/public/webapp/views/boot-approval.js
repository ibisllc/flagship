// The Box Request Inbox surface (docs/box-request-inbox.md) — the webapp's
// view of "things your boxes are asking you to approve". Generalises the old
// unlock-only boot-approval screen: it now lists EVERY pending request type
// (unlock-key AND entitlement) from one registry, satisfies any of them with
// one dispatch, and auto-refreshes on a foreground poll so there's no
// drag-to-refresh. Mirror of the iOS/Android inbox.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { getSession } from "../lib/state.js";
import {
  fetchVerifiedRequests,
  satisfy,
  BOX_REQUEST_TYPES,
} from "../lib/bootApproval.js";

registerView("view-boot-approval");

let inFlightId = null;
let pollTimer = null;
const POLL_MS = 5000;

function typeTitle(purpose) {
  const spec = BOX_REQUEST_TYPES[purpose];
  if (spec) return spec.title();
  return "Approval request";
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

function requestCard(req) {
  const info = req.deviceInfo || {};
  // Any type the registry knows how to satisfy is actionable here (the webapp
  // is now at parity with mobile — it answers unlock-key AND entitlement).
  const actionable = !!BOX_REQUEST_TYPES[req.purpose];
  const busy = inFlightId === req.id;
  const action = actionable
    ? `<button class="primary full-width mt-2" data-approve-id="${escapeHtml(req.id)}" ${busy ? "disabled" : ""}>
         ${busy ? "Working…" : "Yes, this is my box"}
       </button>`
    : `<p class="faint-sm mt-2">Approve this request from your phone.</p>`;
  return `
    <div class="card" data-boot-request-id="${escapeHtml(req.id)}">
      <div class="value server-fqdn">${escapeHtml(req.serverDomain)}</div>
      <p class="note small">${escapeHtml(typeTitle(req.purpose))}</p>
      ${
        req.deviceInfo
          ? `<div class="mt-1">
               ${infoRow("IP", info.ip)}
               ${infoRow("Region", info.region)}
               ${infoRow("OS", info.os)}
               ${infoRow("Host", info.hostname)}
             </div>`
          : ""
      }
      <p class="faint-sm mt-1">
        Is this the machine in front of you? Only approve if you recognise it.
      </p>
      ${action}
    </div>
  `;
}

export async function renderBootApproval() {
  const root = $("boot-approval-content");
  if (!root) return;
  const session = getSession();
  if (!session.username) {
    root.innerHTML = `<div class="card placeholder">Sign in to approve a box.</div>`;
    return;
  }
  if (!session.umk) {
    root.innerHTML = `<div class="card placeholder">Unlock the webapp first.</div>`;
    return;
  }
  // Don't blow away the list (and any in-flight button) under the poll — only
  // show skeletons on the very first paint.
  if (!root.dataset.painted) root.innerHTML = skeletonCards(2);
  let verified;
  try {
    verified = await fetchVerifiedRequests();
  } catch (e) {
    if (!root.dataset.painted) {
      root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(
        e?.message ?? "Couldn't load pending boxes.",
      )}</div>`;
    }
    return;
  }
  root.dataset.painted = "1";
  if (!verified.length) {
    root.innerHTML = `<div class="card placeholder">No box is waiting for approval right now.</div>`;
    return;
  }
  root.innerHTML = verified.map(requestCard).join("");
  bindCards(root, verified);
}

function bindCards(root, verified) {
  for (const btn of root.querySelectorAll("[data-approve-id]")) {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-approve-id");
      const req = verified.find((r) => r.id === id);
      if (!req) return;
      inFlightId = id;
      await renderBootApproval();
      try {
        await satisfy(req);
        toast(`Approved ${req.serverDomain}. Your box will pick it up.`);
      } catch (e) {
        toast(`Approval failed: ${e?.message ?? "unknown error"}`, "err");
      } finally {
        inFlightId = null;
        await renderBootApproval();
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

export async function enterBootApproval() {
  show("view-boot-approval");
  const root = $("boot-approval-content");
  if (root) delete root.dataset.painted;
  await renderBootApproval();
  startPoll();
}

export function initBootApprovalView() {
  $("boot-approval-back")?.addEventListener("click", () => {
    stopPoll();
    show("view-activity");
  });
  $("boot-approval-refresh")?.addEventListener("click", () => {
    renderBootApproval().catch((e) => {
      console.error(e);
      toast(humanError(e), "err");
    });
  });
}
