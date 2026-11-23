/**
 * Who may call a page, and ringing a caller back (docs/voici-calls.md, owner-approved 2026-11-15). Shared vectors:
 * packages/protocol/test-vectors/voici-call-modes/ (tools/voici-call-modes-vectors.ts).
 *
 * Page modes live in the v2 index's callsFrom: "anyone" (anyone on the internet, no account) or "callback" (signed-in
 * callers who allow a ring-back in their conversation). A visitor's choice is the pop-up before the call: "Call
 * anonymously" or "Call and allow call-back".
 *
 * Anonymous calls (callsFrom "anyone" only):
 *   request  flagship/voici-call-request-anon/v1|<pageId>|<conv>|<callId>|<browserPub>|<callerXwingPub>|<H(offerSdp)>
 *              |<issuedAt>|<H(powChallenge)>|<powNonce>[|<media>]       P-256 (IEEE P1363) by browserPub
 *            conv = first 16 bytes (hex) of SHA-256("flagship/voici-anon-conv/v1|<pageId>|<browserPub>"): the same
 *            browser key keeps one conversation with the page; no Messages conversation exists.
 *   pow      the challenge `.com` issued: flagship/voici-call-pow/v1|<pageId>|<issuedAt>|<bits>|<rand hex 32>|<mac hex 64>
 *            (mac = HMAC-SHA256 under `.com`'s secret over the part before it); a nonce (decimal, ≤ 16 digits) such
 *            that SHA-256(challenge "|" nonce) starts with `bits` zero bits. Good for 2 minutes, spent once.
 *
 * Ringing a caller back (the pseudonymous side always dials out; no bare name of it is ever used):
 *   channel  flagship/voici-ring-back/v1|<pageId>|<conv>|<attach|stop>|<issuedAt>
 *            by the caller: Ed25519 by the pseudonym P (the visitor's app, which also sends its device headers so
 *            `.com` can push to that account's devices), or P-256 by the browser key B with the message cred
 *            (attestation, delegation, thread statement), as a message is (a browser channel rings only the open
 *            voi.ci tab and the visitor's apps through their thread fetch). Owner correction 2026-11-15: no sealed
 *            tokens and no relay split; `.com` knows the conversation can ring the caller's phone, and says so.
 *   ring     flagship/voici-ring/v1|<pageId>|<conv>|<ringId>|<H(hint bytes)>|<media>|<issuedAt>
 *            Ed25519 by the page's ownerSignPub. The owner taps Call in a thread that has a channel.
 *   hint     flagship/hybrid-seal/v1, purpose "flagship/voici-ring-hint/v1", context [conv, ringId], to the
 *            visitor's thread key T (from the conversation's thread statement); plaintext canonical JSON
 *            {v:1, pageId, username, conv, ringId, media, issuedAt}. It rides in the content-free push (the relay
 *            push carries no content): the visitor's app opens it with its T for that page and dials out to the page.
 *
 * Names on a locked phone (docs/voici-locked-caller-names.md, owner-agreed 2026-11-22):
 *   ring tag key  HKDF-SHA256(ikm = messagesSecret, salt = "", info = "flagship/voici-ring-tag/v1|<pageId>"), 32 bytes.
 *                 The caller's app sends it beside a pseudonym-signed attach (body field `ringTagKey`, unsigned: a forged
 *                 key only keeps the page name off a locked ring); `.com` keeps it with the channel.
 *   ring tag      first 16 bytes (hex) of HMAC-SHA256(tagKey, UTF-8 of the ring's ringId hex). Rides in the ring push
 *                 as `tag`: fresh per ring, so APNs/FCM see unlinkable bytes; a locked caller phone matches it against
 *                 the tag keys it keeps for the pages that may ring it back.
 *   locked name   first 16 bytes (hex) of SHA-256("flagship/voici-locked-name/v1|<pseudonymPub>"): the key a locked page
 *                 owner's phone looks a caller's nickname up under (never the pub itself).
 */
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import { checkMessagesKeyAttestation } from "./messagesAttestation.js";
import { hybridOpen, hybridSealWithRandomness, HYBRID_SEAL_PUBLIC_KEY_LEN, HYBRID_SEAL_RANDOMNESS_LEN, parseHybridSealPublicKey } from "./pqHybrid.js";
import type { Bytes } from "./types.js";
import { checkWebDelegation } from "./webDelegation.js";
import { b64Decode, canonicalJsonBytes, ed25519VerifyHex, hexToBytes, isLowerHex, p256VerifyP1363, sha256Hex } from "./webEnvelope.js";
import { canonicalVoiciThreadStatement, parseVoiciThreadStatement, voiciConv } from "./voiciMessages.js";
import { checkVoiciCallSdp, VOICI_CALL_MAX_REQUEST_BYTES, VOICI_CALL_MEDIA, VOICI_CALL_SKEW_MS, voiciCallSdpHash, type VoiciCallMedia } from "./voiciCalls.js";

