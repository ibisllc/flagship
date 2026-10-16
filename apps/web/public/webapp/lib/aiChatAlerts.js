// #91 — AI-chat alerts: foreground long-poll → app-initiated LOCAL
// notification → teal operations sliver.
//
// The AI build chat (vibe-code / scratch) pauses when the model asks the
// owner a question (`talkToUser`) or requests an env var (`requestEnvVar`).
// The daemon queues a VALUE-FREE `ai-chat-needs-you` event on the
// phone-pollable AlertInbox (GET /api/phone/alerts) at that transition — the
// SAME outbox the rest of the daemon→phone events ride (Flagship's "phone
// always initiates" invariant: the box never pushes; the app drains the
// queue). This module is the webapp's drain loop:
//
//   1. GET /api/phone/alerts?since=<cursor> on a foreground interval.
//   2. For each `ai-chat-needs-you` envelope:
//        - upsert a build op into the operations sliver (deep-links to the
//          chat at that session, on the server the alert came from), and
//        - raise a LOCAL notification (once per session+tool) so the owner
//          sees it even when not looking at the sliver.
//   3. Advance the cursor and ACK the drained range so the queue doesn't
//      re-deliver.
//
// Pure + injectable (mirrors lib/companionRequestsClient.js's pollPending):
// the fetcher, the notifier, the operations center, and the timer are all
// dependency-injected so the whole loop is unit-testable with no DOM, no
// real Notification API, and no network. app.js wires the live deps + starts
// the loop on unlock / stops it on lock.

import { screensFetch } from "./api.js";
import { activeOperations } from "./activeOperations.js";

/** The discriminator for the AI-chat-needs-you alert variant on the box. */
export const AI_CHAT_ALERT_KIND = "ai-chat-needs-you";

/**
 * The notification copy for an AI-chat alert. Value-free — driven only by
 * the pending tool kind, never the model's text or the env-var value (the
 * human-readable question is fetched over the paired-session BFF when the
 * owner opens the chat).
 * @param {{request?: string}} alert
 */
export function aiChatAlertBody(alert) {
  return alert && alert.request === "requestEnvVar"
    ? "The AI needs an environment variable to continue."
    : "The AI is asking you a question.";
}

/**
 * The webapp link that opens the build chat at an alert's session, naming the
 * server it came from so the chat signs and sends to that box.
 * @param {{sessionId:string, server?:string}} n
 */
export function aiChatDeepLink(n) {
  const server = n && n.server ? `&server=${encodeURIComponent(n.server)}` : "";
  return `/?view=vibecode-chat&sessionId=${encodeURIComponent(n.sessionId)}${server}`;
}

/**
 * Upsert the paused session into the operations sliver. The sliver reads the
 * ActiveOperationsCenter, so this is what makes "the AI build is waiting on
 * you" ride along across navigation with a tap that opens the chat. The op
 * is keyed by the session id (build-namespaced internally) so the live build
 * feeder and this alert feeder reconcile on the same op rather than dueling.
 * @param {object} alert  an `ai-chat-needs-you` envelope's `.alert`
 * @param {{ operations?: object }} deps
 */
export function surfaceAiChatOperation(alert, deps = {}) {
  const ops = deps.operations || activeOperations;
  const sessionId = alert.serviceId;
  ops.upsertBuild(sessionId, "AI build", null, {
    view: "view-vibecode-chat",
    params: alert.server ? { sessionId, server: alert.server } : { sessionId },
  });
}

/**
 * Drain the phone alert queue ONCE: fetch since the cursor, act on every
 * `ai-chat-needs-you` envelope, ACK the drained range, and return the new
 * cursor + the count acted on. Pure beyond the injected fetcher / notifier /
 * operations center. Non-fatal: a transport blip throws to the caller's tick
 * (which swallows + retries); a malformed body is treated as "no events".
 *
 * @param {object} args
 * @param {number} args.since                 the last-seen alert id (cursor)
 * @param {string} [args.server]               the box the fetcher reaches (tags each alert)
 * @param {(alert:object)=>void} [args.notify] raise a local notification
 * @param {object} [args.operations]          the ActiveOperationsCenter
 * @param {(path:string, init?:object)=>Promise<any>} [args.fetcher] screensFetch shim
 * @returns {Promise<{ cursor:number, handled:number, alerts:object[] }>}
 */
export async function drainAiChatAlertsOnce(args) {
  const fetcher = args.fetcher || screensFetch;
  const notify = typeof args.notify === "function" ? args.notify : () => {};
  const since = Number.isFinite(args.since) ? args.since : 0;

  const body = await fetcher(`/api/phone/alerts?since=${encodeURIComponent(since)}`);
  const events = Array.isArray(body && body.events) ? body.events : [];
  if (events.length === 0) return { cursor: since, handled: 0, alerts: [] };

  let cursor = since;
  let handled = 0;
  const alerts = [];
  for (const env of events) {
    if (env && typeof env.id === "number" && env.id > cursor) cursor = env.id;
    const alert = env && env.alert;
    // An app reached its disk limit: "An app on this server is full" (opens its page).
    if (alert && alert.kind === "app-storage-full" && typeof alert.serviceId === "string") {
      const tagged = args.server ? { ...alert, server: args.server } : alert;
      try {
        args.onStorageFull?.(tagged);
      } catch {
        /* a bad presenter must not wedge the drain */
      }
      handled += 1;
      continue;
    }
    if (!alert || alert.kind !== AI_CHAT_ALERT_KIND) continue;
    if (typeof alert.serviceId !== "string" || alert.serviceId.length === 0) continue;
    const tagged = args.server ? { ...alert, server: args.server } : alert;
    surfaceAiChatOperation(tagged, { operations: args.operations });
    alerts.push(tagged);
    try {
      notify(tagged);
    } catch {
      /* a bad notifier must not wedge the drain */
    }
    handled += 1;
  }

  // ACK the whole drained range so the box drops them (it's a bounded
  // queue; an un-acked alert would re-deliver every tick + re-notify). The
  // ack is best-effort: a failure just means we re-drain next tick, and the
  // notifier is dedup-guarded so a re-drain won't double-notify.
  if (cursor > since) {
    try {
      await fetcher("/api/phone/alerts/ack", {
        method: "POST",
        body: JSON.stringify({ throughId: cursor }),
      });
    } catch {
      /* best-effort — re-drained next tick */
    }
  }
  return { cursor, handled, alerts };
}

