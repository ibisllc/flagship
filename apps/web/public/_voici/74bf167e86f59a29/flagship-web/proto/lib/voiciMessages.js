// voi.ci Messages (docs/voici-and-messages.md §6-§10, §8.2): derivations from the UMK, the conversation id, the
// sealed body, the thread statement, "Sign in with Flagship" delegations, Messages key attestations (checked, never
// issued here), the voici-message / voici-reply / voici-draft checks, acks, blocks, draft ops, the Messages state
// blob, reports, the sign-in pipe payloads and the phone endpoint's web policy. Browser twin of
// packages/protocol/src/voiciMessages.ts, webDelegation.ts, messagesAttestation.ts (request + check only) and the
// phoneWebCheck section of phoneRoute.ts, byte for byte (shared vectors in packages/protocol/test-vectors/messages/).
// Import it through lib/voiciProtocol.js.
//
// The webapp is a full account device for Messages (spec §9.5): every sign / seal / derive function here takes the
// key or UMK seed its caller holds; nothing reads storage or the network.

import {
  aesGcm,
  b64Decode,
  b64Encode,
  canonicalJson,
  canonicalJsonBytes,
  ed25519PublicKey,
  ed25519SignHex,
  ed25519VerifyHex,
  hex,
  hexToBytes,
  hkdfSha256,
  hybridOpen,
  hybridSealKeygen,
  hybridSealWithRandomness,
  HYBRID_SEAL_RANDOMNESS_LEN,
  isLowerHex,
  p256VerifyP1363,
  parseWebEnvelope,
  pqKeyId,
  sha256,
  sha256Hex,
  SUITE_HYBRID_SEAL_V1,
  TAG_HYBRID_SEAL_V1,
  verifyWebEnvelopeSignature,
  WEB_ENVELOPE_MAX_BODY_BYTES,
  WEB_ENVELOPE_MAX_BYTES,
} from "./voiciCore.js";
import { checkVoiciText } from "./voiciText.js";
import { isVoiciJpeg, parseVoiciPost, parseVoiciProfile } from "./voiciPage.js";

export const TAG_VOICI_INBOX = "flagship/voici-inbox/v1";
export const TAG_VOICI_OWNER_SIGN = "flagship/voici-owner-sign/v1";
export const TAG_MESSAGES_SECRET = "flagship/messages-secret/v1";
export const TAG_MESSAGES_PSEUDONYM = "flagship/messages-pseudonym/v1";
export const TAG_MESSAGES_THREAD = "flagship/messages-thread/v1";
export const TAG_VOICI_DRAFTS = "flagship/voici-drafts/v1";
export const TAG_MESSAGES_STATE = "flagship/messages-state/v1";
export const TAG_VOICI_CONV = "flagship/voici-conv/v1";
export const TAG_VOICI_BODY = "flagship/voici-body/v1";
export const TAG_VOICI_CEK = "flagship/voici-cek/v1";
export const TAG_VOICI_THREAD_KEY = "flagship/voici-thread-key/v1";
export const TAG_VOICI_ACK = "flagship/voici-ack/v1";
export const TAG_VOICI_BLOCK = "flagship/voici-block/v1";
export const TAG_VOICI_DRAFT = "flagship/voici-draft/v1";
export const TAG_VOICI_REPORT = "flagship/voici-report/v1";
export const TAG_VOICI_SIGN_IN = "flagship/voici-sign-in/v1";
export const TAG_VOICI_SIGN_IN_REQUEST = "flagship/voici-sign-in-request/v1";
export const TAG_WEB_DELEGATION = "flagship/web-delegation/v1";
export const TAG_WEB_DELEGATION_REVOKE = "flagship/web-delegation-revoke/v1";
export const TAG_MESSAGES_KEY_ATTESTATION = "flagship/messages-key-attestation/v1";
export const TAG_MESSAGES_KEY_ATTESTATION_REQUEST = "flagship/messages-key-attestation-request/v1";

export const VOICI_SEND_SKEW_MS = 10 * 60_000;
export const VOICI_DRAFT_MAX_ENVELOPE_BYTES = 1024 * 1024;
export const VOICI_DRAFT_MAX_BODY_BYTES = 960 * 1024;
export const VOICI_DRAFT_MAX_IMAGE_BYTES = 150 * 1024;
export const VOICI_DRAFT_MAX_IMAGES = 4;
export const VOICI_STATE_MAX_BYTES = 256 * 1024;

const enc = (s) => new TextEncoder().encode(s);
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function exactKeys(r, required, optional = []) {
  const ks = Object.keys(r);
  return required.every((k) => k in r) && ks.every((k) => required.includes(k) || optional.includes(k));
}
const sameKeys = (r, keys) => {
  const got = Object.keys(r).sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
};

// ── web delegation (webDelegation.ts) ─────────────────────────────────────

export const WEB_DELEGATION_SCOPES = ["voici-messages"];
export const VOICI_WEB_ORIGIN = "https://voi.ci";
export const VOICI_WEB_ORIGIN_GYM = "https://gym.voi.ci";
const ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const AUDIENCE = /^[a-z0-9-]{1,64}$/;
const isP256Pub = (s) => isLowerHex(s, 65) && s.startsWith("04");

export function canonicalWebDelegation(d) {
  if (!WEB_DELEGATION_SCOPES.includes(d.scope)) throw new Error(`${TAG_WEB_DELEGATION}: bad scope`);
  if (typeof d.origin !== "string" || !ORIGIN.test(d.origin)) throw new Error(`${TAG_WEB_DELEGATION}: bad origin`);
  if (typeof d.audience !== "string" || !AUDIENCE.test(d.audience)) throw new Error(`${TAG_WEB_DELEGATION}: bad audience`);
  if (!isLowerHex(d.principalPub, 32)) throw new Error(`${TAG_WEB_DELEGATION}: bad principalPub`);
  if (d.delegateAlg !== "p256" || !isP256Pub(d.delegatePub)) throw new Error(`${TAG_WEB_DELEGATION}: bad delegate`);
  if (!isTime(d.issuedAt) || !isTime(d.expiresAt) || d.expiresAt <= d.issuedAt) throw new Error(`${TAG_WEB_DELEGATION}: bad time`);
  if (!isLowerHex(d.nonce, 16)) throw new Error(`${TAG_WEB_DELEGATION}: bad nonce`);
  return enc([TAG_WEB_DELEGATION, d.scope, d.origin, d.audience, d.principalPub, d.delegateAlg, d.delegatePub, String(d.issuedAt), String(d.expiresAt), d.nonce].join("|"));
}