export const TAG_VOICI_CALL_REQUEST_ANON = "flagship/voici-call-request-anon/v1";
export const TAG_VOICI_ANON_CONV = "flagship/voici-anon-conv/v1";
export const TAG_VOICI_CALL_POW = "flagship/voici-call-pow/v1";
export const TAG_VOICI_RING_BACK = "flagship/voici-ring-back/v1";
export const TAG_VOICI_RING = "flagship/voici-ring/v1";
export const TAG_VOICI_RING_HINT = "flagship/voici-ring-hint/v1";
export const TAG_VOICI_RING_TAG = "flagship/voici-ring-tag/v1";
export const TAG_VOICI_LOCKED_NAME = "flagship/voici-locked-name/v1";

export const VOICI_CALL_POW_TTL_MS = 2 * 60_000;
export const VOICI_CALL_POW_MIN_BITS = 12;
export const VOICI_CALL_POW_MAX_BITS = 26;
/** Default difficulty: about 260,000 SHA-256 in the browser, a second or two on a phone. */
export const VOICI_CALL_POW_BITS = 18;
/** A channel lasts 90 days from its last attach, then the caller has to allow call-back again. */
export const VOICI_RING_BACK_TTL_MS = 90 * 86_400_000;
/** A ring lasts as long as an incoming call rings. */
export const VOICI_RING_TTL_MS = 45_000;

const te = new TextEncoder();
const utf8 = (s: string): Bytes => te.encode(s);
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const NONCE = /^(0|[1-9][0-9]{0,15})$/;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r: Record<string, unknown>, keys: string[]) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));
const isMedia = (m: unknown): m is VoiciCallMedia => typeof m === "string" && (VOICI_CALL_MEDIA as readonly string[]).includes(m);
const isP256Pub = (s: unknown): s is string => {
  if (!isLowerHex(s, 65) || !s.startsWith("04")) return false;
  try {
    p256.Point.fromHex(s);
    return true;
  } catch {
    return false;
  }
};
const join = (parts: (string | number)[]): Bytes => utf8(parts.map(String).join("|"));
type Fail<C> = { ok: false; code: C };

// ── proof of work ──────────────────────────────────────────────────────────

/** `.com` issues a challenge: the part before the MAC, then the MAC under its secret. */
export function issueVoiciCallPow(o: { pageId: string; issuedAt: number; bits: number; rand: string }, secret: Bytes): string {
  if (!PAGE_ID.test(o.pageId) || !isTime(o.issuedAt) || !Number.isInteger(o.bits) || o.bits < VOICI_CALL_POW_MIN_BITS || o.bits > VOICI_CALL_POW_MAX_BITS || !isLowerHex(o.rand, 16)) throw new Error(`${TAG_VOICI_CALL_POW}: bad field`);
  const body = [TAG_VOICI_CALL_POW, o.pageId, o.issuedAt, o.bits, o.rand].join("|");
  return `${body}|${hex(hmac(sha256, secret, utf8(body)))}`;
}

