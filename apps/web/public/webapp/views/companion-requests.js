// P14 Phase 2 — Companion requests view (owner-profile side).
//
// Router slot: section id `view-companion-requests`. Reached from
// Settings → Companion requests. Surfaces the queue of pending
// write-requests forwarded by docked companion browsers.
//
// Per row: companion label + kind ("release-server" | "revoke-server")
// + intent summary (serverDomain for release; serverId + reason for
// revoke) + queuedAt + Approve / Deny buttons.
//
// Approve flow:
//   1. Parse the row's `intent`.
//   2. Call the OWNER's signing helper for that kind (releaseServerName
//      / revokeServer) with this device's umk + signWithIrk. Those
//      helpers IRK-sign + POST to the destination endpoint
//      (flagshipserver.com/api/server/release etc.).
//   3. On success: POST /api/screens/companion/resolve-pending with
//      outcome:"approved". On failure: surface the error + leave the
//      row in the queue so the owner can retry.
//
// Deny flow:
//   POST /api/screens/companion/resolve-pending with outcome:"denied"
//   directly — no signing.
//
// BFF endpoints consumed (P14 Phase 2):
//   GET  /api/screens/companion/pending-writes
//   POST /api/screens/companion/resolve-pending

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import {
  listPendingWrites,
  pollPending,
  resolvePending,
} from "../lib/companionRequestsClient.js";
import { releaseServerName } from "../lib/releaseServer.js";
import { revokeServer } from "../lib/revokeServer.js";
import { getSession } from "../lib/state.js";
import { signWithIrk } from "../keystore.js";

registerView("view-companion-requests");

function fmtDate(unixMs) {
  if (typeof unixMs !== "number" || unixMs <= 0) return "—";
  return new Date(unixMs).toLocaleString();
}

function timeLeft(expiresAt, nowMs = Date.now()) {
  const ms = expiresAt - nowMs;
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m > 0) return `${m}m ${s}s left`;
  return `${s}s left`;
}

/**
 * Build the HTML for one pending-request row. Exported as a pure
 * function so a no-DOM test can assert against the structure without
 * a JSDOM dependency.
 */
export function renderPendingRowHtml(row, nowMs = Date.now()) {
  const label = row.companionLabel ?? "(no label)";
  const prefix = row.companionTokenPrefix ?? "";
  const summary = intentSummary(row.kind, row.intent);
  return `
      <div class="card" data-row="${escapeHtml(row.requestId ?? "")}">
        <div class="row row-top">
          <div>
            <div class="weight-600">${escapeHtml(label)}</div>
            <div class="value text-xs">${escapeHtml(prefix)}…</div>
            <div class="faint-sm">queued ${escapeHtml(fmtDate(row.queuedAt))} · ${escapeHtml(timeLeft(row.expiresAt, nowMs))}</div>
          </div>
          <span class="pill">${escapeHtml(row.kind ?? "?")}</span>
        </div>
        <p class="note mt-2">${escapeHtml(summary)}</p>
        <div class="row-2 mt-2">
          <button class="secondary" data-action="deny" data-id="${escapeHtml(row.requestId ?? "")}">Deny</button>
          <button data-action="approve" data-id="${escapeHtml(row.requestId ?? "")}">Approve</button>
        </div>
        <p class="note err-text hidden" data-row-error></p>
      </div>
    `;
}

/** Pure copy for the empty-state surface. */
export const EMPTY_STATE_HTML = `
      <div class="card placeholder">No pending requests</div>
    `;

/**
 * Build the per-row "what does this do?" summary string from the
 * (kind, intent) pair. Exported so the view test can assert against
 * the predicate truth table.
 */
export function intentSummary(kind, intent) {
  if (!intent || typeof intent !== "object") return "(no intent)";
  if (kind === "release-server") {
    const dom = typeof intent.serverDomain === "string" ? intent.serverDomain : "(no domain)";
    return `Release the name: ${dom}`;
  }
  if (kind === "revoke-server") {
    const sid = typeof intent.revokedServerId === "string" ? intent.revokedServerId : "(no server)";
    const reason = typeof intent.reason === "string" ? intent.reason : "(no reason)";
    return `Revoke ${sid} (${reason})`;
  }
  return `${kind}: ${JSON.stringify(intent)}`;
}

