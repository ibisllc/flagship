// Who may call a page, and ringing a caller back, on the visitor's side (docs/voici-calls.md, owner-approved
// 2026-11-15): browser twin of packages/protocol/src/voiciCallModes.ts, byte for byte (vectors
// packages/protocol/test-vectors/voici-call-modes/, replayed by tests/callModes.test.ts).
//
//   pageCallMode(index) -> "anyone" | "callback" | "accepted" | "signed-in" | null
//   anonymous calls:  createAnonKey(store, pageId), voiciAnonConv, canonicalVoiciCallRequestAnon,
//                     fetchCallChallenge(o), solveVoiciCallPow(challenge, o?) (async, in slices), buildAnonRequest
//   ring-back:        canonicalVoiciRingBack, postRingBack(session, op, o), ringBackAttached(store, pageId)
//   the owner's ring: ringOf(threadAnswer) / openVoiciRingHint(threadSeed, conv, ringId, hintB64)

import { hybridOpen, hex, b64Decode, sha256Hex, isLowerHex } from "./proto/lib/voiciCore.js";
import { sha256 } from "./proto/vendor/noble-post-quantum/pq-seal.js";
import { createBrowserKey, messageCred, signP256 } from "./envelope.js";
import { canonicalVoiciCallRequestAnon } from "./callProtocol.js";
import { voiciConv } from "./proto/lib/voiciProtocol.js";

export const TAG_VOICI_CALL_REQUEST_ANON = "flagship/voici-call-request-anon/v1";
export const TAG_VOICI_ANON_CONV = "flagship/voici-anon-conv/v1";
export const TAG_VOICI_CALL_POW = "flagship/voici-call-pow/v1";
export const TAG_VOICI_RING_BACK = "flagship/voici-ring-back/v1";
export const TAG_VOICI_RING_HINT = "flagship/voici-ring-hint/v1";

const te = new TextEncoder();
const utf8 = (s) => te.encode(s);
const NO_CREDS = { credentials: "omit", referrerPolicy: "no-referrer", mode: "cors", cache: "no-store" };
const ANON_KEY = "voici-anon-key:";
const RING_BACK = "voici-ring-back:";

/** The page's call mode from its verified index (null: calls off). */
export function pageCallMode(index) {
  return index?.version === 2 && index.acceptsCalls === 1 && typeof index.callsFrom === "string" ? index.callsFrom : null;
}

// ── anonymous calls ──────────────────────────────────────────────────────

export const voiciAnonConv = (pageId, browserPub) => sha256Hex(utf8(`${TAG_VOICI_ANON_CONV}|${pageId}|${browserPub}`)).slice(0, 32);

export { canonicalVoiciCallRequestAnon };

/** This browser's anonymous key toward a page, kept so the owner sees a returning caller (non-extractable). */
export async function anonKey(store, pageId) {
  try {
    const k = await store.get(ANON_KEY + pageId);
    if (k?.privateKey && isLowerHex(k.delegatePub, 65)) return k;
  } catch {
    /* make one */
  }
  const k = await createBrowserKey();
  try {
    await store.put(ANON_KEY + pageId, { privateKey: k.privateKey, delegatePub: k.delegatePub });
  } catch {
    /* this tab only */
  }
  return k;
}

