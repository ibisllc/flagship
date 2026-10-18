// LiveSync — the webapp's SINGLE app-scope live-update channel.
//
// One long-poll loop against the backend hanging-GET
//   GET /api/users/:u/stream?cursor=<hex>
// which returns `{ cursor, username, pods, pending, fetchedAt }` — a SUPERSET
// of /api/users/:u/pods (same `pods[]` with `pendingRequests`, same `pending[]`
// with `phase`) plus an opaque `cursor`. We echo the last cursor back; the
// server HOLDS up to ~25s and returns the instant anything meaningful changes
// (or on timeout, with the same cursor). This collapses the many separate
// foreground pollers (home `/pods` re-poll, the boxInbox interval, the
// approval poll) into ONE canal that feeds the SAME shared state the views
// already read.
//
// Shape mirrors lib/aiChatAlerts.js's `startAiChatAlertPoll` (an `active()`-
// gated foreground loop with an injected fetcher + timers) and lib/boxInbox.js
// (a tiny observable the UI subscribes to). Everything is dependency-injected
// so the whole loop is unit-testable with an injected fetch — no real network, no
// DOM, no hang.
//
// GRACEFUL FALLBACK (critical): if /stream errors / is unreachable / returns
// non-200, the loop falls back to a plain periodic /pods poll (today's
// behavior). Behavior never degrades below the current state — /pods + the
// established pollers remain the safety net.

import { getSession } from "./state.js";
import { controlApex } from "./apex.js";
import { accountReadFetch } from "./accountRead.js";
import { rememberServerOrder } from "./serverOrder.js";
import { isAccountGone } from "./accountGone.js";

/** Jitter (± ms) applied to every reconnect so a fleet of tabs that all time
 *  out together don't reconnect in lockstep (thundering herd). */
export const LIVE_SYNC_JITTER_MS = 500;
/** Fallback cadence when /stream is unavailable — matches the prior home
 *  `/pods` re-poll feel (the safety net, not the happy path). */
export const LIVE_SYNC_FALLBACK_MS = 5_000;
/** The longest gap between retries while `.com` keeps failing. Each retry is a
 *  request the Free plan counts (and a 1102 means the Worker is already
 *  struggling), so a failing loop backs off instead of repeating every 5 s. */
export const LIVE_SYNC_MAX_BACKOFF_MS = 120_000;
/** While /pods still answers but /stream does not, the screen refreshes at most this slowly. */
export const LIVE_SYNC_PODS_ONLY_MAX_MS = 30_000;

/** The wait before retry number `streak` (1 = the first failure): the
 *  fallback cadence doubled each time, capped. */
export function liveSyncBackoffMs(streak, fallbackMs = LIVE_SYNC_FALLBACK_MS, maxMs = LIVE_SYNC_MAX_BACKOFF_MS) {
  const doublings = Math.max(0, Math.min(streak - 1, 16));
  return Math.min(maxMs, fallbackMs * 2 ** doublings);
}

/**
 * Fetch ONE live-sync snapshot. The client method (with its injectable fetch):
 * pass the last `cursor` you saw; the server returns immediately if anything
 * changed (or you sent none / a stale one), else holds and returns on the next
 * change or a ~25s timeout. Returns the parsed body `{ cursor, username, pods,
 * pending, fetchedAt }`, or throws on a transport / non-200 error (the caller's
 * loop catches it and falls back to /pods).
 *
 * @param {string|null|undefined} cursor  the last cursor seen (omit on first connect)
 * @param {{ fetch?: typeof fetch, comBase?: string, getSession?: Function, signal?: AbortSignal }} [deps]
 * @returns {Promise<{ cursor:string, username:string, pods:any[], pending:any[], fetchedAt?:number }>}
 */
export async function fetchLiveSync(cursor, deps = {}) {
  const session = deps.getSession ? deps.getSession() : getSession();
  const username = session?.username;
  if (!username) throw new Error("live-sync: no signed-in user");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const r = await accountReadFetch(
    `${comBase}/api/users/${encodeURIComponent(username)}/stream${q}`,
    { cache: "no-store", signal: deps.signal },
    { fetch: f, getSession: deps.getSession, baseUrl: comBase },
  );
  if (!r || !r.ok) throw liveSyncError(`live-sync: status ${r ? r.status : "none"}`, r);
  const body = await r.json();
  return {
    cursor: String(body?.cursor ?? ""),
    username: String(body?.username ?? username),
    pods: Array.isArray(body?.pods) ? body.pods : [],
    pending: Array.isArray(body?.pending) ? body.pending : [],
    serverOrder: body?.serverOrder ?? null,
    fetchedAt: body?.fetchedAt,
  };
}