let _stopPoll = null;
let _badgeStopPoll = null;
let _pendingCount = 0;

/** Update the small Settings-tab badge with the current pending count. */
function setBadge(count) {
  _pendingCount = Math.max(0, Number(count) | 0);
  const el = $("companion-requests-badge");
  if (!el) return;
  if (_pendingCount === 0) {
    el.textContent = "0";
    el.classList.add("hidden");
  } else {
    el.textContent = String(_pendingCount);
    el.classList.remove("hidden");
  }
}

export function pendingCount() {
  return _pendingCount;
}

/**
 * Render the pending-writes list into the view body. Exported so the
 * test can drive it without going through the router.
 */
export async function renderCompanionRequests(deps = {}) {
  const root = $("companion-requests-content");
  if (!root) return;
  root.innerHTML = '<div class="card placeholder">loading…</div>';

  let body;
  try {
    body = await listPendingWrites(deps);
  } catch (e) {
    console.error("companion pending-writes load failed", e);
    if (e instanceof ScreensError) {
      if (e.status === 503 || e.status === 404) {
        root.innerHTML = `
          <div class="card placeholder">
            Your server isn't running the companion write-relay yet (pre-P14.2 daemon).
            Update the daemon to surface pending companion requests here.
          </div>
        `;
        setBadge(0);
        return;
      }
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(humanError(e))}</p></div>`;
      return;
    }
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(humanError(e))}</p></div>`;
    return;
  }

  const pending = Array.isArray(body.pending) ? body.pending : [];
  setBadge(pending.length);

  if (pending.length === 0) {
    root.innerHTML = EMPTY_STATE_HTML;
    return;
  }

  root.innerHTML = pending.map((row) => renderPendingRowHtml(row)).join("");

  root.querySelectorAll('[data-action="approve"]').forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-id");
      const row = pending.find((r) => r.requestId === id);
      if (!row) return;
      void runApprove(row, deps);
    });
  });
  root.querySelectorAll('[data-action="deny"]').forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-id");
      const row = pending.find((r) => r.requestId === id);
      if (!row) return;
      void runDeny(row, deps);
    });
  });
}

function setRowError(requestId, message) {
  // Tolerate a headless test env that doesn't ship a DOM — the test
  // asserts the return value of runApprove/runDeny, not the DOM mutation.
  if (typeof document === "undefined" || typeof CSS === "undefined") return;
  const row = document.querySelector(`[data-row="${CSS.escape(requestId)}"]`);
  if (!row) return;
  const err = row.querySelector("[data-row-error]");
  if (!err) return;
  if (message) {
    err.textContent = message;
    err.classList.remove("hidden");
  } else {
    err.textContent = "";
    err.classList.add("hidden");
  }
}

/**
 * Approve: call the matching owner-signing helper for the kind, then
 * resolve-pending only on success. Exported so tests can drive it
 * without DOM events.
 */