/** Ed25519 signature (hex) by the principal's 32-byte seed (for voi.ci, the pseudonym key P). */
export function signWebDelegation(d, principalSeed) {
  return ed25519SignHex(canonicalWebDelegation(d), principalSeed);
}

export function parseWebDelegation(v) {
  if (!isObj(v)) return null;
  if (!sameKeys(v, ["audience", "delegateAlg", "delegatePub", "expiresAt", "issuedAt", "nonce", "origin", "principalPub", "scope"])) return null;
  try {
    canonicalWebDelegation(v);
  } catch {
    return null;
  }
  return { scope: v.scope, origin: v.origin, audience: v.audience, principalPub: v.principalPub, delegateAlg: v.delegateAlg, delegatePub: v.delegatePub, issuedAt: v.issuedAt, expiresAt: v.expiresAt, nonce: v.nonce };
}

/** want = {scope, origin, audience, principalPub, now, notAfter?}; {ok:true, delegation} | {ok:false, code}. */
export function checkWebDelegation(d, signature, want) {
  const p = parseWebDelegation(d);
  if (!p || typeof signature !== "string") return { ok: false, code: "malformed" };
  if (!ed25519VerifyHex(signature, canonicalWebDelegation(p), p.principalPub)) return { ok: false, code: "bad-signature" };
  if (p.scope !== want.scope) return { ok: false, code: "wrong-scope" };
  if (p.origin !== want.origin) return { ok: false, code: "wrong-origin" };
  if (p.audience !== want.audience) return { ok: false, code: "wrong-audience" };
  if (p.principalPub !== want.principalPub) return { ok: false, code: "wrong-principal" };
  if (want.notAfter !== undefined && p.expiresAt > want.notAfter) return { ok: false, code: "too-long" };
  if (want.now < p.issuedAt) return { ok: false, code: "not-yet-valid" };
  if (want.now >= p.expiresAt) return { ok: false, code: "expired" };
  return { ok: true, delegation: p };
}

export function canonicalWebDelegationRevoke(r) {
  if (!isP256Pub(r.delegatePub)) throw new Error(`${TAG_WEB_DELEGATION_REVOKE}: bad delegatePub`);
  if (!isTime(r.issuedAt)) throw new Error(`${TAG_WEB_DELEGATION_REVOKE}: bad issuedAt`);
  return enc([TAG_WEB_DELEGATION_REVOKE, r.delegatePub, String(r.issuedAt)].join("|"));
}

export function signWebDelegationRevoke(r, principalSeed) {
  return ed25519SignHex(canonicalWebDelegationRevoke(r), principalSeed);
}

export function verifyWebDelegationRevoke(r, signature, principalPub) {
  try {
    return ed25519VerifyHex(signature, canonicalWebDelegationRevoke(r), principalPub);
  } catch {
    return false;
  }
}

export function parseWebDelegationRevoke(v) {
  if (!isObj(v) || !sameKeys(v, ["delegatePub", "issuedAt"])) return null;
  if (!isP256Pub(v.delegatePub) || !isTime(v.issuedAt)) return null;
  return { delegatePub: v.delegatePub, issuedAt: v.issuedAt };
}

// ── Messages key attestations (messagesAttestation.ts: request + check) ───

export const MESSAGES_ATTESTATION_TTL_MS = 30 * 86_400_000;
export const MESSAGES_ATTESTATION_RENEW_GRACE_MS = 7 * 86_400_000;
export const MESSAGES_ATTESTATION_REQUEST_SKEW_MS = 10 * 60_000;
export const DEVICE_CHECK_REFS = ["ios", "android", "none"];
const ABUSE_TAG_MAX_BYTES = 4096;

export function canonicalMessagesKeyAttestationRequest(r) {
  const T = TAG_MESSAGES_KEY_ATTESTATION_REQUEST;
  if (typeof r.username !== "string" || !USERNAME.test(r.username)) throw new Error(`${T}: bad username`);
  if (!isLowerHex(r.pseudonymPub, 32)) throw new Error(`${T}: bad pseudonymPub`);
  if (r.renewOfHash !== "" && !isLowerHex(r.renewOfHash, 32)) throw new Error(`${T}: bad renewOfHash`);
  if (!DEVICE_CHECK_REFS.includes(r.deviceCheckRef)) throw new Error(`${T}: bad deviceCheckRef`);
  if (!isTime(r.issuedAt)) throw new Error(`${T}: bad issuedAt`);
  return enc([T, r.username, r.pseudonymPub, r.renewOfHash, r.deviceCheckRef, String(r.issuedAt)].join("|"));
}

/** Signed by an account device key (the webapp's own: deviceCheckRef "none", the unattested tier, §9.5). */
export function signMessagesKeyAttestationRequest(r, deviceSeed) {
  return ed25519SignHex(canonicalMessagesKeyAttestationRequest(r), deviceSeed);
}

export function verifyMessagesKeyAttestationRequest(r, signature, devicePub) {
  try {
    return ed25519VerifyHex(signature, canonicalMessagesKeyAttestationRequest(r), devicePub);
  } catch {
    return false;
  }
}

export function canonicalMessagesKeyAttestation(b) {
  const T = TAG_MESSAGES_KEY_ATTESTATION;
  if (!isLowerHex(b.pseudonymPub, 32)) throw new Error(`${T}: bad pseudonymPub`);
  if (!isTime(b.abuseEpoch) || b.abuseEpoch < 1) throw new Error(`${T}: bad abuseEpoch`);
  if (!isLowerHex(b.abuseTagHash, 32)) throw new Error(`${T}: bad abuseTagHash`);
  if (!isTime(b.issuedAt) || !isTime(b.expiresAt) || b.expiresAt <= b.issuedAt) throw new Error(`${T}: bad time`);
  return enc([T, b.pseudonymPub, String(b.abuseEpoch), b.abuseTagHash, String(b.issuedAt), String(b.expiresAt)].join("|"));
}

const ATTESTATION_KEYS = ["abuseEpoch", "abuseTag", "abuseTagHash", "expiresAt", "issuedAt", "kind", "pseudonymPub", "signature", "signedBy", "version"];

