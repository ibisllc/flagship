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
 * Cheap, unauthenticated map of "is this box on its FIRST boot?" across the
 * owner's pods — `true` when the box has never come online (no daemon check-in
 * AND no cert), which is exactly when an unlock approval also authorizes serving
 * (so the copy reads fuller). Same `/pods` read as the inbox digest, no
 * biometric. A box absent from the map ⇒ caller defaults to first-boot (the
 * fuller copy). Mirrors the mobile `PodInfo.cameOnline` derivation.
 * @param {{ fetch?: typeof fetch, comBase?: string, getSession?: Function }} [deps]
 * @returns {Promise<Record<string, boolean>>} serverDomain → firstBoot
 */
export async function fetchFirstBootMap(deps = {}) {
  const session = deps.getSession ? deps.getSession() : getSession();
  const username = session.username;
  if (!username) return {};
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || COM_BASE;
  let body;
  try {
    const r = await f(`${comBase}/api/users/${encodeURIComponent(username)}/pods`, {
      cache: "no-store",
    });
    if (!r.ok) return {};
    body = await r.json();
  } catch {
    return {};
  }
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const pod of body?.pods ?? []) {
    if (!pod?.serverDomain) continue;
    const cameOnline = pod.lastReported != null || pod.currentCert != null;
    out[pod.serverDomain] = !cameOnline;
  }
  return out;
}

/**
 * Project a raw `/pods`/`/stream` `pods[]` array into the typed BoxRequest
 * digest — the same flatMap `fetchInbox` does, but over already-fetched pods
 * (so LiveSync can feed the inbox WITHOUT a second /pods round-trip). Pure.
 * @param {any[]} pods
 * @returns {BoxRequest[]}
 */
export function inboxFromPods(pods) {
  const out = [];
  for (const pod of pods ?? []) {
    const domain = pod?.serverDomain;
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
  out.sort((a, b) => b.issuedAt - a.issuedAt);
  return out;
}

/**
 * The app-scope inbox store (mirrors ToastCenter / activeOperations: a tiny
 * observable). The UI reads only from here via `subscribe`.
 *
 * The inbox no longer runs its OWN poll interval — it is FED by LiveSync (the
 * single live-update canal): pass `deps.source` (a LiveSync handle) and `start`
 * subscribes to it, projecting each snapshot's `pods[]` into the digest. The
 * `subscribe` interface (and `markSatisfied`) are unchanged, so callers don't
 * care where the data comes from. When no `source` is supplied (older callers /
 * tests) it degrades to a self-contained `/pods` interval, so behavior is never
 * worse than before.
 */
export function createBoxInbox(deps = {}) {
  /** @type {BoxRequest[]} */
  let requests = [];
  const listeners = new Set();
  let timer = null;
  let unsubscribeSource = null;
  const intervalMs = deps.intervalMs ?? 5000;
  const source = deps.source ?? null;

  function emit() {
    for (const fn of listeners) {
      try {
        fn(requests);
      } catch {
        /* a bad listener must never break the loop */
      }
    }
  }

  /** Feed the inbox from an already-fetched `pods[]` (the LiveSync path). */
  function feedFromPods(pods) {
    requests = inboxFromPods(pods);
    emit();
  }

  async function refresh() {
    if (source) {
      // LiveSync owns the fetch; a manual refresh just re-projects its current
      // snapshot (the loop keeps it fresh). Avoids a redundant /pods read.
      feedFromPods(source.get?.().pods ?? []);
      return requests;
    }
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
    /** Feed the inbox directly from a pods[] array (used by LiveSync). */
    feedFromPods,
    /**
     * Begin feeding the inbox. Preferred: subscribe to the injected LiveSync
     * `source` (the single canal — no extra /pods interval). Fallback (no
     * source): the legacy self-contained foreground interval.
     */
    start() {
      if (source) {
        if (unsubscribeSource) return;
        unsubscribeSource = source.subscribe((snap) => feedFromPods(snap?.pods ?? []));
        return;
      }
      if (timer) return;
      void refresh();
      timer = setInterval(() => {
        // Only poll while the tab is visible — no background battery drain.
        if (typeof document !== "undefined" && document.hidden) return;
        void refresh();
      }, intervalMs);
    },
    /** Stop feeding (call on sign-out / lock). */
    stop() {
      if (unsubscribeSource) {
        unsubscribeSource();
        unsubscribeSource = null;
      }
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