/** The fields of a challenge (no MAC check: anyone can read it; only `.com` can check it). */
export function parseVoiciCallPow(c: unknown): { pageId: string; issuedAt: number; bits: number; rand: string; mac: string } | null {
  if (typeof c !== "string" || c.length > 256) return null;
  const f = c.split("|");
  if (f.length !== 6 || f[0] !== TAG_VOICI_CALL_POW || !PAGE_ID.test(f[1]!) || !/^(0|[1-9][0-9]{0,15})$/.test(f[2]!) || !/^[0-9]{2}$/.test(f[3]!) || !isLowerHex(f[4], 16) || !isLowerHex(f[5], 32)) return null;
  const bits = Number(f[3]);
  if (bits < VOICI_CALL_POW_MIN_BITS || bits > VOICI_CALL_POW_MAX_BITS) return null;
  return { pageId: f[1]!, issuedAt: Number(f[2]), bits, rand: f[4]!, mac: f[5]! };
}

function leadingZeroBits(b: Bytes): number {
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

/** Whether `nonce` solves `challenge` (the work alone; `.com` also checks the MAC, the time and that it is unspent). */
export function voiciCallPowSolves(challenge: string, nonce: string): boolean {
  const c = parseVoiciCallPow(challenge);
  if (!c || !NONCE.test(nonce)) return false;
  return leadingZeroBits(sha256(utf8(`${challenge}|${nonce}`))) >= c.bits;
}

/** The browser's search (tests and the reference; flagship-web runs the same loop in small slices). */
export function solveVoiciCallPow(challenge: string, maxTries = 2 ** 28): string | null {
  const c = parseVoiciCallPow(challenge);
  if (!c) return null;
  for (let i = 0; i < maxTries; i++) if (leadingZeroBits(sha256(utf8(`${challenge}|${i}`))) >= c.bits) return String(i);
  return null;
}

/** `.com`'s check of a challenge it issued: the MAC under its secret, the page and the 2-minute window. */
export function checkVoiciCallPowChallenge(challenge: string, ctx: { secret: Bytes; pageId: string; now: number }): "ok" | "malformed" | "bad-mac" | "wrong-page" | "expired" {
  const c = parseVoiciCallPow(challenge);
  if (!c) return "malformed";
  const body = challenge.slice(0, challenge.lastIndexOf("|"));
  if (hex(hmac(sha256, ctx.secret, utf8(body))) !== c.mac) return "bad-mac";
  if (c.pageId !== ctx.pageId) return "wrong-page";
  if (ctx.now < c.issuedAt - 5_000 || ctx.now > c.issuedAt + VOICI_CALL_POW_TTL_MS) return "expired";
  return "ok";
}

// ── the anonymous request ──────────────────────────────────────────────────

export interface VoiciCallRequestAnonBody {
  pageId: string;
  conv: string;
  callId: string;
  browserPub: string;
  callerXwingPub: string;
  offerSdp: string;
  issuedAt: number;
  pow: { challenge: string; nonce: string };
  media?: VoiciCallMedia;
}
export interface VoiciCallRequestAnon extends VoiciCallRequestAnonBody {
  v: 1;
  kind: "voici-call-request-anon";
  sig: string;
}
const ANON_KEYS = ["v", "kind", "pageId", "conv", "callId", "browserPub", "callerXwingPub", "offerSdp", "issuedAt", "pow", "sig"];

/** The conversation an anonymous browser key has with a page. */
export function voiciAnonConv(pageId: string, browserPub: string): string {
  return sha256Hex(utf8(`${TAG_VOICI_ANON_CONV}|${pageId}|${browserPub}`)).slice(0, 32);
}

export function canonicalVoiciCallRequestAnon(r: VoiciCallRequestAnonBody): Bytes {
  if (
    !PAGE_ID.test(r.pageId) ||
    !isLowerHex(r.conv, 16) ||
    !isLowerHex(r.callId, 16) ||
    !isP256Pub(r.browserPub) ||
    !isLowerHex(r.callerXwingPub, HYBRID_SEAL_PUBLIC_KEY_LEN) ||
    !isTime(r.issuedAt) ||
    typeof r.offerSdp !== "string" ||
    !isObj(r.pow) ||
    !exactKeys(r.pow, ["challenge", "nonce"]) ||
    !parseVoiciCallPow(r.pow.challenge) ||
    typeof r.pow.nonce !== "string" ||
    !NONCE.test(r.pow.nonce) ||
    (r.media !== undefined && !isMedia(r.media))
  ) {
    throw new Error(`${TAG_VOICI_CALL_REQUEST_ANON}: bad field`);
  }
  return join([TAG_VOICI_CALL_REQUEST_ANON, r.pageId, r.conv, r.callId, r.browserPub, r.callerXwingPub, voiciCallSdpHash(r.offerSdp), r.issuedAt, sha256Hex(utf8(r.pow.challenge)), r.pow.nonce, ...(r.media !== undefined ? [r.media] : [])]);
}

export function signVoiciCallRequestAnonP256(body: VoiciCallRequestAnonBody, browserPriv: Bytes): VoiciCallRequestAnon {
  return { v: 1, kind: "voici-call-request-anon", ...body, sig: hex(p256.sign(canonicalVoiciCallRequestAnon(body), browserPriv, { lowS: true })) };
}

export function parseVoiciCallRequestAnon(v: unknown): VoiciCallRequestAnon | null {
  if (!isObj(v) || !(exactKeys(v, ANON_KEYS) || exactKeys(v, [...ANON_KEYS, "media"])) || v.v !== 1 || v.kind !== "voici-call-request-anon" || !isLowerHex(v.sig, 64)) return null;
  try {
    canonicalVoiciCallRequestAnon(v as unknown as VoiciCallRequestAnon);
  } catch {
    return null;
  }
  return v as unknown as VoiciCallRequestAnon;
}

export type VoiciCallRequestAnonRefusal = "too-large" | "malformed" | "wrong-audience" | "calls-off" | "not-allowed" | "blocked" | "wrong-conv" | "bad-sdp" | "bad-key" | "bad-pow" | "bad-signature" | "stale";

/**
 * Checks an anonymous request, cheapest first: size, shape, page, the page takes anonymous calls, blocked browser
 * key, conv, SDP, X-Wing key, the work, B's signature, freshness. `.com` checks the challenge's MAC, window and
 * spending itself (checkVoiciCallPowChallenge, a spent-once table) around this.
 */
export function checkVoiciCallRequestAnon(
  input: unknown,
  ctx: { pageId: string; acceptsCalls: boolean; callsFrom: string; now: number; blocked?: ReadonlySet<string>; skipFresh?: boolean },
): { ok: true; request: VoiciCallRequestAnon } | Fail<VoiciCallRequestAnonRefusal> {
  const no = (code: VoiciCallRequestAnonRefusal): Fail<VoiciCallRequestAnonRefusal> => ({ ok: false, code });
  try {
    if (utf8(typeof input === "string" ? input : JSON.stringify(input)).length > VOICI_CALL_MAX_REQUEST_BYTES) return no("too-large");
  } catch {
    return no("malformed");
  }
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return no("malformed");
    }
  }
  const r = parseVoiciCallRequestAnon(raw);
  if (!r) return no("malformed");
  if (r.pageId !== ctx.pageId) return no("wrong-audience");
  if (!ctx.acceptsCalls) return no("calls-off");
  if (ctx.callsFrom !== "anyone") return no("not-allowed");
  if (ctx.blocked?.has(r.conv)) return no("blocked");
  if (r.conv !== voiciAnonConv(r.pageId, r.browserPub)) return no("wrong-conv");
  if (checkVoiciCallSdp(r.offerSdp, r.media ?? "audio")) return no("bad-sdp");
  try {
    parseHybridSealPublicKey(hexToBytes(r.callerXwingPub));
  } catch {
    return no("bad-key");
  }
  if (parseVoiciCallPow(r.pow.challenge)?.pageId !== r.pageId || !voiciCallPowSolves(r.pow.challenge, r.pow.nonce)) return no("bad-pow");
  if (!p256VerifyP1363(r.sig, canonicalVoiciCallRequestAnon(r), r.browserPub)) return no("bad-signature");
  if (!ctx.skipFresh && Math.abs(r.issuedAt - ctx.now) > VOICI_CALL_SKEW_MS) return no("stale");
  return { ok: true, request: r };
}

