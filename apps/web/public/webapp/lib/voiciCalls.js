// voi.ci calls on the webapp (docs/voici-calls.md §8): the webapp never answers a call (web push can't ring
// reliably), but it is a full account device for the page, so it reads the missed calls and signs the owner's
// "may call" / "may not call" order for one conversation. Browser twin of the call-allow, missed-call and request
// parts of packages/protocol/src/voiciCalls.ts, byte for byte (shared vectors in
// packages/protocol/test-vectors/voici-calls/, replayed by apps/web/tests/webappVoiciCalls.test.ts).
//
//   canonicalVoiciCallAllow, signVoiciCallAllow, verifyVoiciCallAllow     flagship/voici-call-allow/v1
//   canonicalVoiciCallRequest, checkVoiciCallRequestSignatures            the request a missed call carries
//   openVoiciMissedCall                                                   flagship/voici-missed-call/v1
//   sealVoiciRingHint, canonicalVoiciRing, signVoiciRing                  the owner ringing a caller back
//                                                                         (flagship/voici-ring/v1, -ring-hint/v1)

import { b64Decode, b64Encode, canonicalJson, canonicalJsonBytes, ed25519SignHex, ed25519VerifyHex, hybridOpen, hybridSealWithRandomness, isLowerHex, p256VerifyP1363, parseHybridSealPublicKey, sha256Hex } from "./voiciCore.js";
import { canonicalVoiciThreadStatement, checkMessagesKeyAttestation, checkWebDelegation, parseVoiciThreadStatement, voiciConv } from "./voiciMessages.js";

export const TAG_VOICI_CALL_REQUEST = "flagship/voici-call-request/v1";
export const TAG_VOICI_CALL_ALLOW = "flagship/voici-call-allow/v1";
export const TAG_VOICI_MISSED_CALL = "flagship/voici-missed-call/v1";
export const VOICI_MISSED_CALL_REASONS = ["no-answer", "busy", "cancel", "decline"];
export const VOICI_CALL_MEDIA = ["audio", "audio,video"];

const te = new TextEncoder();
const utf8 = (s) => te.encode(s);
const join = (parts) => utf8(parts.map(String).join("|"));
const PAGE_ID = /^[0-9a-f]{32}$/;
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r, keys) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));

// ── call-allow ──────────────────────────────────────────────────────────────

/** `flagship/voici-call-allow/v1|<pageId>|<conv>|<allow|disallow>|<issuedAt>`, signed by the page's ownerSignPub. */
export function canonicalVoiciCallAllow(a) {
  if (!PAGE_ID.test(a?.pageId) || !isLowerHex(a.conv, 32) || (a.op !== "allow" && a.op !== "disallow") || !isTime(a.issuedAt)) {
    throw new Error(`${TAG_VOICI_CALL_ALLOW}: bad field`);
  }
  return join([TAG_VOICI_CALL_ALLOW, a.pageId, a.conv, a.op, a.issuedAt]);
}

export function signVoiciCallAllow(a, ownerSignSeed) {
  return ed25519SignHex(canonicalVoiciCallAllow(a), ownerSignSeed);
}

export function verifyVoiciCallAllow(a, signature, ownerSignPub) {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciCallAllow(a), ownerSignPub);
  } catch {
    return false;
  }
}

// ── the request inside a missed call ────────────────────────────────────────

const REQUEST_KEYS = ["v", "kind", "pageId", "conv", "callId", "from", "callerXwingPub", "offerSdp", "issuedAt", "cred", "sig"];