/** An error that carries the refusing status and any `Retry-After` the server
 *  sent, so the loop can wait as long as it was told to. */
function liveSyncError(message, r) {
  const e = new Error(message);
  e.status = r ? r.status : 0;
  const ra = Number(r?.headers?.get?.("retry-after"));
  if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = ra * 1000;
  return e;
}

/** The fallback read when /stream is down: a plain /pods GET shaped like a
 *  stream snapshot (no cursor), with the same account read token. Throws on
 *  non-200 so the loop keeps retrying. */
async function fetchPodsFallback(deps = {}) {
  const session = deps.getSession ? deps.getSession() : getSession();
  const username = session?.username;
  if (!username) throw new Error("live-sync: no signed-in user");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  const r = await accountReadFetch(
    `${comBase}/api/users/${encodeURIComponent(username)}/pods`,
    { cache: "no-store" },
    { fetch: f, getSession: deps.getSession, baseUrl: comBase },
  );
  if (!r || !r.ok) throw liveSyncError(`live-sync: pods status ${r ? r.status : "none"}`, r);
  const body = await r.json();
  return {
    cursor: "", // /pods has no cursor — every fallback read is "fresh"
    username,
    pods: Array.isArray(body?.pods) ? body.pods : [],
    pending: Array.isArray(body?.pending) ? body.pending : [],
    serverOrder: body?.serverOrder ?? null,
    fetchedAt: body?.fetchedAt,
  };
}

/**
 * The app-scope LiveSync store + loop (mirrors createBoxInbox / ToastCenter:
 * a tiny observable + a foreground loop). The UI subscribes; on every snapshot
 * the loop emits `{ pods, pending }` so callers can drive AppState.pods + the
 * Box Request Inbox digest without re-fetching. The boxInbox is extended to be
 * FED by this store rather than running its own interval.
 *
 * Lifecycle is foreground-only + signed-in: the caller wires `active()` to
 * `document.hidden` + a session check; the loop holds while inactive and
 * resumes (with an immediate request) the moment `active()` goes true again.
 *
 * @param {object} deps
 * @param {() => boolean} [deps.active]   gate — only poll while this is true (focused + signed in)
 * @param {typeof fetch} [deps.fetch]
 * @param {string} [deps.comBase]
 * @param {Function} [deps.getSession]
 * @param {Function} [deps.setTimeout]
 * @param {Function} [deps.clearTimeout]
 * @param {number} [deps.jitterMs]
 * @param {number} [deps.fallbackMs]
 * @param {() => number} [deps.random]    injectable Math.random for deterministic jitter in tests
 */
