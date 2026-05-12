// P2.6 — Unlock approvals view.
//
// Approve = sign + post a one-shot AutoUnlockLease (10-minute expiry,
// multiUse=false). The webapp signs the lease envelope locally with
// its IRK — peer device, no phone hop required. See
// auto_unlock_lease_design.md for the unified lease model.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { approveOneShot } from "../lib/leases.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-unlock-approvals");

let pollTimer = null;
const POLL_INTERVAL_MS = 5_000;

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

export async function renderUnlockApprovals() {
  const root = $("unlock-approvals-content");
  root.innerHTML = '<div class="card placeholder">loading…</div>';
  try {
    const body = await screensFetch("/api/screens/unlock-approvals/pending");
    if (!body.pending?.length) {
      root.innerHTML = '<div class="card placeholder">no pending unlock requests</div>';
      return;
    }
    root.innerHTML = body.pending.map((p) => `
      <div class="card">
        <div class="weight-600">${escapeHtml(p.serverFqdn)}</div>
        <div class="value text-xs mt-1">${escapeHtml(p.requestId)}</div>
        <div class="faint-sm">
          requested ${escapeHtml(new Date(p.requestedAt).toLocaleString())}
          ${p.ip ? `· from ${escapeHtml(p.ip)}` : ""}
        </div>
        ${p.userAgent ? `<div class="faint-sm">${escapeHtml(p.userAgent)}</div>` : ""}
        <button data-action="approve"
                data-server-fqdn="${escapeHtml(p.serverFqdn)}"
                data-request-id="${escapeHtml(p.requestId)}"
                class="full-width mt-2">Approve</button>
      </div>
    `).join("");
    root.querySelectorAll('[data-action="approve"]').forEach((b) => {
      b.addEventListener("click", () => runApprove(
        b.getAttribute("data-server-fqdn"),
        b.getAttribute("data-request-id"),
        b,
      ));
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function runApprove(serverFqdn, requestId, btn) {
  if (!serverFqdn) {
    toast("missing server fqdn on approve button", "err");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Approving…";
  }
  try {
    const r = await approveOneShot(serverFqdn);
    toast(
      `lease deposited (${r.leaseId.slice(0, 8)}…); server can boot for the next 10 min`,
      "ok",
    );
    // Refresh so the now-satisfied request drops off the list.
    void renderUnlockApprovals();
  } catch (e) {
    toast(`approve failed: ${e.message ?? e}`, "err");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Approve";
    }
  }
}

function schedulePoll() {
  clearPoll();
  pollTimer = setTimeout(() => {
    renderUnlockApprovals().catch((e) => toast(String(e), "err")).finally(() => {
      // keep polling while the view is visible; show("…") swap clears.
      const visible = !$("view-unlock-approvals").classList.contains("hidden");
      if (visible) schedulePoll();
    });
  }, POLL_INTERVAL_MS);
}

export function initUnlockApprovalsView() {
  $("unlock-approvals-back")?.addEventListener("click", () => {
    clearPoll();
    show("view-home");
  });
  $("unlock-approvals-refresh")?.addEventListener("click", () => {
    renderUnlockApprovals().catch((e) => toast(String(e), "err"));
  });
}

export async function enterUnlockApprovals() {
  show("view-unlock-approvals");
  await renderUnlockApprovals();
  schedulePoll();
}
