// Delivery of a signed envelope (docs/voici-and-messages.md §8): straight to the owner's phone when it holds its
// bare name, else the `.com` mailbox. Nothing here carries a cookie or a credential header: every request is
// authenticated by the envelope's own signature chain, so `credentials: "omit"` everywhere.
//
//   pingPhone(o) -> boolean                          GET https://<u>.<services>/api/phone/live (2 s)
//   deliverToPhone(envelope, o) -> {ok, ack}|{ok:false, code}
//   sendToMailbox(envelope, o) -> {ok}|{ok:false, code, retryAfterSec?}
//   deliverEnvelope(envelope, o) -> {ok, via:"phone"|"mailbox", ack?}|{ok:false, code, retryAfterSec?}
//   fetchThread(session, o) -> {ok, items, next}|{ok:false, code}   POST /api/voici/web/thread (§8.3)
//   postPageReport(body, o) / postWebDelegationRevoke(o)

import {
  PHONE_DELIVER_PATH,
  PHONE_ENVELOPE_CONTENT_TYPE,
  PHONE_LIVE_PATH,
  parsePhoneLiveAnswer,
  verifyVoiciAck,
} from "./proto/lib/voiciProtocol.js";
import { signVoiciThreadFetch } from "./envelope.js";
import { readCapped } from "./verify.js";

const NO_CREDS = { credentials: "omit", referrerPolicy: "no-referrer", mode: "cors", cache: "no-store" };
const USERNAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const ANSWER_CAP = 64 * 1024;
const THREAD_CAP = 4 * 1024 * 1024;

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function jsonOf(res, cap) {
  const b = await readCapped(res, cap);
  if (!b) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
  } catch {
    return null;
  }
}

/** The refusal of a `.com` answer: {code, retryAfterSec?}; codes only, the site writes the sentence. */
async function refusalOf(res) {
  const j = await jsonOf(res, ANSWER_CAP);
  const code = typeof j?.code === "string" && /^[a-z0-9-]{1,40}$/.test(j.code) ? j.code : res.status === 429 ? "rate-limited" : "unavailable";
  const out = { ok: false, code, status: res.status };
  if (Number.isSafeInteger(j?.retryAfterSec) && j.retryAfterSec > 0) out.retryAfterSec = j.retryAfterSec;
  return out;
}

function phoneBase(username, servicesApex) {
  if (!USERNAME.test(username) || !HOST.test(servicesApex)) throw new Error("flagship-web: bad phone name");
  return `https://${username}.${servicesApex}`;
}

/**
 * Is the owner's app live on its bare name, holding the page we verified? o = {username, servicesApex, ownerSignPub,
 * fetch?, timeoutMs = 2000}. Anything but `{live:true, account:<u>, ownerSignPub:<the page's>}` is "no".
 */
export async function pingPhone(o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const t = withTimeout(o.timeoutMs ?? 2000);
  try {
    const res = await f(phoneBase(o.username, o.servicesApex) + PHONE_LIVE_PATH, { ...NO_CREDS, method: "GET", signal: t.signal });
    if (res.status !== 200) return false;
    const a = parsePhoneLiveAnswer(await jsonOf(res, 4096));
    return !!a && a.account === o.username && a.ownerSignPub === o.ownerSignPub;
  } catch {
    return false;
  } finally {
    t.done();
  }
}

/**
 * POST the envelope to the phone (the content type is not CORS-simple, so a preflight always runs). The answer's ack
 * must verify under the page's ownerSignPub for this msgId and conv: that signature is the browser's only proof of
 * delivery (§8.2). o = {username, servicesApex, ownerSignPub, fetch?, timeoutMs = 8000}.
 */