export function canonicalVoiciCallRequest(r) {
  if (
    !PAGE_ID.test(r.pageId) ||
    !isLowerHex(r.conv, 32) ||
    !isLowerHex(r.callId, 16) ||
    !isLowerHex(r.callerXwingPub, 1216) ||
    !isTime(r.issuedAt) ||
    typeof r.offerSdp !== "string" ||
    (r.media !== undefined && !VOICI_CALL_MEDIA.includes(r.media))
  ) {
    throw new Error(`${TAG_VOICI_CALL_REQUEST}: bad field`);
  }
  return join([TAG_VOICI_CALL_REQUEST, r.pageId, r.conv, r.callId, r.callerXwingPub, sha256Hex(utf8(r.offerSdp)), r.issuedAt, ...(r.media !== undefined ? [r.media] : [])]);
}

/**
 * The signatures of a call request read later (a missed call): attestation, delegation, thread statement, conv and
 * B's signature, as of `now` (its ring time). The SDP and the caller's X-Wing key are the answering phone's checks;
 * a missed call never connects, so they are not repeated here. {ok:true, request} | {ok:false, code}.
 */
export function checkVoiciCallRequestSignatures(r, ctx) {
  const no = (code) => ({ ok: false, code });
  if (isObj(r) && r.kind === "voici-call-request-anon") return checkAnonRequestSignature(r, ctx);
  if (!isObj(r) || !(exactKeys(r, REQUEST_KEYS) || exactKeys(r, [...REQUEST_KEYS, "media"])) || r.v !== 1 || r.kind !== "voici-call-request") return no("malformed");
  if (!isLowerHex(r.sig, 64) || !isLowerHex(r.from, 32) || !isObj(r.cred)) return no("malformed");
  let bytes;
  try {
    bytes = canonicalVoiciCallRequest(r);
  } catch {
    return no("malformed");
  }
  const c = r.cred;
  if (!exactKeys(c, ["attestation", "delegation", "delegationSig", "threadStmt", "threadSig"])) return no("malformed");
  if (r.pageId !== ctx.pageId) return no("wrong-audience");
  const att = checkMessagesKeyAttestation(c.attestation, { caKeys: ctx.caKeys, now: ctx.now, pseudonymPub: r.from });
  if (!att.ok) return no("bad-attestation");
  const del = checkWebDelegation(c.delegation, c.delegationSig, { scope: "voici-messages", origin: ctx.origin, audience: ctx.pageId, principalPub: r.from, now: ctx.now, notAfter: att.attestation.expiresAt });
  if (!del.ok) return no("bad-delegation");
  const ts = parseVoiciThreadStatement(c.threadStmt);
  if (!ts || ts.pageId !== ctx.pageId || ts.pseudonymPub !== r.from || typeof c.threadSig !== "string" || !ed25519VerifyHex(c.threadSig, canonicalVoiciThreadStatement(ts), r.from)) return no("bad-thread");
  if (r.conv !== voiciConv(ctx.pageId, r.from)) return no("wrong-conv");
  if (!p256VerifyP1363(r.sig, bytes, del.delegation.delegatePub)) return no("bad-signature");
  return { ok: true, request: r };
}

// An anonymous caller's request (voiciCallModes.ts): its browser key signed it and names its conversation; the work
// was `.com`'s check when it rang.
const ANON_KEYS = ["v", "kind", "pageId", "conv", "callId", "browserPub", "callerXwingPub", "offerSdp", "issuedAt", "pow", "sig"];

function checkAnonRequestSignature(r, ctx) {
  const no = (code) => ({ ok: false, code });
  if (!(exactKeys(r, ANON_KEYS) || exactKeys(r, [...ANON_KEYS, "media"])) || r.v !== 1 || !isLowerHex(r.sig, 64) || !isLowerHex(r.browserPub, 65) || !isObj(r.pow)) return no("malformed");
  if (!PAGE_ID.test(r.pageId) || !isLowerHex(r.conv, 16) || !isLowerHex(r.callId, 16) || !isTime(r.issuedAt) || typeof r.offerSdp !== "string" || typeof r.pow.challenge !== "string" || typeof r.pow.nonce !== "string") return no("malformed");
  if (r.pageId !== ctx.pageId) return no("wrong-audience");
  if (r.conv !== sha256Hex(utf8(`flagship/voici-anon-conv/v1|${r.pageId}|${r.browserPub}`)).slice(0, 32)) return no("wrong-conv");
  const bytes = join(["flagship/voici-call-request-anon/v1", r.pageId, r.conv, r.callId, r.browserPub, r.callerXwingPub, sha256Hex(utf8(r.offerSdp)), r.issuedAt, sha256Hex(utf8(r.pow.challenge)), r.pow.nonce, ...(r.media !== undefined ? [r.media] : [])]);
  if (!p256VerifyP1363(r.sig, bytes, r.browserPub)) return no("bad-signature");
  return { ok: true, request: r };
}