export function parseMessagesKeyAttestation(v) {
  if (!isObj(v) || !sameKeys(v, ATTESTATION_KEYS)) return null;
  if (v.kind !== "MessagesKeyAttestation" || v.version !== 1) return null;
  const tag = b64Decode(v.abuseTag);
  if (!tag || tag.length > ABUSE_TAG_MAX_BYTES) return null;
  if (!isLowerHex(v.signedBy, 32) || !isLowerHex(v.signature, 64)) return null;
  try {
    canonicalMessagesKeyAttestation(v);
  } catch {
    return null;
  }
  return {
    kind: "MessagesKeyAttestation",
    version: 1,
    pseudonymPub: v.pseudonymPub,
    abuseEpoch: v.abuseEpoch,
    abuseTagHash: v.abuseTagHash,
    abuseTag: v.abuseTag,
    issuedAt: v.issuedAt,
    expiresAt: v.expiresAt,
    signedBy: v.signedBy,
    signature: v.signature,
  };
}

/** What a renewal names: SHA-256 hex of the canonical JSON of the previous attestation. */
export function messagesAttestationHash(a) {
  return sha256Hex(canonicalJsonBytes(a));
}

/**
 * o = {caKeys, now, pseudonymPub?}: shape, signedBy among caKeys, the CA signature, H(abuseTag) = abuseTagHash (the
 * tag itself stays sealed), the key, and now inside [issuedAt, expiresAt).
 */
export function checkMessagesKeyAttestation(v, o) {
  const a = parseMessagesKeyAttestation(v);
  if (!a) return { ok: false, code: "malformed" };
  if (!o.caKeys.includes(a.signedBy)) return { ok: false, code: "unknown-ca" };
  if (!ed25519VerifyHex(a.signature, canonicalMessagesKeyAttestation(a), a.signedBy)) return { ok: false, code: "bad-signature" };
  if (sha256Hex(b64Decode(a.abuseTag)) !== a.abuseTagHash) return { ok: false, code: "bad-abuse-tag" };
  if (o.pseudonymPub !== undefined && a.pseudonymPub !== o.pseudonymPub) return { ok: false, code: "wrong-key" };
  if (o.now < a.issuedAt) return { ok: false, code: "not-yet-valid" };
  if (o.now >= a.expiresAt) return { ok: false, code: "expired" };
  return { ok: true, attestation: a };
}

// ── derivations (HKDF-SHA256, empty salt, 32 bytes) ───────────────────────

function needPageId(pageId) {
  if (typeof pageId !== "string" || !PAGE_ID.test(pageId)) throw new Error("pageId must be 16 bytes of lowercase hex");
}
function needEpoch(e) {
  if (!Number.isSafeInteger(e) || e < 1) throw new Error("inboxEpoch must be an integer >= 1");
}

/** umk = {seed: Uint8Array(32)}. The owner's inbox X-Wing key {seed, publicKey (1216)}. */
export function deriveVoiciInboxKey(umk, pageId, inboxEpoch) {
  needPageId(pageId);
  needEpoch(inboxEpoch);
  const seed = hkdfSha256(umk.seed, `${TAG_VOICI_INBOX}|${pageId}|${inboxEpoch}`);
  return { seed, publicKey: hybridSealKeygen(seed).publicKey };
}

/** The owner's messages signing key (Ed25519): signs replies, blocks and phone acks. */
export function deriveVoiciOwnerSignKey(umk, pageId, inboxEpoch) {
  needPageId(pageId);
  needEpoch(inboxEpoch);
  const seed = hkdfSha256(umk.seed, `${TAG_VOICI_OWNER_SIGN}|${pageId}|${inboxEpoch}`);
  return { seed, publicKey: ed25519PublicKey(seed) };
}

export function deriveMessagesSecret(umk) {
  return hkdfSha256(umk.seed, TAG_MESSAGES_SECRET);
}

/** The sender's pseudonym key P toward one page (Ed25519). */
export function deriveMessagesPseudonymKey(messagesSecret, pageId) {
  needPageId(pageId);
  const seed = hkdfSha256(messagesSecret, `${TAG_MESSAGES_PSEUDONYM}|${pageId}`);
  return { seed, publicKey: ed25519PublicKey(seed) };
}

/** The sender's thread key T toward one page (X-Wing). */
export function deriveMessagesThreadKey(messagesSecret, pageId) {
  needPageId(pageId);
  const seed = hkdfSha256(messagesSecret, `${TAG_MESSAGES_THREAD}|${pageId}`);
  return { seed, publicKey: hybridSealKeygen(seed).publicKey };
}

export function deriveVoiciDraftsKey(umk) {
  return hkdfSha256(umk.seed, TAG_VOICI_DRAFTS);
}

export function deriveMessagesStateKey(umk) {
  return hkdfSha256(umk.seed, TAG_MESSAGES_STATE);
}

export function voiciConv(pageId, pseudonymPub) {
  needPageId(pageId);
  if (!isLowerHex(pseudonymPub, 32)) throw new Error("pseudonym key must be 32 bytes of lowercase hex");
  return sha256Hex(`${TAG_VOICI_CONV}|${pageId}|${pseudonymPub}`);
}

// ── sealed body ───────────────────────────────────────────────────────────

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

function plaintextBytes(p) {
  const t = checkVoiciText("messageText", p.text);
  if (t) throw new Error(`voici body: text refused (${t})`);
  if (p.replyTo !== null && !isLowerHex(p.replyTo, 16)) throw new Error("voici body: bad replyTo");
  return canonicalJsonBytes({ v: 1, text: p.text, replyTo: p.replyTo });
}

/**
 * o = {conv, msgId, sentAt, fromPub, recipients: [Uint8Array, Uint8Array], plaintext: {v:1, text, replyTo}};
 * recipients [inboxPub, threadPub] for a message, [threadPub, inboxPub] for a reply. `rnd` = {cek, nonce, eseeds}
 * only for vectors. Returns the body bytes (canonical JSON).
 */