export async function deliverToPhone(envelope, o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const t = withTimeout(o.timeoutMs ?? 8000);
  try {
    const res = await f(phoneBase(o.username, o.servicesApex) + PHONE_DELIVER_PATH, {
      ...NO_CREDS,
      method: "POST",
      headers: { "content-type": PHONE_ENVELOPE_CONTENT_TYPE },
      body: JSON.stringify(envelope),
      signal: t.signal,
    });
    if (res.status !== 200) return refusalOf(res);
    const j = await jsonOf(res, ANSWER_CAP);
    const ack = j && typeof j === "object" ? verifyVoiciAck(j.ack, o.ownerSignPub, { msgId: envelope.msgId, conv: envelope.conv }) : null;
    return ack ? { ok: true, ack } : { ok: false, code: "bad-ack" };
  } catch {
    return { ok: false, code: "unreachable" };
  } finally {
    t.done();
  }
}

/** POST <apiBase>/api/voici/web/send. Any 2xx is "Sent" (a blocked sender also sees it: no oracle, §9.1). */
export async function sendToMailbox(envelope, o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await f(`${o.apiBase}/api/voici/web/send`, {
      ...NO_CREDS,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (res.ok) return { ok: true };
    return refusalOf(res);
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

/**
 * Direct first when the phone answered the live ping, the mailbox otherwise or when the direct try fails. A refusal
 * from the phone that is about the message itself (not reachability) is not retried through the mailbox, which would
 * refuse it for the same reason. o = {username, servicesApex, ownerSignPub, apiBase, live?: boolean, fetch?}.
 */
export async function deliverEnvelope(envelope, o) {
  const live = o.live ?? (await pingPhone(o));
  if (live) {
    const d = await deliverToPhone(envelope, o);
    if (d.ok) return { ok: true, via: "phone", ack: d.ack };
    if (d.status === 400 || d.status === 413 || d.status === 415) return d;
  }
  const m = await sendToMailbox(envelope, o);
  return m.ok ? { ok: true, via: "mailbox" } : m;
}

function threadItemOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || !v.envelope || typeof v.envelope !== "object") return null;
  const t = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
  return { envelope: v.envelope, storedAt: t(v.storedAt), fetchedAt: t(v.fetchedAt), direct: v.direct === true };
}

/**
 * The visitor's thread with one page, both directions, since a cursor (§8.3). Signed with B; `.com` checks the cred.
 * Answer `{items:[{envelope, storedAt, fetchedAt|null, direct}], next}`; every envelope still has to pass
 * verifyThreadItem before anything of it is shown. o = {apiBase, since?, fetch?}.
 */
export async function fetchThread(session, o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const body = await signVoiciThreadFetch(session, { since: o.since ?? "" });
    const res = await f(`${o.apiBase}/api/voici/web/thread`, {
      ...NO_CREDS,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return refusalOf(res);
    const j = await jsonOf(res, THREAD_CAP);
    if (!j || !Array.isArray(j.items)) return { ok: false, code: "malformed" };
    const items = j.items.map(threadItemOf).filter(Boolean);
    const next = typeof j.next === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(j.next) ? j.next : o.since ?? "";
    return { ok: true, items, next };
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

/** POST <apiBase>/api/voici/reports with a body from buildPageReport. */
export async function postPageReport(body, o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await f(`${o.apiBase}/api/voici/reports`, {
      ...NO_CREDS,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok ? { ok: true } : refusalOf(res);
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

/**
 * POST <apiBase>/api/voici/web/revoke {revoke:{delegatePub, issuedAt}, signature} (§6.4). The signature is by the
 * pseudonym key P, which only the visitor's app holds: a website cannot revoke on its own (it forgets instead,
 * signIn.js signOut); an app or the webapp calls this.
 */
export async function postWebDelegationRevoke(o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await f(`${o.apiBase}/api/voici/web/revoke`, {
      ...NO_CREDS,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revoke: o.revoke, signature: o.signature }),
    });
    return res.ok ? { ok: true } : refusalOf(res);
  } catch {
    return { ok: false, code: "unreachable" };
  }
}
