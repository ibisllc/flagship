// Abuse notices and suspension (docs/abuse-handling.md §4-§5): the state, the models, the network. No screen.
//
// `.com` keeps an operator's notices to this account (what was reported, why, what to do, by when) and whether the
// account is suspended; only the account's own devices read them, with the account read token
// (GET /api/users/<u>/abuse-notices). An admin device marks a notice done with a signed note,
// `flagship/abuse-notice-done/v1` (wire parity with packages/protocol/src/abuseNotice.ts, pinned by
// packages/protocol/test-vectors/abuse-notice-done/vectors.json), signed with the sensitive-order key.
//
//   flagship/abuse-notice-done/v1|<username lowercase>|<noticeId>|<sha256 hex of the UTF-8 note>|<issuedAt>

import { controlApex } from "./apex.js";
import { accountReadFetch } from "./accountRead.js";
import { canSignAdminOrders } from "./addServerGate.js";
import { sensitiveSigner } from "./adminRoot.js";
import { getSession } from "./state.js";
import { formatDateTime } from "./dateFormat.js";

import { tr } from "./i18n.js";

export const ABUSE_NOTICE_DONE_TAG = "flagship/abuse-notice-done/v1";
export const ABUSE_NOTICE_NOTE_MAX = 1000;
export const APPEAL_EMAIL = "abuse@flagship.services";

export const ABUSE_COPY = Object.freeze({
  bannerTitle: tr("Action needed on your account"),
  about: (subject) => tr("We received a report about {0}.", subject),
  reason: (label) => tr("Reason: {0}", label),
  modify: tr("What to do: change it so it follows our rules."),
  takeDown: tr("What to do: take it down."),
  deadline: (when) => tr("Deadline: {0}", when),
  warning: tr("If it is still there after the deadline, this account can be suspended."),
  done: tr("I've done this"),
  appeal: tr("Appeal"),
  doneTitle: tr("Tell us what you changed"),
  notePlaceholder: tr("What you changed (optional)"),
  send: tr("Send"),
  markedDone: (when) => tr("Marked done on {0}. We will check it.", when),
  notAdmin: tr("Only an admin device can do this."),
  sendFailed: tr("Couldn't send. Try again."),
  suspendedTitle: tr("This account was suspended"),
  suspendedOffline: tr("Your servers are offline to the internet and the account can't add servers or change names until this is resolved."),
  suspendedData: tr("Your data stays on your own server. You can still back it up and move it over your home network, and start again under a new name."),
  suspendedAppeal: tr("If you think this is a mistake, write to abuse@flagship.services. We answer appeals within 14 days."),
  continueToData: tr("Continue to my data"),
  suspendedBanner: tr("This account is suspended."),
  details: tr("Details"),
});

export const CATEGORY_LABELS = Object.freeze({
  spam: tr("Spam"),
  phishing: tr("Phishing"),
  "active-phishing": tr("Active phishing"),
  malware: tr("Malware"),
  csam: tr("Child sexual abuse material"),
  harassment: tr("Harassment"),
  impersonation: tr("Impersonation"),
  copyright: tr("Copyright infringement"),
  illegal: tr("Illegal content"),
  other: tr("Other"),
});

export function categoryLabel(c) {
  return CATEGORY_LABELS[c] ?? CATEGORY_LABELS.other;
}

const NOTICE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const enc = (s) => new TextEncoder().encode(s);
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(s) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc(s))));
}

export async function canonicalAbuseNoticeDone(d) {
  const username = typeof d.username === "string" ? d.username.toLowerCase() : "";
  if (!USERNAME.test(username)) throw new Error("username");
  if (typeof d.noticeId !== "string" || !NOTICE_ID.test(d.noticeId)) throw new Error("noticeId");
  if (typeof d.note !== "string" || d.note.length > ABUSE_NOTICE_NOTE_MAX) throw new Error("note");
  if (!Number.isSafeInteger(d.issuedAt) || d.issuedAt <= 0) throw new Error("issuedAt");
  return enc([ABUSE_NOTICE_DONE_TAG, username, d.noticeId, await sha256Hex(d.note), String(d.issuedAt)].join("|"));
}

// ── state ────────────────────────────────────────────────────────────────

/** @type {{ notices: any[], suspension: any | null, username: string | null }} */
let state = { notices: [], suspension: null, username: null };
const listeners = new Set();

export function abuseState() {
  return state;
}

export function onAbuseStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setAbuseState(next) {
  state = { notices: Array.isArray(next.notices) ? next.notices : [], suspension: next.suspension ?? null, username: next.username ?? null };
  for (const fn of listeners) {
    try { fn(state); } catch { /* a listener never breaks a refresh */ }
  }
}

