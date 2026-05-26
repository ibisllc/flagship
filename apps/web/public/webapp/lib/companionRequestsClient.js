// P14 Phase 2 — Companion-write requests: owner-side client helpers.
//
// All endpoints below are paired-session-gated on the owner profile
// (the active session token resolves to the owner's stable-id on the
// pod). They mirror the BFF style of companionClient.js.
//
// Endpoints:
//   GET  /api/screens/companion/pending-writes
//     → { pending: [{ requestId, companionTokenPrefix, companionLabel,
//                     kind, intent, queuedAt, expiresAt }] }
//   POST /api/screens/companion/resolve-pending
//     body { requestId, outcome: "approved" | "denied" }
//     → 200 { ok: true } — idempotent (returns ok even if already resolved)

import { screensFetch } from "./api.js";

/** Allowed outcomes on the owner-side resolve call. */
export const RESOLVE_OUTCOMES = Object.freeze(["approved", "denied"]);

/**
 * Fetch the current pending-writes list. Empty list = no pending rows.
 * Throws ScreensError on transport / 4xx / 5xx (caller surfaces a toast).
 */
export async function listPendingWrites(deps = {}) {
  const fetcher = deps.screensFetch || screensFetch;
  const body = await fetcher("/api/screens/companion/pending-writes");
  const pending = Array.isArray(body?.pending) ? body.pending : [];
  return { pending };
}

/**
 * Mark a pending request as approved / denied. The daemon side is
 * idempotent — re-posting a resolution for an already-resolved row
 * still 200s so the UI can retry safely.
 */
export async function resolvePending({ requestId, outcome }, deps = {}) {
  if (!requestId || typeof requestId !== "string") {
    throw new Error("requestId required");
  }
  if (!RESOLVE_OUTCOMES.includes(outcome)) {
    throw new Error(`outcome must be one of ${RESOLVE_OUTCOMES.join(", ")}`);
  }
  const fetcher = deps.screensFetch || screensFetch;
  return await fetcher("/api/screens/companion/resolve-pending", {
    method: "POST",
    body: JSON.stringify({ requestId, outcome }),
  });
}

/**
 * Convenience: poll the pending list every `intervalMs` (default 10s)
 * and call `onUpdate({ pending })` with each fresh snapshot. Returns a
 * stop() handle the caller invokes on view-unmount.
 *
 * Errors are swallowed silently per tick (transport blips); the caller
 * still sees the last-good snapshot, and `onError` can be passed if it
 * wants to surface persistent failures.
 */
export function pollPending(onUpdate, deps = {}) {
  const interval = typeof deps.intervalMs === "number" ? deps.intervalMs : 10_000;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const onError = typeof deps.onError === "function" ? deps.onError : null;
  let handle = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const snap = await listPendingWrites(deps);
      if (stopped) return;
      try { onUpdate(snap); } catch { /* swallow user-callback errors */ }
    } catch (e) {
      if (onError) {
        try { onError(e); } catch { /* swallow */ }
      }
    }
    if (stopped) return;
    handle = setT(tick, interval);
  };
  // Run the first tick immediately so the caller doesn't see a blank
  // view for `interval` ms.
  Promise.resolve().then(tick);

  return () => {
    stopped = true;
    if (handle != null) {
      try { clearT(handle); } catch { /* ignore */ }
      handle = null;
    }
  };
}
