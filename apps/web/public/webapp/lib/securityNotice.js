// Security notices (docs/security-notices.md): the browser-JS port of
// packages/protocol/src/securityNotice.ts, plus the fetch, the cache and the
// poller. The shared vectors packages/protocol/test-vectors/security-notice
// pin both ports to the same canonical bytes and the same decisions.
//
// A notice is signed OFFLINE by the cold ca-track maintainer key, never by
// `.com`. This file accepts one only when its signer is the ca-track
// authority at THIS device's clock, found by walking the ca-track mandate log
// forward from the baked pin (lib/maintainerTrust.js). Everything else fails
// OPEN: an unreachable endpoint, a bad signature, an expired or malformed
// notice, or an authority that cannot be established locks nothing. The
// request is one anonymous GET with no cookie, no identifier and no version;
// the app decides locally whether the notice is about it.

import { currentAuthority, edVerify, verifyMandateChainFromPin } from "./maintainerTrust.js";
import { BAKED_PIN } from "./serverTrust.js";
import { controlApex } from "./apex.js";
import { clientIdentity } from "./buildInfo.js";
import { setUpdateLocked } from "./updateLock.js";

import { dateLocale } from "./i18n.js";
export const TAG_SECURITY_NOTICE = "flagship/security-notice/v1";
export const SECURITY_NOTICE_MAX_WINDOW_MS = 30 * 24 * 3600_000;
export const SECURITY_NOTICE_MAX_MESSAGE = 280;
export const SECURITY_NOTICE_MAX_REASON = 160;
export const SECURITY_NOTICE_PATH = "/api/notices";
export const STORE_KEY = "flagship.securityNotice.v1";

const KINDS = ["none", "maintenance", "update-advisory", "update-required"];
const PLATFORMS = ["android", "ios", "web"];
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class SecurityNoticeError extends Error {
  constructor(code) {
    super(`${TAG_SECURITY_NOTICE}: ${code}`);
    this.name = "SecurityNoticeError";
    this.code = code;
  }
}

const isUint = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function textProblem(s, max) {
  if (typeof s !== "string") return "bad-text";
  if (s.length > max) return "too-long";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) return "bad-char";
  }
  return null;
}

