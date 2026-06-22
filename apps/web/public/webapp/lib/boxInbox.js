// Box Request Inbox — the webapp's always-on channel for "a box is asking its
// owner to approve something" (docs/box-request-inbox.md). Generalises the
// unlock-only awaitingUnlock watcher into ONE typed inbox that also covers
// entitlement (and any future request type) with no new plumbing.
//
// Two tiers, mirroring mobile:
//   - DETECT (cheap, unauthenticated, pollable): read the `pendingRequests`
//     digest off /api/users/:u/pods — no biometric. A foreground loop keeps it
//     fresh while the app is active, so there's no drag-to-refresh.
//   - SATISFY (authenticated, on tap): bootApproval.fetchVerifiedRequests +
//     satisfy() — one IRK signature at the moment of action.
//
// The transport is abstracted: today it's a foreground poll; a future SSE/
// WebSocket or push channel can feed the SAME inbox without touching callers.

import { getSession } from "./state.js";
import { controlApex } from "./apex.js";

const COM_BASE = controlApex();

/**
 * One pending box→owner approval request (the digest item).
 * @typedef {Object} BoxRequest
 * @property {string} id            `<serverDomain>#<requestNonceHex>` (matches the verified-request id)
 * @property {string} serverDomain
 * @property {string} type          secret-request purpose: "unlock-key" | "entitlement" | …
 * @property {number} issuedAt
 * @property {number} expiresAt
 */

/**
 * Fetch the cheap, unauthenticated inbox digest across the owner's boxes:
 * the flatMap of each pod's `pendingRequests`. No biometric.
 * @param {{ fetch?: typeof fetch, comBase?: string }} [deps]
 * @returns {Promise<BoxRequest[]>}
 */
export async function fetchInbox(deps = {}) {
  const session = deps.getSession ? deps.getSession() : getSession();
  const username = session.username;
  if (!username) return [];
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || COM_BASE;
  const r = await f(`${comBase}/api/users/${encodeURIComponent(username)}/pods`, {
    cache: "no-store",
  });
  if (!r.ok) return [];
  const body = await r.json().catch(() => ({ pods: [] }));
  const out = [];
  for (const pod of body.pods ?? []) {
    const domain = pod.serverDomain;
    if (!domain) continue;
    for (const pr of pod.pendingRequests ?? []) {
      if (!pr || !pr.type || !pr.id) continue;
      out.push({
        id: `${domain}#${pr.id}`,
        serverDomain: domain,
        type: pr.type,
        issuedAt: pr.issuedAt ?? 0,
        expiresAt: pr.expiresAt ?? 0,
      });
    }
  }
  // Freshest first, so the UI surfaces the newest ask on top.
  out.sort((a, b) => b.issuedAt - a.issuedAt);
  return out;
}

/**
 * The app-scope inbox store (mirrors ToastCenter / activeOperations: a tiny
 * observable + a foreground poll loop). The UI reads only from here.
 */
export function createBoxInbox(deps = {}) {
  /** @type {BoxRequest[]} */
  let requests = [];
  const listeners = new Set();
  let timer = null;
  const intervalMs = deps.intervalMs ?? 5000;

  function emit() {
    for (const fn of listeners) {
      try {
        fn(requests);
      } catch {
        /* a bad listener must never break the loop */
      }
    }
  }

  async function refresh() {
    try {
      const next = await fetchInbox(deps);
      requests = next;
      emit();
    } catch {
      // Keep last-good on a transient failure — never blank the inbox.
    }
    return requests;
  }

  return {
    /** Current snapshot. */
    get: () => requests,
    /** Subscribe; immediately receives the current snapshot. Returns unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      try {
        fn(requests);
      } catch {
        /* ignore */
      }
      return () => listeners.delete(fn);
    },
    /** One immediate poll (also used by a manual refresh). */
    refresh,
    /** Begin the foreground loop: immediate first tick, then every intervalMs. */
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => {
        // Only poll while the tab is visible — no background battery drain.
        if (typeof document !== "undefined" && document.hidden) return;
        void refresh();
      }, intervalMs);
    },
    /** Stop the loop (call on sign-out / lock). */
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    /**
     * Optimistically drop a satisfied request so the card clears instantly
     * (the next poll confirms it's gone — the row becomes answered).
     */
    markSatisfied(id) {
      requests = requests.filter((r) => r.id !== id);
      emit();
    },
  };
}