// ── the ring-back channel ──────────────────────────────────────────────────

export interface VoiciRingBackOrder {
  pageId: string;
  conv: string;
  op: "attach" | "stop";
  issuedAt: number;
}

export function canonicalVoiciRingBack(o: VoiciRingBackOrder): Bytes {
  if (!PAGE_ID.test(o.pageId) || !isLowerHex(o.conv, 32) || (o.op !== "attach" && o.op !== "stop") || !isTime(o.issuedAt)) throw new Error(`${TAG_VOICI_RING_BACK}: bad field`);
  return join([TAG_VOICI_RING_BACK, o.pageId, o.conv, o.op, o.issuedAt]);
}

export function parseVoiciRingBackOrder(v: unknown): VoiciRingBackOrder | null {
  if (!isObj(v) || !exactKeys(v, ["pageId", "conv", "op", "issuedAt"])) return null;
  try {
    canonicalVoiciRingBack(v as unknown as VoiciRingBackOrder);
  } catch {
    return null;
  }
  return v as unknown as VoiciRingBackOrder;
}

/** The visitor's app signs with the pseudonym P. */
export function signVoiciRingBackPseudonym(o: VoiciRingBackOrder, pseudonymSeed: Bytes): { order: VoiciRingBackOrder; signer: "pseudonym"; from: string; sig: string } {
  return { order: o, signer: "pseudonym", from: hex(ed.getPublicKey(pseudonymSeed)), sig: hex(ed.sign(canonicalVoiciRingBack(o), pseudonymSeed)) };
}