/**
 * Make a local-notification raiser that shows ONE notification per
 * (sessionId, toolUseId) and routes a tap to the chat. Dedup keeps a
 * re-drain (e.g. after a failed ack) from re-notifying. The actual
 * presentation is injected (`show`) so this is testable without a real
 * Notification / service worker; app.js supplies the live presenter.
 *
 * @param {object} deps
 * @param {(args:{title:string, body:string, tag:string, sessionId:string})=>void} deps.show
 * @returns {(alert:object)=>void}
 */
export function makeAiChatNotifier(deps) {
  const show = deps.show;
  const seen = new Set();
  return (alert) => {
    const sessionId = alert.serviceId;
    const tag = `flagship-ai-chat-${sessionId}-${alert.toolUseId ?? ""}`;
    if (seen.has(tag)) return;
    seen.add(tag);
    show({
      title: "Flagship",
      body: aiChatAlertBody(alert),
      tag,
      sessionId,
      ...(alert.server ? { server: alert.server } : {}),
    });
  };
}

/**
 * Start the foreground long-poll loop. Polls every `intervalMs` (default 5s,
 * matching the boot-approval / companion poll cadence), drains the AI-chat
 * alerts, and keeps the cursor across ticks. Returns a stop() handle the
 * caller invokes on lock / sign-out. Errors per tick are swallowed (transport
 * blips) — the cursor only advances on a successful drain, so a missed tick
 * re-drains next time.
 *
 * @param {object} deps
 * @param {(alert:object)=>void} [deps.notify]
 * @param {object} [deps.operations]
 * @param {(path:string, init?:object)=>Promise<any>} [deps.fetcher]
 * @param {() => string} [deps.server]  the box the fetcher reaches right now
 * @param {number} [deps.intervalMs]
 * @param {() => boolean} [deps.active]  gate — only drain while this returns true
 * @param {(alert:object)=>void} [deps.open]  open the chat an alert names (after a wake)
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setTimeout]
 * @param {Function} [deps.clearTimeout]
 * @returns {(() => void) & { wake: () => Promise<void> }} stop handle; `wake()`
 *   drains at once and opens the first waiting chat it finds
 */
export function startAiChatAlertPoll(deps = {}) {
  const interval = typeof deps.intervalMs === "number" ? deps.intervalMs : 5_000;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const active = typeof deps.active === "function" ? deps.active : () => true;
  let handle = null;
  let stopped = false;
  let cursor = 0;
  // Set by a content-free push (the box's "a build needs you" wake): the next
  // drain that finds a waiting chat opens it instead of only listing it.
  let openNext = false;
  let wokeAt = 0;
  let draining = null;
  // The newest chat a drain surfaced, so a push tapped after the foreground
  // poll already drained its alert still opens that chat.
  let last = null;
  const now = deps.now || Date.now;

  const drain = async () => {
    if (!active()) return;
    try {
      const r = await drainAiChatAlertsOnce({
        since: cursor,
        notify: deps.notify,
        operations: deps.operations,
        fetcher: deps.fetcher,
        server: typeof deps.server === "function" ? deps.server() : undefined,
        onStorageFull: deps.storageFull,
      });
      cursor = r.cursor;
      if (r.alerts.length > 0) last = { alert: r.alerts[0], at: now() };
      if (openNext && r.alerts.length > 0 && now() - wokeAt < RECENT_ALERT_MS) {
        openNext = false;
        openAlert(r.alerts[0]);
      }
    } catch {
      /* transport blip — keep the cursor, retry next tick */
    }
  };
  const openAlert = (alert) => {
    try {
      deps.open?.(alert);
    } catch {
      /* opening is a courtesy; the sliver still holds the op */
    }
  };
  const drainOnce = () => {
    if (!draining) draining = drain().finally(() => { draining = null; });
    return draining;
  };

  const tick = async () => {
    if (stopped) return;
    if (active()) await drainOnce();
    if (stopped) return;
    handle = setT(tick, interval);
  };
  // Kick the first tick on a microtask so the caller isn't blocked.
  Promise.resolve().then(tick);

  const stop = () => {
    stopped = true;
    if (handle != null) {
      try {
        clearT(handle);
      } catch {
        /* ignore */
      }
      handle = null;
    }
  };
  stop.wake = async () => {
    if (stopped) return;
    openNext = true;
    wokeAt = now();
    if (draining) await draining;
    // Locked (or not paired yet): the first drain after unlock opens it.
    if (!active()) return;
    await drainOnce();
    if (!openNext) return;
    openNext = false;
    if (last && now() - last.at < RECENT_ALERT_MS) openAlert(last.alert);
  };
  return stop;
}

/** How long a drained alert still counts as the reason for a tapped push. */
export const RECENT_ALERT_MS = 15 * 60_000;

/** What the service worker posts to an open webapp when a content-free push is
 *  tapped: the box sends the same `generic` push for an access request and for
 *  a build that needs the owner, so the page checks both. */
export const AI_CHAT_SW_MESSAGE = "AI_CHAT_ALERTS";