// ── missed calls ────────────────────────────────────────────────────────────

/**
 * Opens a missed call sealed to the page's inbox key and checks its request's signatures as of its ring time:
 * `{v, request, ringingAt, endedAt, reason}` or null.
 */
export function openVoiciMissedCall(inboxSeed, callId, sealed, ctx) {
  try {
    const { plaintext } = hybridOpen(inboxSeed, TAG_VOICI_MISSED_CALL, [utf8(callId)], sealed);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const v = JSON.parse(text);
    if (canonicalJson(v) !== text || !isObj(v) || !exactKeys(v, ["v", "request", "ringingAt", "endedAt", "reason"]) || v.v !== 1) return null;
    if (!isTime(v.ringingAt) || !isTime(v.endedAt) || v.endedAt < v.ringingAt || !VOICI_MISSED_CALL_REASONS.includes(v.reason)) return null;
    const r = checkVoiciCallRequestSignatures(v.request, { pageId: ctx.pageId, origin: ctx.origin, caKeys: ctx.caKeys, now: v.ringingAt });
    if (!r.ok || v.request.callId !== callId) return null;
    return v;
  } catch {
    return null;
  }
}

// ── ringing a caller back (packages/protocol/src/voiciCallModes.ts) ───────────

export const TAG_VOICI_RING = "flagship/voici-ring/v1";
export const TAG_VOICI_RING_HINT = "flagship/voici-ring-hint/v1";
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The hint only the caller's app or tab opens (its thread key): which page is calling back, and the ring. */
export function sealVoiciRingHint(threadPub, h, eseed = crypto.getRandomValues(new Uint8Array(64))) {
  if (!PAGE_ID.test(h.pageId) || !USERNAME.test(h.username) || !isLowerHex(h.conv, 32) || !isLowerHex(h.ringId, 16) || !VOICI_CALL_MEDIA.includes(h.media) || !isTime(h.issuedAt)) throw new Error(`${TAG_VOICI_RING_HINT}: bad field`);
  return hybridSealWithRandomness(
    parseHybridSealPublicKey(threadPub),
    { purpose: TAG_VOICI_RING_HINT, senderKeyId: new Uint8Array(32), issuedAt: h.issuedAt },
    [utf8(h.conv), utf8(h.ringId)],
    canonicalJsonBytes({ v: 1, pageId: h.pageId, username: h.username, conv: h.conv, ringId: h.ringId, media: h.media, issuedAt: h.issuedAt }),
    eseed,
  );
}

export function canonicalVoiciRing(r) {
  const hint = b64Decode(r.hint);
  if (!PAGE_ID.test(r.pageId) || !isLowerHex(r.conv, 32) || !isLowerHex(r.ringId, 16) || !hint || !VOICI_CALL_MEDIA.includes(r.media) || !isTime(r.issuedAt)) throw new Error(`${TAG_VOICI_RING}: bad field`);
  return join([TAG_VOICI_RING, r.pageId, r.conv, r.ringId, sha256Hex(hint), r.media, r.issuedAt]);
}

export const signVoiciRing = (r, ownerSignSeed) => ed25519SignHex(canonicalVoiciRing(r), ownerSignSeed);
export const voiciRingHintB64 = (bytes) => b64Encode(bytes);