/** The visitor's browser signs with B, carrying the message cred. Deterministic P-256 for vectors; browsers use WebCrypto. */
export function signVoiciRingBackBrowserP256(o: VoiciRingBackOrder, from: string, cred: unknown, browserPriv: Bytes): { order: VoiciRingBackOrder; signer: "browser"; from: string; cred: unknown; sig: string } {
  return { order: o, signer: "browser", from, cred, sig: hex(p256.sign(canonicalVoiciRingBack(o), browserPriv, { lowS: true })) };
}

export type VoiciRingBackRefusal = "malformed" | "wrong-audience" | "wrong-conv" | "stale" | "bad-attestation" | "bad-delegation" | "bad-thread" | "revoked" | "bad-signature";

/**
 * Checks a channel order: shape, page, conv = the conversation of `from` on the page, freshness, then the signature
 * (P directly, or B under the message cred's attestation, delegation and thread statement).
 */
export function checkVoiciRingBackOrder(
  input: unknown,
  ctx: { pageId: string; origin: string; caKeys: readonly string[]; now: number; revoked?: ReadonlySet<string> },
): { ok: true; order: VoiciRingBackOrder; from: string } | Fail<VoiciRingBackRefusal> {
  const no = (code: VoiciRingBackRefusal): Fail<VoiciRingBackRefusal> => ({ ok: false, code });
  if (!isObj(input) || typeof input.from !== "string" || !isLowerHex(input.from, 32)) return no("malformed");
  const browser = input.signer === "browser";
  if (!(browser ? exactKeys(input, ["order", "signer", "from", "cred", "sig"]) : input.signer === "pseudonym" && exactKeys(input, ["order", "signer", "from", "sig"]))) return no("malformed");
  const o = parseVoiciRingBackOrder(input.order);
  if (!o || typeof input.sig !== "string") return no("malformed");
  if (o.pageId !== ctx.pageId) return no("wrong-audience");
  if (o.conv !== voiciConv(ctx.pageId, input.from)) return no("wrong-conv");
  if (Math.abs(o.issuedAt - ctx.now) > VOICI_CALL_SKEW_MS) return no("stale");
  const bytes = canonicalVoiciRingBack(o);
  if (!browser) return isLowerHex(input.sig, 64) && ed25519VerifyHex(input.sig, bytes, input.from) ? { ok: true, order: o, from: input.from } : no("bad-signature");
  const c = input.cred;
  if (!isObj(c) || !exactKeys(c, ["attestation", "delegation", "delegationSig", "threadStmt", "threadSig"])) return no("malformed");
  const att = checkMessagesKeyAttestation(c.attestation, { caKeys: ctx.caKeys, now: ctx.now, pseudonymPub: input.from });
  if (!att.ok) return no("bad-attestation");
  const del = checkWebDelegation(c.delegation, c.delegationSig, { scope: "voici-messages", origin: ctx.origin, audience: ctx.pageId, principalPub: input.from, now: ctx.now, notAfter: att.attestation.expiresAt });
  if (!del.ok) return no("bad-delegation");
  if (ctx.revoked?.has(del.delegation.delegatePub)) return no("revoked");
  const ts = parseVoiciThreadStatement(c.threadStmt);
  if (!ts || ts.pageId !== ctx.pageId || ts.pseudonymPub !== input.from || typeof c.threadSig !== "string" || !ed25519VerifyHex(c.threadSig, canonicalVoiciThreadStatement(ts), input.from)) return no("bad-thread");
  if (!isLowerHex(input.sig, 64) || !p256VerifyP1363(input.sig, bytes, del.delegation.delegatePub)) return no("bad-signature");
  return { ok: true, order: o, from: input.from };
}

