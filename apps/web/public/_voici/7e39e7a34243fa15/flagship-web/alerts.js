// Opt-in reply alerts (the "Alerts:" note in docs/voici-and-messages.md §8.3): after a visitor has sent a message,
// they may ask for a Web Push when the owner replies. Never asked on page load: enableReplyAlerts runs only from a tap
// (browsers allow the permission prompt only inside a user gesture anyway).
//
// The subscription goes to `.com` bound to one conversation, authorised like a thread fetch: the browser key B signs
// flagship/voici-alerts/v1|<conv>|<on|off>|<SHA-256 hex of the endpoint>|<issuedAt>, and the message cred binds B to
// the pseudonym whose conversation it is. Nothing names the visitor's account. The push itself carries only the page's
// username (RFC 8291-encrypted to this browser); the service worker (the site's sw.js, registered with a scope no page
// lives under, so it controls no page) shows a fixed sentence the site stored and opens voi.ci/<username>.
//
//   replyAlertsSupported(win?) -> boolean
//   canonicalVoiciAlerts(o) -> bytes                     o = {conv, op:"on"|"off", endpointHash, issuedAt}
//   buildVoiciAlertsOrder(session, o) -> body            POST /api/voici/web/alerts body
//   enableReplyAlerts(o) -> {ok}|{ok:false, code}         codes: unsupported, denied, dismissed, unavailable, ...
//   disableReplyAlerts(o) -> {ok}|{ok:false, code}
//   replyAlertsOn(store, pageId) -> boolean               this browser asked for this page's alerts

import { hex, isLowerHex, voiciConv } from "./proto/lib/voiciProtocol.js";
import { messageCred, signP256 } from "./envelope.js";

const enc = (s) => new TextEncoder().encode(s);
const NO_CREDS = { credentials: "omit", referrerPolicy: "no-referrer", mode: "cors", cache: "no-store" };

export const TAG_VOICI_ALERTS = "flagship/voici-alerts/v1";
/** The service worker (served by `.com` as the current build's sw.js) and its scope: no page of the site is under it. */
export const ALERTS_SW_URL = "/_/sw.js";
export const ALERTS_SCOPE = "/_/alerts/";
/** Store keys: the notification text the service worker shows ({title, body, icon?}), and "alerts on" per page. */
export const ALERTS_NOTICE_KEY = "voici-alerts:notice";
const ON_PREFIX = "voici-alerts:on:";
const alertsOnKey = (pageId) => ON_PREFIX + pageId;

export function replyAlertsSupported(win = globalThis) {
  try {
    return !!(win.navigator?.serviceWorker && win.PushManager && win.Notification && win.isSecureContext !== false);
  } catch {
    return false;
  }
}

/** flagship/voici-alerts/v1|<conv>|<on|off>|<endpointHash>|<issuedAt>; the same bytes as @flagship/protocol's. */
export function canonicalVoiciAlerts(o) {
  if (!isLowerHex(o.conv, 32) || (o.op !== "on" && o.op !== "off") || !isLowerHex(o.endpointHash, 32) || !Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) {
    throw new Error(`${TAG_VOICI_ALERTS}: bad field`);
  }
  return enc([TAG_VOICI_ALERTS, o.conv, o.op, o.endpointHash, String(o.issuedAt)].join("|"));
}

export async function endpointHashOf(endpoint, subtle = globalThis.crypto.subtle) {
  return hex(new Uint8Array(await subtle.digest("SHA-256", enc(endpoint))));
}

/**
 * The body of POST /api/voici/web/alerts: {conv, op, endpoint, issuedAt, sig, cred, subscription?}. o = {op,
 * subscription: {endpoint, keys:{p256dh, auth}} (on) | endpoint (off), issuedAt?}.
 */
export async function buildVoiciAlertsOrder(session, o) {
  const endpoint = o.op === "on" ? o.subscription?.endpoint : o.endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) throw new Error("flagship-web: bad push endpoint");
  const order = { conv: voiciConv(session.pageId, session.pseudonymPub), op: o.op, endpointHash: await endpointHashOf(endpoint), issuedAt: o.issuedAt ?? Date.now() };
  const body = {
    conv: order.conv,
    op: order.op,
    endpoint,
    issuedAt: order.issuedAt,
    sig: await signP256(session.privateKey, canonicalVoiciAlerts(order)),
    cred: messageCred(session),
  };
  if (o.op === "on") body.subscription = { endpoint, keys: { p256dh: o.subscription.keys?.p256dh, auth: o.subscription.keys?.auth } };
  return body;
}

