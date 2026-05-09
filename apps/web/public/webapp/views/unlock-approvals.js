// P2.6 — Unlock approvals view.
//
// Status (2026-05-09): the IRK-signed boot-approval claim needed by
// P1.9 ("body: IRK-signed unlock-key envelope") is not yet specified
// in @flagship/protocol. Until it is, this view lists pending
// unlock requests fetched via P1.8 — useful for visibility and to
// prove the proxy chain — and surfaces the approve button as a
// placeholder that emits a clear "pending backend wiring" message.
//
// When the IRK-signed envelope shape lands, replace runApprove() with
// the real signing flow.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
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
        <div style="font-weight:600;">${escapeHtml(p.serverFqdn)}</div>
        <div class="value" style="font-size:0.78rem; margin-top:0.2rem;">${escapeHtml(p.requestId)}</div>
        <div style="color:var(--fg-mute); font-size:0.78rem;">
          requested ${escapeHtml(new Date(p.requestedAt).toLocaleString())}
          ${p.ip ? `· from ${escapeHtml(p.ip)}` : ""}
        </div>
        ${p.userAgent ? `<div style="color:var(--fg-mute); font-size:0.78rem;">${escapeHtml(p.userAgent)}</div>` : ""}
        <button data-action="approve" data-request-id="${escapeHtml(p.requestId)}" style="margin-top:0.5rem; width:100%;">Approve</button>
      </div>
    `).join("");
    root.querySelectorAll('[data-action="approve"]').forEach((b) => {
      b.addEventListener("click", () => runApprove(b.getAttribute("data-request-id")));
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p style="margin:0;color:var(--err);font-size:0.9rem;">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

async function runApprove(requestId) {
  // Until the IRK-signed boot-approval envelope is speced + wired in
  // @flagship/protocol, surface a clear "pending backend" message
  // rather than POST a malformed envelope to .com.
  toast(
    `approve flow pending backend wiring (request ${requestId.slice(0, 8)}…)`,
    "err",
  );
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