/**
 * The attach body: the signed order (`checkVoiciRingBackOrder`) and, from the caller's app only, an optional
 * `ringTagKey` (64 lowercase hex). Answers the order without it, or null when the key is there in any other shape or
 * rides on a browser's order (a browser attach names no account and gets no push).
 */
export function parseVoiciRingBackBody(v: unknown): { envelope: Record<string, unknown>; ringTagKey: string | null } | null {
  if (!isObj(v)) return null;
  if (!Object.prototype.hasOwnProperty.call(v, "ringTagKey")) return { envelope: v, ringTagKey: null };
  const { ringTagKey, ...envelope } = v;
  if (!isLowerHex(ringTagKey, 32) || envelope.signer !== "pseudonym") return null;
  return { envelope, ringTagKey };
}

/** The caller's per-page ring tag key: every device of the account derives the same one from the Messages secret. */
export function deriveVoiciRingTagKey(messagesSecret: Bytes, pageId: string): Bytes {
  if (!PAGE_ID.test(pageId)) throw new Error(`${TAG_VOICI_RING_TAG}: bad pageId`);
  return hkdf(sha256, messagesSecret, new Uint8Array(0), utf8(`${TAG_VOICI_RING_TAG}|${pageId}`), 32);
}

/** The ring push's `tag` for one ring: 16 bytes, hex. */
export function voiciRingTag(tagKey: Bytes, ringId: string): string {
  if (tagKey.length !== 32 || !isLowerHex(ringId, 16)) throw new Error(`${TAG_VOICI_RING_TAG}: bad field`);
  return hex(hmac(sha256, tagKey, utf8(ringId))).slice(0, 32);
}

/** Where a locked owner's phone keeps a caller's nickname: 16 bytes of a hash of the pseudonym pub, hex. */
export function voiciLockedNameKey(pseudonymPub: string): string {
  return hex(sha256(utf8(`${TAG_VOICI_LOCKED_NAME}|${pseudonymPub}`))).slice(0, 32);
}

