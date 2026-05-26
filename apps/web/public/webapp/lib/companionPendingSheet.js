// P14 Phase 2 — "Forwarded to owner" pending sheet.
//
// Rendered when a companion profile attempts a relayable signed write
// (release-server / revoke-server). The releaseServerName / revokeServer
// helpers detect the companion profile, POST the intent to
// /api/companion/request-write, and return { pending: true, requestId,
// expiresAt }. This helper opens an inline modal with a mm:ss countdown
// and polls /api/companion/my-pending until the owner approves, denies,
// or the request expires.
//
// Pure-ish: DOM-touching, but accepts injected timer + fetch deps so the
// approve / deny / expired branches can be unit-tested.
//
// Returns one of:
//   { outcome: "approved", resolvedAt }
//   { outcome: "denied", resolvedAt }
//   { outcome: "expired" }
//   { outcome: "error", error }

import { pollUntilResolved } from "./companionWriteRelay.js";

function fmtMmSs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Open the "Forwarded to owner" sheet for a queued request.
 *
 * @param {{ requestId: string, expiresAt: number, kind: string }} pending
 * @param {object} [deps]
 * @param {typeof pollUntilResolved} [deps.pollUntilResolved]
 * @param {() => number} [deps.now]
 * @param {Document} [deps.document]
 */
export async function showCompanionPendingSheet(pending, deps = {}) {
  if (typeof document === "undefined" && !deps.document) {
    // Headless — caller is responsible for surfacing the outcome.
    const out = await (deps.pollUntilResolved || pollUntilResolved)(pending.requestId, deps);
    return { outcome: out.status, resolvedAt: out.resolvedAt };
  }
  const doc = deps.document || document;
  const now = deps.now || Date.now;
  const overlay = doc.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.id = "companion-pending-sheet";
  overlay.innerHTML = `
    <div class="modal-card">
      <h3 class="modal-title">Forwarded to owner</h3>
      <p class="modal-message">
        Companion sessions can't sign on their own. Waiting for the
        account owner to approve the
        ${escapeHtml(pending.kind || "request")}.
      </p>
      <div class="row mt-2">
        <span class="label">Time left</span>
        <span class="value" data-pending-countdown>${escapeHtml(fmtMmSs(pending.expiresAt - now()))}</span>
      </div>
      <p class="note mt-2" data-pending-status>waiting…</p>
    </div>
  `;
  doc.body.appendChild(overlay);
  doc.body.classList.add("modal-open");

  let countdownHandle = null;
  const tickCountdown = () => {
    const left = pending.expiresAt - now();
    const el = overlay.querySelector("[data-pending-countdown]");
    if (el) el.textContent = fmtMmSs(left);
    if (left > 0) {
      countdownHandle = setTimeout(tickCountdown, 1000);
    }
  };
  tickCountdown();

  let outcome;
  try {
    const poll = deps.pollUntilResolved || pollUntilResolved;
    const result = await poll(pending.requestId, deps);
    outcome = { outcome: result.status, resolvedAt: result.resolvedAt };
  } catch (e) {
    outcome = { outcome: "error", error: e?.message ?? String(e) };
  } finally {
    if (countdownHandle != null) clearTimeout(countdownHandle);
  }

  // Surface the terminal copy briefly so the user reads it.
  const statusEl = overlay.querySelector("[data-pending-status]");
  if (statusEl) {
    if (outcome.outcome === "approved") statusEl.textContent = "Approved — applying…";
    else if (outcome.outcome === "denied") statusEl.textContent = "Owner denied this request.";
    else if (outcome.outcome === "expired") statusEl.textContent = "No response in 10 minutes — request expired.";
    else statusEl.textContent = `Error: ${outcome.error ?? "unknown"}`;
  }

  await new Promise((r) => setTimeout(r, 1200));
  try { overlay.remove(); } catch { /* ignore */ }
  doc.body.classList.remove("modal-open");
  return outcome;
}

/** Toast-friendly copy for each terminal outcome. */
export function outcomeToastCopy(outcome) {
  if (outcome === "approved") return { text: "Owner approved — done", kind: "ok" };
  if (outcome === "denied") return { text: "Owner denied this request.", kind: "err" };
  if (outcome === "expired") return { text: "No response in 10 minutes — request expired.", kind: "err" };
  return { text: `Request failed: ${outcome}`, kind: "err" };
}