export function sealVoiciBody(o, rnd) {
  if (!isLowerHex(o.msgId, 16) || !isLowerHex(o.conv, 32) || !isLowerHex(o.fromPub)) throw new Error("voici body: bad ids");
  const cek = rnd?.cek ?? rand(32);
  const nonce = rnd?.nonce ?? rand(12);
  if (cek.length !== 32 || nonce.length !== 12) throw new Error("voici body: bad randomness");
  const ct = aesGcm(cek, nonce, enc(`${TAG_VOICI_BODY}|${o.conv}|${o.msgId}`)).encrypt(plaintextBytes(o.plaintext));
  const wraps = o.recipients.map((pub, i) => {
    const eseed = rnd?.eseeds[i] ?? rand(HYBRID_SEAL_RANDOMNESS_LEN);
    const sealed = hybridSealWithRandomness(pub, { purpose: TAG_VOICI_CEK, senderKeyId: sha256(hexToBytes(o.fromPub)), issuedAt: o.sentAt }, [enc(o.conv), enc(o.msgId)], cek, eseed);
    return { keyId: hex(pqKeyId(SUITE_HYBRID_SEAL_V1, pub)), sealed: b64Encode(sealed) };
  });
  return canonicalJsonBytes({ suite: TAG_HYBRID_SEAL_V1, nonce: hex(nonce), ct: b64Encode(ct), wraps });
}

/** Strict outer schema of a sealed body: canonical JSON, exactly two wraps; null when malformed. */
export function parseVoiciSealedBody(bodyBytes) {
  let r;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bodyBytes);
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(r) || !exactKeys(r, ["suite", "nonce", "ct", "wraps"]) || r.suite !== TAG_HYBRID_SEAL_V1) return null;
  if (!isLowerHex(r.nonce, 12) || !b64Decode(r.ct) || !Array.isArray(r.wraps) || r.wraps.length !== 2) return null;
  for (const w of r.wraps) {
    if (!isObj(w) || !exactKeys(w, ["keyId", "sealed"]) || !isLowerHex(w.keyId, 32) || !b64Decode(w.sealed)) return null;
  }
  try {
    if (canonicalJson(r) !== text) return null;
  } catch {
    return null;
  }
  return r;
}

/** {ok:true, plaintext} | {ok:false, code: malformed|no-wrap|decrypt-failed|inner-schema|<text refusal>}. */
export function openVoiciBody(bodyBytes, o, recipientSeed) {
  const b = parseVoiciSealedBody(bodyBytes);
  if (!b) return { ok: false, code: "malformed" };
  const myId = hex(pqKeyId(SUITE_HYBRID_SEAL_V1, hybridSealKeygen(recipientSeed).publicKey));
  const w = b.wraps.find((x) => x.keyId === myId);
  if (!w) return { ok: false, code: "no-wrap" };
  let pt;
  try {
    const cek = hybridOpen(recipientSeed, TAG_VOICI_CEK, [enc(o.conv), enc(o.msgId)], b64Decode(w.sealed)).plaintext;
    if (cek.length !== 32) return { ok: false, code: "decrypt-failed" };
    pt = aesGcm(cek, hexToBytes(b.nonce), enc(`${TAG_VOICI_BODY}|${o.conv}|${o.msgId}`)).decrypt(b64Decode(b.ct));
  } catch {
    return { ok: false, code: "decrypt-failed" };
  }
  let text;
  let r;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt);
    r = JSON.parse(text);
  } catch {
    return { ok: false, code: "inner-schema" };
  }
  if (!isObj(r) || !exactKeys(r, ["v", "text", "replyTo"]) || r.v !== 1 || typeof r.text !== "string") return { ok: false, code: "inner-schema" };
  if (r.replyTo !== null && !isLowerHex(r.replyTo, 16)) return { ok: false, code: "inner-schema" };
  const tr = checkVoiciText("messageText", r.text);
  if (tr) return { ok: false, code: tr };
  try {
    if (canonicalJson(r) !== text) return { ok: false, code: "inner-schema" };
  } catch {
    return { ok: false, code: "inner-schema" };
  }
  return { ok: true, plaintext: { v: 1, text: r.text, replyTo: r.replyTo } };
}

// ── thread statement: <tag>|<pageId>|<Ppub>|<Tpub>|<issuedAt>, signed by P ─

export function canonicalVoiciThreadStatement(s) {
  needPageId(s.pageId);
  if (!isLowerHex(s.pseudonymPub, 32) || !isLowerHex(s.threadPub, 1216) || !isTime(s.issuedAt)) throw new Error(`${TAG_VOICI_THREAD_KEY}: bad field`);
  return enc([TAG_VOICI_THREAD_KEY, s.pageId, s.pseudonymPub, s.threadPub, String(s.issuedAt)].join("|"));
}

export function signVoiciThreadStatement(s, pseudonymSeed) {
  return ed25519SignHex(canonicalVoiciThreadStatement(s), pseudonymSeed);
}

export function parseVoiciThreadStatement(v) {
  if (!isObj(v) || !exactKeys(v, ["pageId", "pseudonymPub", "threadPub", "issuedAt"])) return null;
  try {
    canonicalVoiciThreadStatement(v);
  } catch {
    return null;
  }
  return { pageId: v.pageId, pseudonymPub: v.pseudonymPub, threadPub: v.threadPub, issuedAt: v.issuedAt };
}

// ── envelope checks ───────────────────────────────────────────────────────

const no = (code) => ({ ok: false, code });

function outer(input, maxEnvelope, maxBody) {
  if (typeof input === "string" && enc(input).length > maxEnvelope) return no("too-large");
  if (typeof input !== "string") {
    try {
      if (enc(JSON.stringify(input)).length > maxEnvelope) return no("too-large");
    } catch {
      return no("malformed");
    }
  }
  return parseWebEnvelope(input, maxBody) ?? no("malformed");
}
const failed = (x) => "ok" in x;
const fresh = (sentAt, now) => Math.abs(sentAt - now) <= VOICI_SEND_SKEW_MS;

/**
 * The receiver's checks for a voici-message, cheapest first. ctx = {pageId, acceptsMessages, origin, caKeys, now,
 * blocked?: Set, revoked?: Set, rateLimit?: (env) => "rate-limited" | null}. {ok:true, envelope, cred} | {ok:false, code}.
 */