export async function runApprove(row, deps = {}) {
  if (!row || !row.requestId) return { ok: false, error: "no row" };
  const release = deps.releaseServerName || releaseServerName;
  const revoke = deps.revokeServer || revokeServer;
  const resolve = deps.resolvePending || resolvePending;
  const session = (deps.getSession || getSession)();
  const sign = deps.signWithIrk || ((umk, bytes) => signWithIrk(umk, bytes));
  if (!session?.umk || typeof sign !== "function") {
    setRowError(row.requestId, "unlock the webapp first");
    return { ok: false, error: "locked" };
  }

  setRowError(row.requestId, "");
  try {
    if (row.kind === "release-server") {
      const intent = row.intent ?? {};
      const out = await release({
        username: intent.username,
        serverDomain: intent.serverDomain,
        umk: session.umk,
        signWithIrk: sign,
      });
      // releaseServerName returns { pending: true, ... } only when the
      // CALLER is a companion. The owner-side approve must NEVER take
      // that branch — refuse to resolve if it does (signals a bug).
      if (out && out.pending) {
        setRowError(row.requestId, "owner profile somehow routed through relay — refusing to resolve");
        return { ok: false, error: "owner-as-companion" };
      }
    } else if (row.kind === "revoke-server") {
      const intent = row.intent ?? {};
      const out = await revoke({
        userId: intent.userId,
        revokedServerId: intent.revokedServerId,
        reason: intent.reason,
        umk: session.umk,
        signWithIrk: sign,
      });
      if (out && out.pending) {
        setRowError(row.requestId, "owner profile somehow routed through relay — refusing to resolve");
        return { ok: false, error: "owner-as-companion" };
      }
    } else {
      setRowError(row.requestId, `unknown kind: ${row.kind}`);
      return { ok: false, error: "unknown-kind" };
    }
  } catch (e) {
    console.error("companion approve: sign + post failed", e);
    const msg = e?.message ?? String(e);
    setRowError(row.requestId, humanError(e));
    return { ok: false, error: msg };
  }

  try {
    await resolve({ requestId: row.requestId, outcome: "approved" });
  } catch (e) {
    console.error("companion approve: resolve-pending failed", e);
    setRowError(row.requestId, humanError(e));
    return { ok: false, error: String(e?.message ?? e) };
  }
  toast(`approved ${row.kind}`, "ok");
  // Refresh the list — non-fatal if the DOM isn't here (test env).
  if (typeof document !== "undefined") {
    await renderCompanionRequests(deps).catch(() => { /* swallow */ });
  }
  return { ok: true };
}

/**
 * Deny: post resolve-pending with outcome=denied; no signing required.
 */
export async function runDeny(row, deps = {}) {
  if (!row || !row.requestId) return { ok: false, error: "no row" };
  const resolve = deps.resolvePending || resolvePending;
  setRowError(row.requestId, "");
  try {
    await resolve({ requestId: row.requestId, outcome: "denied" });
  } catch (e) {
    console.error("companion deny: resolve-pending failed", e);
    setRowError(row.requestId, humanError(e));
    return { ok: false, error: String(e?.message ?? e) };
  }
  toast(`denied`, "ok");
  if (typeof document !== "undefined") {
    await renderCompanionRequests(deps).catch(() => { /* swallow */ });
  }
  return { ok: true };
}

export function initCompanionRequestsView() {
  $("companion-requests-back")?.addEventListener("click", () => show("view-settings-tab"));
  $("companion-requests-refresh")?.addEventListener("click", () => {
    renderCompanionRequests().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterCompanionRequests() {
  show("view-companion-requests");
  await renderCompanionRequests();
  // Start polling while the view is mounted; the next view's show()
  // toggles us .hidden but the poll keeps running — wire stop on the
  // back button + on next enter.
  if (_stopPoll) { try { _stopPoll(); } catch { /* ignore */ } _stopPoll = null; }
  _stopPoll = pollPending(({ pending }) => {
    setBadge(pending.length);
    // Re-render only when this view is on stage; otherwise the next
    // enter() will pick up the fresh state.
    const el = document.getElementById("view-companion-requests");
    if (el && !el.classList.contains("hidden")) {
      renderCompanionRequests().catch(() => { /* swallow */ });
    }
  });
}

/**
 * Light-weight badge poll the Settings tab kicks off on entry so the
 * "Companion requests (N)" entry reflects current state without forcing
 * the user to drill in. Returns a stop() handle.
 */
export function startBadgePoll(deps = {}) {
  if (_badgeStopPoll) { try { _badgeStopPoll(); } catch { /* ignore */ } _badgeStopPoll = null; }
  _badgeStopPoll = pollPending(({ pending }) => setBadge(pending.length), deps);
  return _badgeStopPoll;
}

export function stopBadgePoll() {
  if (_badgeStopPoll) {
    try { _badgeStopPoll(); } catch { /* ignore */ }
    _badgeStopPoll = null;
  }
}

/** Single-shot badge refresh, used by Settings entry. */
export async function refreshBadgeOnce(deps = {}) {
  try {
    const { pending } = await listPendingWrites(deps);
    setBadge(Array.isArray(pending) ? pending.length : 0);
  } catch {
    // Stay quiet — Settings shouldn't toast on a 503/404 from an older daemon.
  }
}