// ── the ring ───────────────────────────────────────────────────────────────

export interface VoiciRingHint {
  v: 1;
  pageId: string;
  username: string;
  conv: string;
  ringId: string;
  media: VoiciCallMedia;
  issuedAt: number;
}

export interface VoiciRing {
  pageId: string;
  conv: string;
  ringId: string;
  hint: string;
  media: VoiciCallMedia;
  issuedAt: number;
}

export function sealVoiciRingHint(threadPub: Bytes, h: Omit<VoiciRingHint, "v">, eseed: Bytes = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN))): Bytes {
  if (!PAGE_ID.test(h.pageId) || !USERNAME.test(h.username) || !isLowerHex(h.conv, 32) || !isLowerHex(h.ringId, 16) || !isMedia(h.media) || !isTime(h.issuedAt)) throw new Error(`${TAG_VOICI_RING_HINT}: bad field`);
  return hybridSealWithRandomness(
    parseHybridSealPublicKey(threadPub),
    { purpose: TAG_VOICI_RING_HINT, senderKeyId: new Uint8Array(32), issuedAt: h.issuedAt },
    [utf8(h.conv), utf8(h.ringId)],
    canonicalJsonBytes({ v: 1, pageId: h.pageId, username: h.username, conv: h.conv, ringId: h.ringId, media: h.media, issuedAt: h.issuedAt }),
    eseed,
  );
}

/** The visitor's app: the hint, when it opens under this T for this conv and ring and names them. */
export function openVoiciRingHint(threadSeed: Bytes, conv: string, ringId: string, sealed: Bytes): VoiciRingHint | null {
  try {
    const { plaintext } = hybridOpen(threadSeed, TAG_VOICI_RING_HINT, [utf8(conv), utf8(ringId)], sealed);
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as Record<string, unknown>;
    if (!isObj(v) || !exactKeys(v, ["v", "pageId", "username", "conv", "ringId", "media", "issuedAt"]) || v.v !== 1 || v.conv !== conv || v.ringId !== ringId) return null;
    if (typeof v.pageId !== "string" || !PAGE_ID.test(v.pageId) || typeof v.username !== "string" || !USERNAME.test(v.username) || !isMedia(v.media) || !isTime(v.issuedAt)) return null;
    return v as unknown as VoiciRingHint;
  } catch {
    return null;
  }
}

export function canonicalVoiciRing(r: VoiciRing): Bytes {
  if (!PAGE_ID.test(r.pageId) || !isLowerHex(r.conv, 32) || !isLowerHex(r.ringId, 16) || typeof r.hint !== "string" || !isMedia(r.media) || !isTime(r.issuedAt)) throw new Error(`${TAG_VOICI_RING}: bad field`);
  return join([TAG_VOICI_RING, r.pageId, r.conv, r.ringId, sha256Hex(b64Decode(r.hint) ?? utf8("")), r.media, r.issuedAt]);
}

export function signVoiciRing(r: VoiciRing, ownerSignSeed: Bytes): string {
  return hex(ed.sign(canonicalVoiciRing(r), ownerSignSeed));
}

export function parseVoiciRing(v: unknown): VoiciRing | null {
  if (!isObj(v) || !exactKeys(v, ["pageId", "conv", "ringId", "hint", "media", "issuedAt"])) return null;
  if (typeof v.hint !== "string" || v.hint.length > 4096 || !b64Decode(v.hint)) return null;
  try {
    canonicalVoiciRing(v as unknown as VoiciRing);
  } catch {
    return null;
  }
  return v as unknown as VoiciRing;
}

export function verifyVoiciRing(r: VoiciRing, signature: unknown, ownerSignPub: string): boolean {
  return typeof signature === "string" && isLowerHex(signature, 64) && ed25519VerifyHex(signature, canonicalVoiciRing(r), ownerSignPub);
}