export function checkVoiciMessage(input, ctx) {
  const env = outer(input, WEB_ENVELOPE_MAX_BYTES, WEB_ENVELOPE_MAX_BODY_BYTES);
  if (failed(env)) return env;
  if (env.kind !== "voici-message" || env.sigAlg !== "p256") return no("wrong-kind");
  if (!isLowerHex(env.from, 32) || !isLowerHex(env.conv, 32)) return no("malformed");
  if (!parseVoiciSealedBody(b64Decode(env.bodyB64))) return no("malformed");
  const c = env.cred;
  if (!exactKeys(c, ["attestation", "delegation", "delegationSig", "threadStmt", "threadSig"])) return no("malformed");
  if (env.audience !== ctx.pageId) return no("wrong-audience");
  if (!ctx.acceptsMessages) return no("not-accepting");
  if (ctx.blocked?.has(env.from)) return no("blocked");
  const delegatePub = isObj(c.delegation) ? c.delegation.delegatePub : undefined;
  if (typeof delegatePub === "string" && ctx.revoked?.has(delegatePub)) return no("revoked");
  const limited = ctx.rateLimit?.(env);
  if (limited) return no(limited);
  const att = checkMessagesKeyAttestation(c.attestation, { caKeys: ctx.caKeys, now: ctx.now, pseudonymPub: env.from });
  if (!att.ok) return no("bad-attestation");
  const del = checkWebDelegation(c.delegation, c.delegationSig, {
    scope: "voici-messages",
    origin: ctx.origin,
    audience: ctx.pageId,
    principalPub: env.from,
    now: ctx.now,
    notAfter: att.attestation.expiresAt,
  });
  if (!del.ok) return no("bad-delegation");
  const ts = parseVoiciThreadStatement(c.threadStmt);
  if (!ts || ts.pageId !== ctx.pageId || ts.pseudonymPub !== env.from || typeof c.threadSig !== "string") return no("bad-thread");
  if (!ed25519VerifyHex(c.threadSig, canonicalVoiciThreadStatement(ts), env.from)) return no("bad-thread");
  if (env.conv !== voiciConv(ctx.pageId, env.from)) return no("wrong-conv");
  if (!verifyWebEnvelopeSignature(env, del.delegation.delegatePub)) return no("bad-signature");
  if (!fresh(env.sentAt, ctx.now)) return no("stale");
  return { ok: true, envelope: env, cred: { attestation: att.attestation, delegation: del.delegation, delegationSig: c.delegationSig, threadStmt: ts, threadSig: c.threadSig } };
}

/** A voici-reply; ctx = {pageId, ownerSignPub, conv?, freshAt?}. {ok:true, envelope, pageSeq} | {ok:false, code}. */
export function checkVoiciReply(input, ctx) {
  const env = outer(input, WEB_ENVELOPE_MAX_BYTES, WEB_ENVELOPE_MAX_BODY_BYTES);
  if (failed(env)) return env;
  if (env.kind !== "voici-reply" || env.sigAlg !== "ed25519") return no("wrong-kind");
  if (!isLowerHex(env.conv, 32) || !exactKeys(env.cred, ["pageSeq"]) || !isTime(env.cred.pageSeq) || env.cred.pageSeq < 1) return no("malformed");
  if (!parseVoiciSealedBody(b64Decode(env.bodyB64))) return no("malformed");
  if (env.audience !== ctx.pageId) return no("wrong-audience");
  if (ctx.conv !== undefined && env.conv !== ctx.conv) return no("wrong-conv");
  if (env.from !== ctx.ownerSignPub || !verifyWebEnvelopeSignature(env, ctx.ownerSignPub)) return no("bad-signature");
  if (ctx.freshAt !== undefined && !fresh(env.sentAt, ctx.freshAt)) return no("stale");
  return { ok: true, envelope: env, pageSeq: env.cred.pageSeq };
}

/** A voici-draft; ctx = {username, checkGrant(grant, grantSignature, devicePub) => boolean, freshAt?}. */
export function checkVoiciDraft(input, ctx) {
  const env = outer(input, VOICI_DRAFT_MAX_ENVELOPE_BYTES, VOICI_DRAFT_MAX_BODY_BYTES);
  if (failed(env)) return env;
  if (env.kind !== "voici-draft" || env.sigAlg !== "ed25519") return no("wrong-kind");
  if (env.conv !== "" || !isLowerHex(env.from, 32) || !exactKeys(env.cred, ["grant", "grantSignature"]) || !isLowerHex(env.cred.grantSignature, 64)) return no("malformed");
  if (!parseVoiciDraftBody(b64Decode(env.bodyB64))) return no("malformed");
  if (env.audience !== ctx.username) return no("wrong-audience");
  if (!verifyWebEnvelopeSignature(env, env.from)) return no("bad-signature");
  if (!ctx.checkGrant(env.cred.grant, env.cred.grantSignature, env.from)) return no("bad-grant");
  if (ctx.freshAt !== undefined && !fresh(env.sentAt, ctx.freshAt)) return no("stale");
  return { ok: true, envelope: env };
}

// ── phone ack: <tag>|<conv>|<msgId>|<receivedAt>|<phoneRoutePub> ──────────

export function canonicalVoiciAck(a) {
  if ((a.conv !== "" && !isLowerHex(a.conv, 32)) || !isLowerHex(a.msgId, 16) || !isTime(a.receivedAt) || !isLowerHex(a.phoneRoutePub) || a.phoneRoutePub.length === 0) {
    throw new Error(`${TAG_VOICI_ACK}: bad field`);
  }
  return enc([TAG_VOICI_ACK, a.conv, a.msgId, String(a.receivedAt), a.phoneRoutePub].join("|"));
}

export function signVoiciAck(a, seed) {
  return { ...a, signature: ed25519SignHex(canonicalVoiciAck(a), seed) };
}

/** Shape + signature by `signerPub` + it acknowledges want.msgId (and want.conv when given); the ack or null. */
export function verifyVoiciAck(v, signerPub, want) {
  if (!isObj(v) || !exactKeys(v, ["conv", "msgId", "receivedAt", "phoneRoutePub", "signature"]) || typeof v.signature !== "string") return null;
  const a = { conv: v.conv, msgId: v.msgId, receivedAt: v.receivedAt, phoneRoutePub: v.phoneRoutePub };
  let bytes;
  try {
    bytes = canonicalVoiciAck(a);
  } catch {
    return null;
  }
  if (a.msgId !== want.msgId || (want.conv !== undefined && a.conv !== want.conv)) return null;
  return ed25519VerifyHex(v.signature, bytes, signerPub) ? a : null;
}

// ── block: <tag>|<pageId>|<Ppub>|block|unblock|<issuedAt> ─────────────────

