// Approve a box's boot — the webapp's phone-as-unlock-endpoint surface.
//
// Mirror of the iOS SecretRequestsScreen (SecretRequestsContainer +
// SecretRequestCard). Opened from the Activity tab. On enter it fetches
// the account's pending mailbox requests, RE-VERIFIES each against the
// box's STK resolved from the directory, and shows the box's device-info
// for a one-tap "Yes, this is my box" confirm. On confirm it unseals the
// LUKS key, re-seals it for the box STK bound to (nonce, purpose), and
// posts the reply through the boot worker (owner-IRK signed). All crypto
// lives in lib/bootApproval.js.

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { getSession } from "../lib/state.js";
import { fetchVerifiedRequests, approveUnlock } from "../lib/bootApproval.js";

registerView("view-boot-approval");

let inFlightId = null;

function purposeLabel(purpose) {
  switch (purpose) {
    case "unlock-key":
      return "Unlock its encrypted disk";
    case "entitlement":
      return "Authorize it to serve your account";
    default:
      return "Boot secret";
  }
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
  const isUnlock = req.purpose === "unlock-key";
  const busy = inFlightId === req.id;
  // The webapp signs `unlock-key` end to end; `entitlement` carriers are
  // owned by the mobile app, so we surface those read-only with a hint.
  const action = isUnlock
    ? `<button class="primary full-width mt-2" data-approve-id="${escapeHtml(req.id)}" ${busy ? "disabled" : ""}>
         ${busy ? "Signing…" : "Yes, this is my box"}
       </button>`
    : `<p class="faint-sm mt-2">Approve this request from your phone — the webapp signs disk-unlock approvals only.</p>`;
  return `
    <div class="card" data-boot-request-id="${escapeHtml(req.id)}">
      <div class="value server-fqdn">${escapeHtml(req.serverDomain)}</div>
      <p class="note small">${escapeHtml(purposeLabel(req.purpose))}</p>
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
  root.innerHTML = skeletonCards(2);
  let verified;
  try {
    verified = await fetchVerifiedRequests();
  } catch (e) {
    root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(
      e?.message ?? "Couldn't load pending boxes.",
    )}</div>`;
    return;
  }
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
        await approveUnlock(req);
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

export async function enterBootApproval() {
  show("view-boot-approval");
  await renderBootApproval();
}

export function initBootApprovalView() {
  $("boot-approval-back")?.addEventListener("click", () => show("view-activity"));
  $("boot-approval-refresh")?.addEventListener("click", () => {
    renderBootApproval().catch((e) => toast(String(e), "err"));
  });
}