function b64UrlBytes(s) {
  const t = String(s).replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const sameKey = (a, b) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

async function postOrder(body, o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await f(`${o.apiBase}/api/voici/web/alerts`, { ...NO_CREDS, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    let code = res.status === 429 ? "rate-limited" : "unavailable";
    try {
      const j = await res.json();
      if (typeof j?.code === "string" && /^[a-z0-9-]{1,40}$/.test(j.code)) code = j.code;
    } catch {
      /* the status decides */
    }
    return { ok: false, code };
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

/** The registration's worker once it is active (pushManager.subscribe needs one; `.ready` would wait for a page in scope). */
function activated(reg) {
  if (reg.active) return Promise.resolve(reg);
  const w = reg.installing ?? reg.waiting;
  if (!w) return Promise.reject(new Error("flagship-web: no service worker"));
  return new Promise((resolve, reject) => {
    w.addEventListener("statechange", () => {
      if (w.state === "activated") resolve(reg);
      else if (w.state === "redundant") reject(new Error("flagship-web: service worker failed"));
    });
  });
}

/**
 * Asks for notification permission (call from a tap), registers the alerts service worker, subscribes with `.com`'s
 * VAPID key, stores the notification text for the worker, and binds the subscription to this conversation on `.com`.
 * o = {session, apiBase, store, notice: {title, body, icon?}, win?, fetch?}.
 */
export async function enableReplyAlerts(o) {
  const win = o.win ?? globalThis;
  if (!replyAlertsSupported(win)) return { ok: false, code: "unsupported" };
  let perm;
  try {
    perm = await win.Notification.requestPermission();
  } catch {
    return { ok: false, code: "unsupported" };
  }
  if (perm === "denied") return { ok: false, code: "denied" };
  if (perm !== "granted") return { ok: false, code: "dismissed" };
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  let key;
  try {
    const res = await f(`${o.apiBase}/api/voici/web/alert-key`, { ...NO_CREDS, method: "GET" });
    const j = res.ok ? await res.json() : null;
    if (typeof j?.key !== "string" || !/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(j.key)) return { ok: false, code: "unavailable" };
    key = b64UrlBytes(j.key);
  } catch {
    return { ok: false, code: "unreachable" };
  }
  let sub;
  try {
    await o.store.put(ALERTS_NOTICE_KEY, { title: String(o.notice.title), body: String(o.notice.body), ...(o.notice.icon ? { icon: String(o.notice.icon) } : {}) });
    const reg = await activated(await win.navigator.serviceWorker.register(ALERTS_SW_URL, { scope: ALERTS_SCOPE, updateViaCache: "none" }));
    const existing = await reg.pushManager.getSubscription();
    if (existing && !sameKey(existing.options?.applicationServerKey, key)) await existing.unsubscribe();
    sub = existing && sameKey(existing.options?.applicationServerKey, key) ? existing : await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    return { ok: false, code: "unsupported" };
  }
  const json = sub.toJSON();
  const body = await buildVoiciAlertsOrder(o.session, { op: "on", subscription: { endpoint: sub.endpoint, keys: json.keys ?? {} } });
  const r = await postOrder(body, o);
  if (r.ok) await o.store.put(alertsOnKey(o.session.pageId), { endpoint: sub.endpoint, at: Date.now() });
  return r;
}

/**
 * Unbinds this browser's subscription from this conversation on `.com` and forgets it here. The browser-level
 * subscription is dropped only when no other page's alerts use it. o = {session, apiBase, store, win?, fetch?}.
 */
export async function disableReplyAlerts(o) {
  const win = o.win ?? globalThis;
  const saved = await o.store.get(alertsOnKey(o.session.pageId));
  let reg = null;
  let sub = null;
  try {
    reg = (await win.navigator?.serviceWorker?.getRegistration(ALERTS_SCOPE)) ?? null;
    sub = reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    sub = null;
  }
  const endpoint = sub?.endpoint ?? saved?.endpoint;
  let r = { ok: true };
  if (typeof endpoint === "string") r = await postOrder(await buildVoiciAlertsOrder(o.session, { op: "off", endpoint }), o);
  if (!r.ok && r.code !== "revoked" && r.code !== "bad-delegation" && r.code !== "bad-attestation") return r;
  await o.store.delete(alertsOnKey(o.session.pageId));
  if (sub && (await o.store.keys(ON_PREFIX)).length === 0) await sub.unsubscribe().catch(() => false);
  return { ok: true };
}

export async function replyAlertsOn(store, pageId) {
  try {
    return !!(await store.get(alertsOnKey(pageId)));
  } catch {
    return false;
  }
}