export function canonicalVoiciBlock(b) {
  needPageId(b.pageId);
  if (!isLowerHex(b.pseudonymPub, 32) || (b.op !== "block" && b.op !== "unblock") || !isTime(b.issuedAt)) throw new Error(`${TAG_VOICI_BLOCK}: bad field`);
  return enc([TAG_VOICI_BLOCK, b.pageId, b.pseudonymPub, b.op, String(b.issuedAt)].join("|"));
}

export function signVoiciBlock(b, ownerSignSeed) {
  return ed25519SignHex(canonicalVoiciBlock(b), ownerSignSeed);
}

export function verifyVoiciBlock(b, signature, ownerSignPub) {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciBlock(b), ownerSignPub);
  } catch {
    return false;
  }
}

export function parseVoiciBlock(v) {
  if (!isObj(v) || !exactKeys(v, ["pageId", "pseudonymPub", "op", "issuedAt"])) return null;
  try {
    canonicalVoiciBlock(v);
  } catch {
    return null;
  }
  return { pageId: v.pageId, pseudonymPub: v.pseudonymPub, op: v.op, issuedAt: v.issuedAt };
}

// ── draft ops (§5.2) ──────────────────────────────────────────────────────

export const VOICI_DRAFT_OP_KINDS = ["post-add", "post-edit", "post-delete", "profile", "accept-messages"];
const OP_FIELD = { "post-add": "post", "post-edit": "post", "post-delete": "postId", profile: "profile", "accept-messages": "accepts" };

/** Strict schema of a draft op {v:1, opId, op, at, deviceId, post?|postId?|profile?|accepts?, images?}; null when malformed. */
export function parseVoiciDraftOp(v) {
  if (!isObj(v) || v.v !== 1 || !isLowerHex(v.opId, 16) || !isTime(v.at)) return null;
  if (typeof v.op !== "string" || !VOICI_DRAFT_OP_KINDS.includes(v.op)) return null;
  if (typeof v.deviceId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(v.deviceId)) return null;
  const field = OP_FIELD[v.op];
  if (!exactKeys(v, ["v", "opId", "op", "at", "deviceId", field], ["images"])) return null;
  const out = { v: 1, opId: v.opId, op: v.op, at: v.at, deviceId: v.deviceId };
  if (field === "post") {
    const p = parseVoiciPost(v.post);
    if (!p) return null;
    out.post = p;
  } else if (field === "postId") {
    if (!isLowerHex(v.postId, 16)) return null;
    out.postId = v.postId;
  } else if (field === "profile") {
    const p = parseVoiciProfile(v.profile);
    if (!p) return null;
    out.profile = p;
  } else {
    if (v.accepts !== 0 && v.accepts !== 1) return null;
    out.accepts = v.accepts;
  }
  if (v.images !== undefined) {
    if (!Array.isArray(v.images) || v.images.length > VOICI_DRAFT_MAX_IMAGES) return null;
    const imgs = [];
    for (const im of v.images) {
      if (!isObj(im) || !exactKeys(im, ["sha256", "data"]) || !isLowerHex(im.sha256, 32)) return null;
      const bytes = b64Decode(im.data);
      if (!bytes || bytes.length > VOICI_DRAFT_MAX_IMAGE_BYTES || sha256Hex(bytes) !== im.sha256 || !isVoiciJpeg(bytes)) return null;
      imgs.push({ sha256: im.sha256, data: im.data });
    }
    out.images = imgs;
  }
  return out;
}

/** The voici-draft body: canonicalJson({suite, nonce:<hex 12>, ct:<b64>}), AES-256-GCM under the drafts key. */
export function sealVoiciDraft(draftsKey, username, op, nonce = rand(12)) {
  if (!USERNAME.test(username) || nonce.length !== 12) throw new Error(`${TAG_VOICI_DRAFT}: bad input`);
  if (!parseVoiciDraftOp(op)) throw new Error(`${TAG_VOICI_DRAFT}: malformed op`);
  const ct = aesGcm(draftsKey, nonce, enc(`${TAG_VOICI_DRAFT}|${username}|${op.opId}`)).encrypt(canonicalJsonBytes(op));
  return canonicalJsonBytes({ suite: TAG_VOICI_DRAFT, nonce: hex(nonce), ct: b64Encode(ct) });
}

export function parseVoiciDraftBody(bodyBytes) {
  let r;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bodyBytes);
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(r) || !exactKeys(r, ["suite", "nonce", "ct"]) || r.suite !== TAG_VOICI_DRAFT || !isLowerHex(r.nonce, 12) || !b64Decode(r.ct)) return null;
  return canonicalJson(r) === text ? { nonce: r.nonce, ct: r.ct } : null;
}

/** Opens a draft body; the op's opId must equal `opId` (the envelope's msgId). The op or null. */
export function openVoiciDraft(draftsKey, username, opId, bodyBytes) {
  const b = parseVoiciDraftBody(bodyBytes);
  if (!b) return null;
  try {
    const pt = aesGcm(draftsKey, hexToBytes(b.nonce), enc(`${TAG_VOICI_DRAFT}|${username}|${opId}`)).decrypt(b64Decode(b.ct));
    const op = parseVoiciDraftOp(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt)));
    return op && op.opId === opId ? op : null;
  } catch {
    return null;
  }
}

// ── Messages state blob (§10.1) ───────────────────────────────────────────

export function emptyMessagesState() {
  return { v: 1, nicknames: {}, blocks: [], accepted: [], archived: [], readUpTo: {}, signedInSites: [], pendingOps: [] };
}