/** GET /api/voici/pages/<u>/call-challenge -> {ok, challenge} | {ok:false, code, retryAfterSec?}. */
export async function fetchCallChallenge(o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await f(`${o.apiBase}/api/voici/pages/${encodeURIComponent(o.username)}/call-challenge`, { ...NO_CREDS, method: "GET" });
    const j = await res.json().catch(() => null);
    if (!res.ok || typeof j?.challenge !== "string") return { ok: false, code: typeof j?.code === "string" ? j.code : "unavailable", ...(Number.isSafeInteger(j?.retryAfterSec) ? { retryAfterSec: j.retryAfterSec } : {}) };
    return { ok: true, challenge: j.challenge };
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

function leadingZeroBits(b) {
  let n = 0;
  for (const x of b) {
    if (x === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(x) - 24;
  }
  return n;
}

/** The work: the smallest nonce from 0 whose SHA-256(challenge "|" nonce) starts with the challenge's bits of zero. */
export async function solveVoiciCallPow(challenge, o = {}) {
  const f = challenge.split("|");
  const bits = Number(f[3]);
  if (f.length !== 6 || f[0] !== TAG_VOICI_CALL_POW || !(bits >= 12 && bits <= 26)) return null;
  const slice = o.slice ?? 20_000;
  for (let i = 0; i < 2 ** 28; i++) {
    if (leadingZeroBits(sha256(utf8(`${challenge}|${i}`))) >= bits) return String(i);
    if (i % slice === slice - 1) {
      if (o.cancelled?.()) return null;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return null;
}

/** The signed anonymous request (WebCrypto P-256 with the browser's anonymous key). */
export async function buildAnonRequest(key, o) {
  const body = { pageId: o.pageId, conv: voiciAnonConv(o.pageId, key.delegatePub), callId: o.callId, browserPub: key.delegatePub, callerXwingPub: hex(o.callerXwingPub), offerSdp: o.offerSdp, issuedAt: o.issuedAt, pow: { challenge: o.challenge, nonce: o.nonce }, ...(o.media ? { media: o.media } : {}) };
  return { v: 1, kind: "voici-call-request-anon", ...body, sig: await signP256(key.privateKey, canonicalVoiciCallRequestAnon(body), o.subtle) };
}

// ── the ring-back channel ────────────────────────────────────────────────

export function canonicalVoiciRingBack(o) {
  return utf8([TAG_VOICI_RING_BACK, o.pageId, o.conv, o.op, String(o.issuedAt)].join("|"));
}

/** Whether this browser attached the conversation's ring-back channel (so the thread offers "Stop call-backs"). */
export async function ringBackAttached(store, pageId) {
  try {
    return (await store.get(RING_BACK + pageId)) === true;
  } catch {
    return false;
  }
}

/** POST /api/voici/web/ring-back: attach (a browser channel rings this tab and the visitor's apps) or stop. */
export async function postRingBack(session, op, o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const order = { pageId: session.pageId, conv: voiciConv(session.pageId, session.pseudonymPub), op, issuedAt: (o.now ?? Date.now)() };
  const body = { order, signer: "browser", from: session.pseudonymPub, cred: messageCred(session), sig: await signP256(session.privateKey, canonicalVoiciRingBack(order)) };
  try {
    const res = await f(`${o.apiBase}/api/voici/web/ring-back`, { ...NO_CREDS, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      return { ok: false, code: typeof j?.code === "string" ? j.code : "unavailable" };
    }
    try {
      if (o.store) await (op === "attach" ? o.store.put(RING_BACK + session.pageId, true) : o.store.delete(RING_BACK + session.pageId));
    } catch {
      /* the thread just won't offer "Stop call-backs" */
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

// ── the owner's ring ─────────────────────────────────────────────────────

/** The ring a thread fetch answered while it rings: {ringId, hint, media, until}, or null. */
export function ringOf(answer) {
  const r = answer?.ring;
  if (!r || !isLowerHex(r.ringId, 16) || typeof r.hint !== "string" || !Number.isSafeInteger(r.until) || (r.media !== "audio" && r.media !== "audio,video")) return null;
  return { ringId: r.ringId, hint: r.hint, media: r.media, until: r.until };
}

/** Opens the ring's hint with the conversation's thread key: {pageId, username, conv, ringId, media, issuedAt} or null. */
export function openVoiciRingHint(threadSeed, conv, ringId, hintB64) {
  try {
    const sealed = b64Decode(hintB64);
    if (!sealed) return null;
    const { plaintext } = hybridOpen(threadSeed, TAG_VOICI_RING_HINT, [utf8(conv), utf8(ringId)], sealed);
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    const keys = ["v", "pageId", "username", "conv", "ringId", "media", "issuedAt"];
    if (!v || Object.keys(v).length !== keys.length || !keys.every((k) => k in v) || v.v !== 1 || v.conv !== conv || v.ringId !== ringId) return null;
    if (!/^[0-9a-f]{32}$/.test(v.pageId) || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(v.username) || (v.media !== "audio" && v.media !== "audio,video") || !Number.isSafeInteger(v.issuedAt)) return null;
    return v;
  } catch {
    return null;
  }
}
