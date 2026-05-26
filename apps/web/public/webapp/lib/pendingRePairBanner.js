// Pure helpers for the Trusted-devices "Replace pending" banner.
//
// Split out from views/trusted-devices.js so the wire-shape + render
// branches can be pinned without DOM globals. The view module imports
// these and wires the click handler to `completeReplaceDeviceCeremony`.

import { escapeHtml } from "./util.js";

/** Format a completesAt millis epoch as a locale string; "soon" if
 *  the value is missing / non-numeric. */
export function formatCompletesAt(ms) {
  if (typeof ms !== "number" || !ms) return "soon";
  return new Date(ms).toLocaleString();
}

/** Should the banner render? Honors the unavailable-endpoint fallback
 *  by returning false (no banner) when no pending row was returned.
 *  An objected row is also a no-banner state — the rotation has been
 *  cancelled and there's nothing for the user to finalize. */
export function shouldRenderBanner(snapshot) {
  if (!snapshot || !snapshot.pending) return false;
  if (snapshot.pending.objectedAt) return false;
  return true;
}

/** Pure-string HTML for the pending banner. Returns "" when no banner
 *  should render. Two flavors based on `completesAt`:
 *   - past  → "Finalize now" enabled, copy says the grace elapsed,
 *   - future → button disabled with the unlock timestamp shown. */
export function renderPendingBanner(snapshot, nowMs = Date.now()) {
  if (!shouldRenderBanner(snapshot)) return "";
  const p = snapshot.pending;
  const elapsed = typeof p.completesAt === "number" && p.completesAt <= nowMs;
  const when = formatCompletesAt(p.completesAt);
  const body = elapsed
    ? `The 24-hour grace window has elapsed — finalize the device replacement now.`
    : `Replace pending — finalize when the 7-day grace elapses (${escapeHtml(when)}).`;
  return `
    <div class="card" data-pending-re-pair role="status" aria-live="polite">
      <div class="row">
        <div class="weight-600">
          <span aria-hidden="true">⏳</span>
          Replace pending
        </div>
        <button class="${elapsed ? "" : "secondary"}"
                id="finalize-replace-btn"
                ${elapsed ? "" : "disabled"}>
          Finalize now
        </button>
      </div>
      <p class="note small">${body}</p>
    </div>
  `;
}