export function parseMessagesState(v) {
  if (!isObj(v) || v.v !== 1 || !exactKeys(v, ["v", "nicknames", "blocks", "accepted", "archived", "readUpTo", "signedInSites", "pendingOps"])) return null;
  if (!isObj(v.nicknames) || !isObj(v.readUpTo)) return null;
  const nick = {};
  for (const [k, n] of Object.entries(v.nicknames)) {
    if (!isLowerHex(k, 32) || !isObj(n) || !exactKeys(n, ["name", "at"]) || checkVoiciText("nickname", n.name) || !isTime(n.at)) return null;
    nick[k] = { name: n.name, at: n.at };
  }
  const list = (x, bytes) => (Array.isArray(x) && x.every((s) => isLowerHex(s, bytes)) ? x : null);
  const blocks = list(v.blocks, 32);
  const accepted = list(v.accepted, 32);
  const archived = list(v.archived, 32);
  if (!blocks || !accepted || !archived) return null;
  const read = {};
  for (const [k, m] of Object.entries(v.readUpTo)) {
    if (!isLowerHex(k, 32) || !isLowerHex(m, 16)) return null;
    read[k] = m;
  }
  if (!Array.isArray(v.signedInSites) || !Array.isArray(v.pendingOps)) return null;
  const sites = [];
  for (const s of v.signedInSites) {
    if (!isObj(s) || !exactKeys(s, ["pageId", "delegatePub", "at"]) || !PAGE_ID.test(String(s.pageId)) || !isLowerHex(s.delegatePub, 65) || !isTime(s.at)) return null;
    sites.push({ pageId: s.pageId, delegatePub: s.delegatePub, at: s.at });
  }
  const ops = [];
  for (const o of v.pendingOps) {
    const p = parseVoiciDraftOp(o);
    if (!p) return null;
    ops.push(p);
  }
  return { v: 1, nicknames: nick, blocks, accepted, archived, readUpTo: read, signedInSites: sites, pendingOps: ops };
}

const uniqSorted = (a) => [...new Set(a)].sort();

/** The compare-and-set merge (§10.1); deterministic (sorted output). */
export function mergeMessagesState(local, remote) {
  const nicknames = { ...remote.nicknames };
  for (const [k, n] of Object.entries(local.nicknames)) if (!nicknames[k] || n.at >= nicknames[k].at) nicknames[k] = n;
  const sites = new Map();
  for (const s of [...remote.signedInSites, ...local.signedInSites]) {
    const cur = sites.get(s.delegatePub);
    if (!cur || s.at >= cur.at) sites.set(s.delegatePub, s);
  }
  const ops = new Map();
  for (const o of [...remote.pendingOps, ...local.pendingOps]) ops.set(o.opId, o);
  const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return {
    v: 1,
    nicknames: sortKeys(nicknames),
    blocks: uniqSorted([...local.blocks, ...remote.blocks]),
    accepted: uniqSorted([...local.accepted, ...remote.accepted]),
    archived: uniqSorted([...local.archived, ...remote.archived]),
    readUpTo: sortKeys({ ...remote.readUpTo, ...local.readUpTo }),
    signedInSites: [...sites.values()].sort((a, b) => (a.delegatePub < b.delegatePub ? -1 : 1)),
    pendingOps: [...ops.values()].sort((a, b) => (a.opId < b.opId ? -1 : 1)),
  };
}

/** Seals the state under the state key: {version, nonce, ct}. */
export function sealMessagesState(stateKey, username, version, s, nonce = rand(12)) {
  if (!USERNAME.test(username) || !isTime(version) || version < 1 || nonce.length !== 12 || !parseMessagesState(s)) throw new Error(`${TAG_MESSAGES_STATE}: bad input`);
  const pt = canonicalJsonBytes(s);
  if (pt.length > VOICI_STATE_MAX_BYTES) throw new Error(`${TAG_MESSAGES_STATE}: too large`);
  const ct = aesGcm(stateKey, nonce, enc(`${TAG_MESSAGES_STATE}|${username}|${version}`)).encrypt(pt);
  return { version, nonce: hex(nonce), ct: b64Encode(ct) };
}

export function openMessagesState(stateKey, username, blob) {
  if (!isObj(blob) || !exactKeys(blob, ["version", "nonce", "ct"]) || !isTime(blob.version) || !isLowerHex(blob.nonce, 12)) return null;
  const ct = b64Decode(blob.ct);
  if (!ct || ct.length > VOICI_STATE_MAX_BYTES + 16) return null;
  try {
    const pt = aesGcm(stateKey, hexToBytes(blob.nonce), enc(`${TAG_MESSAGES_STATE}|${username}|${blob.version}`)).decrypt(ct);
    return parseMessagesState(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt)));
  } catch {
    return null;
  }
}

// ── reports (§9.2) ────────────────────────────────────────────────────────

export const VOICI_REPORT_REASONS = ["spam", "harassment", "impersonation", "illegal", "other"];

/**
 * message: <tag>|message|<pageId>|<H(canonicalJson(envelope))>|<reason>|<H(attached) or "">|<issuedAt>
 * page:    <tag>|page|<username>|<seq>|<reason>|<H(UTF-8 note)>|<issuedAt>
 * (The webapp never seals the attached text; it passes `attached` through as the caller got it, or null.)
 */
export function canonicalVoiciReport(r) {
  if (!VOICI_REPORT_REASONS.includes(r.reason) || !isTime(r.issuedAt)) throw new Error(`${TAG_VOICI_REPORT}: bad field`);
  if (r.kind === "message") {
    needPageId(r.pageId);
    if (r.attached !== null && !b64Decode(r.attached)) throw new Error(`${TAG_VOICI_REPORT}: bad attached`);
    const att = r.attached === null ? "" : sha256Hex(b64Decode(r.attached));
    return enc([TAG_VOICI_REPORT, "message", r.pageId, sha256Hex(canonicalJsonBytes(r.envelope)), r.reason, att, String(r.issuedAt)].join("|"));
  }
  if (typeof r.username !== "string" || !USERNAME.test(r.username) || !isTime(r.seq) || r.seq < 1 || checkVoiciText("reportNote", r.note)) throw new Error(`${TAG_VOICI_REPORT}: bad field`);
  return enc([TAG_VOICI_REPORT, "page", r.username, String(r.seq), r.reason, sha256Hex(r.note), String(r.issuedAt)].join("|"));
}

export function signVoiciMessageReport(r, ownerSignSeed) {
  return ed25519SignHex(canonicalVoiciReport(r), ownerSignSeed);
}

export function verifyVoiciMessageReport(r, signature, ownerSignPub) {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciReport(r), ownerSignPub);
  } catch {
    return false;
  }
}

/** A page report's P-256 signer check (sig by delegation.delegatePub over canonicalVoiciReport). */
export function verifyVoiciPageReportSignature(r, sigHex, delegatePub) {
  try {
    return p256VerifyP1363(sigHex, canonicalVoiciReport(r), delegatePub);
  } catch {
    return false;
  }
}

// ── Sign in with Flagship over /qr-pipe (§6.1, §6.5) ──────────────────────