/** Shape check of `.com`'s answer; anything unexpected reads as nothing to show. */
export function parseAbuseAnswer(body) {
  const notices = (Array.isArray(body?.notices) ? body.notices : []).filter(
    (n) => n && NOTICE_ID.test(n.id) && typeof n.subject === "string" && typeof n.deadlineAt === "number",
  );
  const s = body?.suspension;
  const suspension = s && typeof s.suspendedAt === "number" && typeof s.reason === "string" ? s : null;
  return { notices, suspension };
}

/** Read this account's notices; failures leave the last answer as it was. */
export async function refreshAbuseNotices(deps = {}) {
  const session = (deps.getSession ?? getSession)();
  const username = String(session?.username ?? "").toLowerCase();
  if (!USERNAME.test(username)) return state;
  try {
    const r = await (deps.fetch ?? accountReadFetch)(`${deps.baseUrl ?? controlApex()}/api/users/${encodeURIComponent(username)}/abuse-notices`, { method: "GET" });
    if (!r.ok) return state;
    setAbuseState({ ...parseAbuseAnswer(await r.json()), username });
  } catch {
    /* silent: a notice is shown on the next read */
  }
  return state;
}

// ── models ───────────────────────────────────────────────────────────────

/** The Home banners: admin devices only, newest first, one per open (or recently done) notice. */
export function noticeBannerModels(notices, { isAdmin, formatDate = formatDateTime } = {}) {
  if (!isAdmin) return [];
  return notices.map((n) => ({
    id: n.id,
    title: ABUSE_COPY.bannerTitle,
    about: ABUSE_COPY.about(n.subject),
    reason: ABUSE_COPY.reason(categoryLabel(n.category)),
    action: n.action === "take-down" ? ABUSE_COPY.takeDown : ABUSE_COPY.modify,
    deadline: ABUSE_COPY.deadline(formatDate(n.deadlineAt)),
    warning: ABUSE_COPY.warning,
    detail: typeof n.detail === "string" ? n.detail : "",
    doneLine: typeof n.doneAt === "number" ? ABUSE_COPY.markedDone(formatDate(n.doneAt)) : null,
    canMarkDone: typeof n.doneAt !== "number",
  }));
}

export function appealHref(username) {
  return `mailto:${APPEAL_EMAIL}?subject=${encodeURIComponent(`Appeal (${username ?? ""})`)}`;
}

/** The suspended screen, for every device of the account. */
export function suspendedModel(suspension, username) {
  if (!suspension) return null;
  return {
    title: ABUSE_COPY.suspendedTitle,
    reason: ABUSE_COPY.reason(categoryLabel(suspension.category)),
    detail: suspension.reason,
    offline: ABUSE_COPY.suspendedOffline,
    data: ABUSE_COPY.suspendedData,
    appealText: ABUSE_COPY.suspendedAppeal,
    appeal: ABUSE_COPY.appeal,
    appealHref: appealHref(username),
    continueLabel: ABUSE_COPY.continueToData,
  };
}

export function showsNoticeBanners(session = getSession()) {
  return canSignAdminOrders(session);
}

// ── marking a notice done ──────────────────────────────────────────────

/**
 * POST the signed "done". Returns `{ ok: true, doneAt }` or `{ ok: false, message }` with the sentence to show.
 * `deps.sign(umk, bytes)` defaults to the sensitive-order signer (admin root, else IRK).
 */
export async function markNoticeDone(noticeId, note, deps = {}) {
  const session = (deps.getSession ?? getSession)();
  const username = String(session?.username ?? "").toLowerCase();
  const done = { username, noticeId, note: String(note ?? "").slice(0, ABUSE_NOTICE_NOTE_MAX), issuedAt: (deps.now ?? Date.now)() };
  try {
    const bytes = await canonicalAbuseNoticeDone(done);
    const sig = await (deps.sign ?? sensitiveSigner())(session?.umk, bytes);
    const r = await (deps.fetch ?? globalThis.fetch)(
      `${deps.baseUrl ?? controlApex()}/api/users/${encodeURIComponent(username)}/abuse-notices/${noticeId}/done`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: done, signature: toHex(sig) }) },
    );
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      setAbuseState({ ...state, notices: state.notices.map((n) => (n.id === noticeId ? { ...n, doneAt: body.doneAt, doneNote: done.note } : n)) });
      return { ok: true, doneAt: body.doneAt };
    }
    return { ok: false, message: body.code === "not-admin" ? ABUSE_COPY.notAdmin : ABUSE_COPY.sendFailed };
  } catch {
    return { ok: false, message: ABUSE_COPY.sendFailed };
  }
}