export function createLiveSync(deps = {}) {
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const active = typeof deps.active === "function" ? deps.active : () => true;
  const jitterMs = typeof deps.jitterMs === "number" ? deps.jitterMs : LIVE_SYNC_JITTER_MS;
  const fallbackMs = typeof deps.fallbackMs === "number" ? deps.fallbackMs : LIVE_SYNC_FALLBACK_MS;
  const random = deps.random || Math.random;

  /** @type {{ pods:any[], pending:any[] }} */
  let snapshot = { pods: [], pending: [] };
  let cursor = null;
  const listeners = new Set();
  let handle = null;
  let stopped = false;
  /** Whether we are currently in /pods fallback mode (a prior /stream error). */
  let degraded = false;
  /** Consecutive failed rounds; the retry gap doubles with it. */
  let streak = 0;
  /** Whether the last /pods fallback answered, so a failing stream can lean on it. */
  let podsAnswered = true;

  function emit() {
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch {
        /* a bad listener must never break the loop */
      }
    }
  }

  /** A small ± jitter so reconnects after a herd of timeouts spread out. */
  function jitter() {
    return Math.round((random() - 0.5) * 2 * jitterMs);
  }

  /** One round-trip. Returns the delay (ms) before the next request. On a
   *  successful /stream read we re-request IMMEDIATELY (the long-poll holds
   *  server-side); on a fallback /pods read we wait `fallbackMs`. */
  async function tickOnce() {
    try {
      const snap = await fetchLiveSync(cursor, deps);
      // Recovered from a prior degraded state (or first success).
      degraded = false;
      streak = 0;
      podsAnswered = true;
      // Only re-emit + re-render on a genuine change. A timeout response
      // carries the SAME cursor, so a steady hold never churns the UI.
      const changed = snap.cursor !== cursor;
      cursor = snap.cursor;
      if (changed) {
        snapshot = { pods: snap.pods, pending: snap.pending };
        rememberServerOrder(snap.username, snap.serverOrder);
        emit();
      }
      // Long-poll: the server already held; reconnect right away (+ jitter so a
      // herd that timed out together doesn't reconnect in lockstep).
      return Math.max(0, jitter());
    } catch (err) {
      // /stream unreachable / non-200 → fall back to the plain /pods poll so
      // behavior never degrades below today's. Feed the shared state from it,
      // then wait before trying again (which re-attempts /stream first).
      degraded = true;
      streak += 1;
      // When /pods failed too (the service itself is failing: a 5xx such as
      // Cloudflare's 1102, or a 429), ask it only every fourth round, so an
      // outage is not hit twice a round.
      if (podsAnswered || streak === 1 || streak % 4 === 0) {
        try {
          const snap = await fetchPodsFallback(deps);
          snapshot = { pods: snap.pods, pending: snap.pending };
          rememberServerOrder(snap.username, snap.serverOrder);
          // /pods has no cursor; clear ours so the next /stream attempt connects
          // fresh and returns immediately with the current state.
          cursor = null;
          podsAnswered = true;
          emit();
          // /pods answered, so only /stream is failing: keep the screen fresh,
          // but not every 5 s for as long as the stream stays down.
          return Math.min(liveSyncBackoffMs(streak, fallbackMs), LIVE_SYNC_PODS_ONLY_MAX_MS) + Math.max(0, jitter());
        } catch {
          /* keep last-good snapshot — never blank the UI on a transient blip */
          podsAnswered = false;
        }
      }
      const told = typeof err?.retryAfterMs === "number" ? err.retryAfterMs : 0;
      return Math.max(told, liveSyncBackoffMs(streak, fallbackMs)) + Math.max(0, jitter());
    }
  }

  async function loop() {
    if (stopped) return;
    let delay = fallbackMs;
    if (active()) {
      delay = await tickOnce();
    } else {
      // Paused (backgrounded / signed out). Re-check soon and resume with an
      // immediate request the moment we're active again.
      delay = fallbackMs;
    }
    if (stopped) return;
    handle = setT(() => void loop(), delay);
  }

  return {
    /** Current snapshot `{ pods, pending }`. */
    get: () => snapshot,
    /** Whether the loop is currently in /pods fallback mode. */
    isDegraded: () => degraded,
    /** Subscribe; immediately receives the current snapshot. Returns unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      try {
        fn(snapshot);
      } catch {
        /* ignore */
      }
      return () => listeners.delete(fn);
    },
    /** Start the foreground loop (idempotent). Kicks the first request on a
     *  microtask so the caller isn't blocked. If the loop is already scheduled
     *  (`handle` live) this is a no-op; if it was stopped it restarts. */
    start() {
      stopped = false;
      if (handle != null) return; // already running / scheduled
      Promise.resolve().then(loop);
    },
    /** Stop the loop (sign-out / lock). */
    stop() {
      stopped = true;
      if (handle != null) {
        try {
          clearT(handle);
        } catch {
          /* ignore */
        }
        handle = null;
      }
    },
    /** One immediate poll, bypassing the active() gate (manual refresh / tests).
     *  Returns the resulting snapshot. */
    async refresh() {
      await tickOnce();
      return snapshot;
    },
  };
}

/** The app-scope singleton's foreground-only + signed-in gate: poll only while
 *  the tab is visible AND a user is signed in. Defined here so the exported
 *  singleton self-pauses on background/blur and on sign-out without app.js
 *  having to micro-manage start/stop. */
function defaultActive() {
  try {
    if (typeof document !== "undefined" && document.hidden) return false;
    if (isAccountGone()) return false;
    return !!getSession()?.username;
  } catch {
    return false;
  }
}

/**
 * The app-scope singleton (mirrors `activeOperations` / `ToastCenter`). app.js
 * `start()`s it once after boot; its `active` gate pauses it while the tab is
 * hidden (visibilitychange) or no user is signed in, and resumes (immediate
 * request) on focus / sign-in. Views read the shared state it feeds (Home +
 * boxInbox) — they never talk to it directly except to subscribe.
 */
export const liveSync = createLiveSync({ active: defaultActive });