export function parseVoiciSignInRequest(v) {
  if (!isObj(v) || !exactKeys(v, ["kind", "origin", "pageId", "username", "delegatePub", "nonce"]) || v.kind !== TAG_VOICI_SIGN_IN_REQUEST) return null;
  if (typeof v.origin !== "string" || !/^https:\/\/[a-z0-9.-]{1,253}$/.test(v.origin)) return null;
  if (!PAGE_ID.test(String(v.pageId)) || typeof v.username !== "string" || !USERNAME.test(v.username)) return null;
  if (!isLowerHex(v.delegatePub, 65) || !v.delegatePub.startsWith("04") || !isLowerHex(v.nonce, 16)) return null;
  return { kind: TAG_VOICI_SIGN_IN_REQUEST, origin: v.origin, pageId: v.pageId, username: v.username, delegatePub: v.delegatePub, nonce: v.nonce };
}

/** want = {request, caKeys, now}; {ok:true, answer} | {ok:false, code: malformed|bad-attestation|bad-delegation|bad-thread}. */
export function checkVoiciSignInAnswer(v, want) {
  const keys = ["kind", "pageId", "pseudonymPub", "attestation", "delegation", "delegationSig", "threadStmt", "threadSig", "threadSeed"];
  if (!isObj(v) || !exactKeys(v, keys) || v.kind !== TAG_VOICI_SIGN_IN || v.pageId !== want.request.pageId) return { ok: false, code: "malformed" };
  if (!isLowerHex(v.pseudonymPub, 32) || !isLowerHex(v.threadSeed, 32) || typeof v.threadSig !== "string") return { ok: false, code: "malformed" };
  const att = checkMessagesKeyAttestation(v.attestation, { caKeys: want.caKeys, now: want.now, pseudonymPub: v.pseudonymPub });
  if (!att.ok) return { ok: false, code: "bad-attestation" };
  const del = checkWebDelegation(v.delegation, v.delegationSig, {
    scope: "voici-messages",
    origin: want.request.origin,
    audience: want.request.pageId,
    principalPub: v.pseudonymPub,
    now: want.now,
    notAfter: att.attestation.expiresAt,
  });
  if (!del.ok || del.delegation.delegatePub !== want.request.delegatePub || del.delegation.nonce !== want.request.nonce) return { ok: false, code: "bad-delegation" };
  const ts = parseVoiciThreadStatement(v.threadStmt);
  if (!ts || ts.pageId !== want.request.pageId || ts.pseudonymPub !== v.pseudonymPub) return { ok: false, code: "bad-thread" };
  if (!ed25519VerifyHex(v.threadSig, canonicalVoiciThreadStatement(ts), v.pseudonymPub)) return { ok: false, code: "bad-thread" };
  if (hex(hybridSealKeygen(hexToBytes(v.threadSeed)).publicKey) !== ts.threadPub) return { ok: false, code: "bad-thread" };
  return {
    ok: true,
    answer: {
      kind: TAG_VOICI_SIGN_IN,
      pageId: v.pageId,
      pseudonymPub: v.pseudonymPub,
      attestation: att.attestation,
      delegation: del.delegation,
      delegationSig: v.delegationSig,
      threadStmt: ts,
      threadSig: v.threadSig,
      threadSeed: v.threadSeed,
    },
  };
}

// ── the phone endpoint's web policy (phoneRoute.ts, §8.2) ─────────────────

export const PHONE_WEB_ORIGINS = ["https://voi.ci"];
export const PHONE_WEB_ORIGINS_GYM = ["https://gym.voi.ci"];
export const PHONE_DELIVER_PATH = "/api/phone/deliver";
export const PHONE_LIVE_PATH = "/api/phone/live";
export const PHONE_ENVELOPE_CONTENT_TYPE = "application/flagship-envelope+json";
export const PHONE_DELIVER_MAX_BYTES = 64 * 1024;
export const PHONE_DELIVER_MAX_CONCURRENT = 8;
export const PHONE_DELIVER_PER_SENDER_PER_MINUTE = 20;
export const PHONE_DELIVER_PER_MINUTE = 120;

const corsFor = (origin) => (origin === null ? {} : { "Access-Control-Allow-Origin": origin, Vary: "Origin" });

/** r = {method, path, host, origin, contentType, acrMethod, acrHeaders}; o = {hostname, origins}. */
export function phoneWebCheck(r, o) {
  if (r.host.toLowerCase() !== o.hostname.toLowerCase()) return { kind: "refuse", status: 421, code: "wrong-host" };
  const method = r.method.toUpperCase();
  const listed = r.origin !== null && o.origins.includes(r.origin);
  if (r.origin !== null && !listed) return { kind: "refuse", status: 403, code: "origin" };
  const known = r.path === PHONE_DELIVER_PATH || r.path === PHONE_LIVE_PATH;
  if (method === "OPTIONS") {
    if (r.path !== PHONE_DELIVER_PATH || !listed) return { kind: "refuse", status: 403, code: "preflight" };
    const hdrs = (r.acrHeaders ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
    if (r.acrMethod?.toUpperCase() !== "POST" || hdrs.length !== 1 || hdrs[0] !== "content-type") return { kind: "refuse", status: 403, code: "preflight" };
    return {
      kind: "preflight",
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": r.origin,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      },
    };
  }
  if (!known) return r.origin !== null ? { kind: "refuse", status: 403, code: "origin" } : { kind: "other" };
  if (r.path === PHONE_LIVE_PATH) return method === "GET" ? { kind: "live", corsHeaders: corsFor(r.origin) } : { kind: "refuse", status: 405, code: "method" };
  if (method !== "POST") return { kind: "refuse", status: 405, code: "method" };
  if (r.contentType !== PHONE_ENVELOPE_CONTENT_TYPE) return { kind: "refuse", status: 415, code: "content-type" };
  return { kind: "deliver", corsHeaders: corsFor(r.origin) };
}

const ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** `GET /api/phone/live` answer {live:true, account, ownerSignPub}, or null. */
export function parsePhoneLiveAnswer(v) {
  if (!isObj(v)) return null;
  if (Object.keys(v).sort().join(",") !== "account,live,ownerSignPub" || v.live !== true) return null;
  if (typeof v.account !== "string" || !ACCOUNT.test(v.account) || typeof v.ownerSignPub !== "string" || !HEX64.test(v.ownerSignPub)) return null;
  return { live: true, account: v.account, ownerSignPub: v.ownerSignPub };
}