function platformEntries(p) {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new SecurityNoticeError("bad-platforms");
  const entries = [];
  for (const name of Object.keys(p)) {
    if (!PLATFORMS.includes(name)) throw new SecurityNoticeError("bad-platforms");
    const m = p[name];
    if (!m || typeof m !== "object" || !isUint(m.minBuild) || !isUint(m.minProtocol)) {
      throw new SecurityNoticeError("bad-minimum");
    }
    entries.push([name, { minBuild: m.minBuild, minProtocol: m.minProtocol }]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries;
}

/** The bytes a notice's signature covers; throws SecurityNoticeError(code) for the first rule broken. */
export function canonicalSecurityNotice(b, signedBy) {
  if (typeof signedBy !== "string" || !HEX64.test(signedBy)) throw new SecurityNoticeError("bad-signer");
  if (!isUint(b.seq) || b.seq < 1) throw new SecurityNoticeError("bad-seq");
  if (!KINDS.includes(b.kind)) throw new SecurityNoticeError("bad-kind");
  if (!isUint(b.validFrom) || !isUint(b.validUntil)) throw new SecurityNoticeError("bad-time");
  if (b.validUntil <= b.validFrom) throw new SecurityNoticeError("window-order");
  if (b.validUntil - b.validFrom > SECURITY_NOTICE_MAX_WINDOW_MS) throw new SecurityNoticeError("window-too-long");
  if (!isUint(b.eventAt)) throw new SecurityNoticeError("bad-event-at");
  if (b.eventAt !== 0 && (b.eventAt < b.validFrom || b.eventAt > b.validUntil)) throw new SecurityNoticeError("bad-event-at");
  if (!isUint(b.lockFrom)) throw new SecurityNoticeError("bad-lock-from");
  if (!isUint(b.deprecatesProtocol)) throw new SecurityNoticeError("bad-deprecates");
  const entries = platformEntries(b.platforms);
  const platforms = entries.map(([n, m]) => `${n}:${m.minBuild}:${m.minProtocol}`).join(",");

  if (textProblem(b.advisoryId, 64) !== null) throw new SecurityNoticeError("bad-advisory");
  if (b.advisoryId !== "" && !ADVISORY_ID.test(b.advisoryId)) throw new SecurityNoticeError("bad-advisory");
  if (textProblem(b.reason, SECURITY_NOTICE_MAX_REASON) !== null) throw new SecurityNoticeError("bad-reason");
  if (textProblem(b.message, SECURITY_NOTICE_MAX_MESSAGE) !== null) throw new SecurityNoticeError("bad-message");
  if (b.message.includes("://")) throw new SecurityNoticeError("message-has-link");
  if (b.reason.includes("://")) throw new SecurityNoticeError("message-has-link");
  if (b.message.includes("{date}") && b.eventAt === 0) throw new SecurityNoticeError("date-token-needs-event");

  const carriesMinimums = b.kind === "update-advisory" || b.kind === "update-required";
  if (b.kind === "none") {
    if (entries.length) throw new SecurityNoticeError("platforms-not-allowed");
    if (b.message !== "") throw new SecurityNoticeError("message-not-allowed");
    if (b.eventAt !== 0) throw new SecurityNoticeError("bad-event-at");
  } else if (b.message === "") {
    throw new SecurityNoticeError("message-required");
  }
  if (carriesMinimums) {
    if (entries.length === 0) throw new SecurityNoticeError("platforms-required");
    for (const [, m] of entries) {
      if (m.minBuild === 0 && m.minProtocol === 0) throw new SecurityNoticeError("minimum-required");
    }
  } else {
    for (const [, m] of entries) {
      if (m.minBuild !== 0 || m.minProtocol !== 0) throw new SecurityNoticeError("minimum-not-allowed");
    }
  }
  if (b.kind === "update-required") {
    if (b.advisoryId === "") throw new SecurityNoticeError("advisory-required");
    if (b.reason === "") throw new SecurityNoticeError("reason-required");
    if (b.lockFrom < b.validFrom || b.lockFrom >= b.validUntil) throw new SecurityNoticeError("bad-lock-from");
    if (b.deprecatesProtocol !== 0) {
      for (const [, m] of entries) {
        if (m.minProtocol <= b.deprecatesProtocol) throw new SecurityNoticeError("deprecates-not-enforced");
      }
    }
  } else {
    if (b.lockFrom !== 0) throw new SecurityNoticeError("lock-from-not-allowed");
    if (b.deprecatesProtocol !== 0) throw new SecurityNoticeError("deprecates-not-allowed");
    if (b.kind !== "update-advisory") {
      if (b.advisoryId !== "") throw new SecurityNoticeError("advisory-not-allowed");
      if (b.reason !== "") throw new SecurityNoticeError("reason-not-allowed");
    }
  }

  return new TextEncoder().encode(
    [
      TAG_SECURITY_NOTICE,
      signedBy,
      String(b.seq),
      b.kind,
      String(b.validFrom),
      String(b.validUntil),
      String(b.eventAt),
      String(b.lockFrom),
      platforms,
      b.advisoryId,
      String(b.deprecatesProtocol),
      b.reason,
      b.message,
    ].join("|"),
  );
}

/** Shape-check an untrusted notice and enforce every rule (no signature check). */
export function parseSecurityNotice(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (v.type !== "SecurityNotice" || v.version !== 1) return null;
  if (typeof v.signedBy !== "string" || typeof v.signature !== "string") return null;
  if (!HEX64.test(v.signedBy) || !HEX128.test(v.signature)) return null;
  if (typeof v.kind !== "string" || typeof v.advisoryId !== "string") return null;
  if (typeof v.reason !== "string" || typeof v.message !== "string") return null;
  if (typeof v.platforms !== "object" || v.platforms === null || Array.isArray(v.platforms)) return null;
  try {
    canonicalSecurityNotice(v, v.signedBy);
  } catch {
    return null;
  }
  const platforms = {};
  for (const [n, m] of platformEntries(v.platforms)) platforms[n] = m;
  return {
    type: "SecurityNotice",
    version: 1,
    seq: v.seq,
    kind: v.kind,
    validFrom: v.validFrom,
    validUntil: v.validUntil,
    eventAt: v.eventAt,
    lockFrom: v.lockFrom,
    platforms,
    advisoryId: v.advisoryId,
    deprecatesProtocol: v.deprecatesProtocol,
    reason: v.reason,
    message: v.message,
    signedBy: v.signedBy,
    signature: v.signature,
  };
}

/** @returns {Promise<{ok:true}|{ok:false, reason:"malformed"|"unauthorized-signer"|"signature-invalid"}>} */
export async function verifySecurityNotice(n, authorityKeys) {
  let bytes;
  try {
    bytes = canonicalSecurityNotice(n, n.signedBy);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!HEX128.test(n.signature)) return { ok: false, reason: "malformed" };
  if (!Array.isArray(authorityKeys) || !authorityKeys.includes(n.signedBy)) {
    return { ok: false, reason: "unauthorized-signer" };
  }
  return (await edVerify(n.signature, bytes, n.signedBy))
    ? { ok: true }
    : { ok: false, reason: "signature-invalid" };
}

/** Is this client below the notice's minimum for its platform? (false when the platform isn't listed.) */
export function clientBelowMinimum(n, c) {
  const m = n.platforms[c.platform];
  if (!m) return false;
  return (m.minBuild > 0 && c.build < m.minBuild) || (m.minProtocol > 0 && c.protocol < m.minProtocol);
}

/**
 * What to show for an already VERIFIED notice. Fail open: outside
 * [validFrom, validUntil) nothing; only update-required, from lockFrom, for a
 * client below the minimum, locks.
 * @returns {{action:"none", why:string}|{action:"banner", style:"maintenance"|"update", notice:object}|{action:"lock", notice:object}}
 */
export function securityNoticeOutcome(n, c, now) {
  if (n.kind === "none") return { action: "none", why: "kind-none" };
  if (now < n.validFrom) return { action: "none", why: "not-yet" };
  if (now >= n.validUntil) return { action: "none", why: "expired" };
  if (n.kind === "maintenance") {
    if (Object.keys(n.platforms).length > 0 && !n.platforms[c.platform]) return { action: "none", why: "other-platform" };
    return { action: "banner", style: "maintenance", notice: n };
  }
  if (!n.platforms[c.platform]) return { action: "none", why: "other-platform" };
  if (!clientBelowMinimum(n, c)) return { action: "none", why: "up-to-date" };
  if (n.kind === "update-required" && now >= n.lockFrom) return { action: "lock", notice: n };
  return { action: "banner", style: "update", notice: n };
}

/**
 * Fold a fetched candidate into the store ({highestSeq, notice}). Anything
 * malformed, not signed by the authority, or not newer than the highest seq
 * verified is dropped and the store is returned unchanged.
 */
export async function acceptSecurityNotice(store, candidate, authorityKeys) {
  if (candidate === null || candidate === undefined) return { store, refused: null };
  const n = parseSecurityNotice(candidate);
  if (!n) return { store, refused: "malformed" };
  const v = await verifySecurityNotice(n, authorityKeys);
  if (!v.ok) return { store, refused: v.reason };
  if (n.seq <= store.highestSeq) return { store, refused: "stale" };
  return { store: { highestSeq: n.seq, notice: n }, refused: null };
}

/** The stored notice's outcome, re-verified against the authority NOW; unverifiable means nothing. */
export async function storedSecurityNoticeOutcome(store, authorityKeys, client, now) {
  const n = store.notice;
  if (!n) return { action: "none", why: "kind-none" };
  if (!(await verifySecurityNotice(n, authorityKeys)).ok) return { action: "none", why: "kind-none" };
  return securityNoticeOutcome(n, client, now);
}

/** `{date}` replaced by the caller's rendering of eventAt. */
export function securityNoticeText(n, formatDate) {
  return n.eventAt === 0 ? n.message : n.message.split("{date}").join(formatDate(n.eventAt));
}

/** A date for a person, in their own locale and zone, never sent anywhere. */
export function formatNoticeDate(ms) {
  try {
    return new Date(ms).toLocaleString(dateLocale(), {
      weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/* ---------- the authority ---------- */

/**
 * The ca-track maintainer authority at `now`, from the mandate log a response
 * carries, walked forward from the baked pin. `minTip` is the issuedAt (ms) of
 * the newest authority mandate this device has verified: an older one is
 * refused, so a hostile carrier cannot replay a chain from before a rotation.
 * @returns {Promise<{keys:string[], tip:number}>}
 */
export async function noticeAuthority(mandates, now, { pin = BAKED_PIN, minTip = 0 } = {}) {
  if (!Array.isArray(mandates) || mandates.length === 0) return { keys: [], tip: minTip };
  let auth;
  try {
    auth = currentAuthority(await verifyMandateChainFromPin(pin, mandates), now);
  } catch {
    return { keys: [], tip: minTip };
  }
  if (!auth) return { keys: [], tip: minTip };
  const issued = Date.parse(auth.mandate.issuedAt);
  if (!Number.isFinite(issued) || issued < minTip) return { keys: [], tip: minTip };
  return { keys: [auth.holder], tip: Math.max(issued, minTip) };
}

/* ---------- the store ---------- */

const EMPTY = Object.freeze({ highestSeq: 0, doc: null, tip: 0, dismissed: null });

export function loadStore(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(STORE_KEY);
    if (!raw) return { ...EMPTY };
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return { ...EMPTY };
    return {
      highestSeq: isUint(v.highestSeq) ? v.highestSeq : 0,
      doc: v.doc && typeof v.doc === "object" ? v.doc : null,
      tip: isUint(v.tip) ? v.tip : 0,
      dismissed: v.dismissed && isUint(v.dismissed.seq) && isUint(v.dismissed.at) ? v.dismissed : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveStore(store, storage = safeStorage()) {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* private mode or full: the notice just is not remembered */
  }
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/* ---------- state, fetch, poll ---------- */

const NONE = Object.freeze({ action: "none", why: "kind-none" });

class NoticeState {
  constructor() {
    this.outcome = NONE;
    this._subs = new Set();
  }
  set(outcome) {
    const lockChanged = (this.outcome.action === "lock") !== (outcome.action === "lock");
    this.outcome = outcome;
    setUpdateLocked(outcome.action === "lock");
    for (const fn of this._subs) {
      try {
        fn(outcome, lockChanged);
      } catch {
        /* a listener never blocks the state */
      }
    }
  }
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
}

export const securityNotices = new NoticeState();

let timer = null;

/** Re-evaluate the stored notice at `now` and publish the outcome. */
export async function evaluateSecurityNotice({
  now = Date.now(),
  storage = safeStorage(),
  client = clientIdentity(),
  pin = BAKED_PIN,
} = {}) {
  const store = loadStore(storage);
  let outcome = NONE;
  const n = store.doc ? parseSecurityNotice(store.doc.notice) : null;
  if (n) {
    const { keys } = await noticeAuthority(store.doc.mandates, now, { pin, minTip: store.tip });
    outcome = await storedSecurityNoticeOutcome({ highestSeq: store.highestSeq, notice: n }, keys, client, now);
  }
  securityNotices.set(outcome);
  scheduleNextBoundary(n, now);
  return outcome;
}

function scheduleNextBoundary(n, now) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!n || typeof setTimeout !== "function") return;
  const next = [n.validFrom, n.lockFrom, n.validUntil].filter((t) => t > now).sort((a, b) => a - b)[0];
  if (next === undefined) return;
  // Re-check at the boundary (at most every 6 hours, so a slept tab still catches up).
  timer = setTimeout(() => void evaluateSecurityNotice(), Math.min(next - now + 250, 6 * 3600_000));
  timer.unref?.();
}

/**
 * One anonymous GET, then fold the answer in. Never throws: any failure leaves
 * the cached notice as it was.
 */
export async function refreshSecurityNotice({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = Date.now(),
  storage = safeStorage(),
  client = clientIdentity(),
  pin = BAKED_PIN,
} = {}) {
  try {
    if (typeof fetchImpl !== "function") return { fetched: false };
    const res = await fetchImpl(`${controlApex()}${SECURITY_NOTICE_PATH}`, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
    if (res.status === 204 || !res.ok) return { fetched: res.status === 204 };
    const doc = await res.json();
    if (!doc || doc.version !== 1 || !doc.notice || !Array.isArray(doc.mandates)) return { fetched: true, refused: "malformed" };
    const store = loadStore(storage);
    const { keys, tip } = await noticeAuthority(doc.mandates, now, { pin, minTip: store.tip });
    const folded = await acceptSecurityNotice(
      { highestSeq: store.highestSeq, notice: null },
      doc.notice,
      keys,
    );
    if (folded.refused === null && folded.store.notice) {
      saveStore({ ...store, highestSeq: folded.store.highestSeq, doc: { version: 1, notice: folded.store.notice, mandates: doc.mandates }, tip }, storage);
      await evaluateSecurityNotice({ now, storage, client, pin });
    } else if (tip > store.tip) {
      saveStore({ ...store, tip }, storage);
    }
    // Nothing new (a refusal, a repeat): the screen stays as it is until the
    // next boundary or foreground, so a hostile or stale answer cannot
    // reshuffle what the person already sees.
    return { fetched: true, refused: folded.refused };
  } catch {
    return { fetched: false };
  }
}

/** How a banner was dismissed (the lock cannot be). */
export function dismissNotice(notice, { now = Date.now(), storage = safeStorage() } = {}) {
  const store = loadStore(storage);
  saveStore({ ...store, dismissed: { seq: notice.seq, at: now } }, storage);
}

const ADVISORY_REAPPEAR_MS = 24 * 3600_000;

/**
 * Should this banner show? A maintenance banner stays dismissed for its seq.
 * An update banner returns after a day; one that is the grace window of an
 * update-required comes back on every launch (`sessionDismissed` is the
 * in-page memory of this launch).
 */
export function bannerVisible(outcome, store, { now = Date.now(), sessionDismissed = false } = {}) {
  if (outcome.action !== "banner") return false;
  const n = outcome.notice;
  if (sessionDismissed) return false;
  if (n.kind === "update-required") return true;
  const d = store.dismissed;
  if (!d || d.seq !== n.seq) return true;
  if (outcome.style === "maintenance") return false;
  return now - d.at >= ADVISORY_REAPPEAR_MS;
}

let pollerStarted = false;
let lastFetchAt = 0;

/** Poll on start and whenever the page returns to the foreground, with jitter. Idempotent. */
export function startSecurityNoticePoller({ intervalMs = 15 * 60_000, jitterMs = 10_000 } = {}) {
  if (pollerStarted || typeof document === "undefined") return;
  pollerStarted = true;
  void evaluateSecurityNotice();
  const kick = () => {
    const delay = Math.floor(Math.random() * jitterMs);
    const t = setTimeout(async () => {
      lastFetchAt = Date.now();
      await refreshSecurityNotice();
    }, delay);
    t.unref?.();
  };
  kick();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void evaluateSecurityNotice();
      if (Date.now() - lastFetchAt >= intervalMs) kick();
    }
  });
  const every = setInterval(() => {
    if (document.visibilityState === "visible" && Date.now() - lastFetchAt >= intervalMs) kick();
  }, intervalMs);
  every.unref?.();
}

/** Test seam. */
export function _resetSecurityNoticesForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  pollerStarted = false;
  lastFetchAt = 0;
  securityNotices.outcome = NONE;
  securityNotices._subs.clear();
  setUpdateLocked(false);
}
