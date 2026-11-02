/**
 * voi.ci Messages (docs/voici-and-messages.md §1, §6-§10): key derivations from the UMK, the conversation id, the
 * sealed body (AES-256-GCM under a random CEK, the CEK wrapped with flagship/hybrid-seal/v1 to two X-Wing keys), the
 * thread statement, the checks for the three web-envelope kinds (voici-message, voici-reply, voici-draft), the phone's
 * delivery ack, block orders, thread fetches, draft ops, the Messages state blob, reports, ban / takedown requests
 * and the "Sign in with Flagship" pipe payloads. Shared vectors: packages/protocol/test-vectors/messages/.
 *
 * Derivations (KDF = HKDF-SHA256, salt empty, 32 bytes; info strings below; hex is lowercase):
 *   inbox X-Wing seed   KDF(umk, "flagship/voici-inbox/v1|<pageId>|<inboxEpoch>")
 *   owner signing seed  KDF(umk, "flagship/voici-owner-sign/v1|<pageId>|<inboxEpoch>")      Ed25519
 *   messages secret     KDF(umk, "flagship/messages-secret/v1")
 *   pseudonym seed P    KDF(messagesSecret, "flagship/messages-pseudonym/v1|<pageId>")       Ed25519
 *   thread seed T       KDF(messagesSecret, "flagship/messages-thread/v1|<pageId>")          X-Wing
 *   drafts key          KDF(umk, "flagship/voici-drafts/v1")                                 AES-256-GCM
 *   state key           KDF(umk, "flagship/messages-state/v1")                               AES-256-GCM
 *   conv                SHA-256 hex of UTF-8 "flagship/voici-conv/v1|<pageId>|<Ppub hex>"
 *
 * Sealed body (bodyBytes of the envelope) = canonicalJson({suite:"flagship/hybrid-seal/v1", nonce:<hex 12>,
 * ct:<b64>, wraps:[{keyId:<hex 32>, sealed:<b64>}, {..}]}); ct = AES-256-GCM(CEK, nonce, aad
 * "flagship/voici-body/v1|<conv>|<msgId>", canonicalJson({v:1, text, replyTo})); each wrap = hybridSeal(CEK) with
 * purpose "flagship/voici-cek/v1", context [UTF-8 conv, UTF-8 msgId], header senderKeyId = SHA-256(raw `from` key),
 * issuedAt = sentAt; keyId = pqKeyId(SUITE_HYBRID_SEAL_V1, recipient pub). Order: voici-message [inbox, T],
 * voici-reply [T, inbox]. Exactly two wraps.
 *
 * Exported API (names other chunks import): the TAG_* constants below, VOICI_* caps, deriveVoiciInboxKey,
 * deriveVoiciOwnerSignKey, deriveMessagesSecret, deriveMessagesPseudonymKey, deriveMessagesThreadKey,
 * deriveVoiciDraftsKey, deriveMessagesStateKey, voiciConv, VoiciPlaintext, VoiciSealRandomness, sealVoiciBody,
 * parseVoiciSealedBody, openVoiciBody, VoiciThreadStatement, canonicalVoiciThreadStatement,
 * signVoiciThreadStatement, parseVoiciThreadStatement, VoiciMessageCred, VoiciCheckRefusal, checkVoiciMessage,
 * checkVoiciReply, checkVoiciDraft, plus (second half of the file) the ack, block, thread-fetch, draft-op, state,
 * report, ban/takedown and sign-in families.
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { p256 } from "@noble/curves/nist.js";
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import { checkMessagesKeyAttestation, type MessagesKeyAttestation } from "./messagesAttestation.js";
import { hybridOpen, hybridSealKeygen, hybridSealWithRandomness, pqKeyId, HYBRID_SEAL_RANDOMNESS_LEN, SUITE_HYBRID_SEAL_V1, TAG_HYBRID_SEAL_V1 } from "./pqHybrid.js";
import type { Bytes, UserMasterKey } from "./types.js";
import { checkWebDelegation, type WebDelegation } from "./webDelegation.js";
import {
  b64Decode,
  b64Encode,
  canonicalJson,
  canonicalJsonBytes,
  ed25519VerifyHex,
  hexToBytes,
  isLowerHex,
  p256VerifyP1363,
  parseWebEnvelope,
  sha256Hex,
  verifyWebEnvelopeSignature,
  WEB_ENVELOPE_MAX_BODY_BYTES,
  WEB_ENVELOPE_MAX_BYTES,
  type WebEnvelope,
} from "./webEnvelope.js";
import { checkVoiciText, type VoiciTextRefusal } from "./voiciText.js";
import { isVoiciJpeg, parseVoiciPost, parseVoiciProfile, type VoiciPost, type VoiciProfile } from "./voiciPage.js";

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
export const TAG_VOICI_THREAD_FETCH = "flagship/voici-thread-fetch/v1";
export const TAG_VOICI_DRAFT = "flagship/voici-draft/v1";
export const TAG_VOICI_REPORT = "flagship/voici-report/v1";
export const TAG_VOICI_REPORT_TEXT = "flagship/voici-report-text/v1";
export const TAG_VOICI_SIGN_IN = "flagship/voici-sign-in/v1";
export const TAG_VOICI_SIGN_IN_REQUEST = "flagship/voici-sign-in-request/v1";

/** `.com` and the phone refuse a sentAt further than this from their clock. */
export const VOICI_SEND_SKEW_MS = 10 * 60_000;
/** A voici-draft carries re-encoded images, so its caps are larger than a message's (A: spec §5.2 / §7.1). */
export const VOICI_DRAFT_MAX_ENVELOPE_BYTES = 1024 * 1024;
export const VOICI_DRAFT_MAX_BODY_BYTES = 960 * 1024;
export const VOICI_DRAFT_MAX_IMAGE_BYTES = 150 * 1024;
export const VOICI_DRAFT_MAX_IMAGES = 4;
export const VOICI_STATE_MAX_BYTES = 256 * 1024;

const enc = (s: string): Bytes => new TextEncoder().encode(s);
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function exactKeys(r: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const ks = Object.keys(r);
  return required.every((k) => k in r) && ks.every((k) => required.includes(k) || optional.includes(k));
}

// ── derivations ────────────────────────────────────────────────────────────

function kdf(ikm: Bytes, info: string): Bytes {
  return hkdf(sha256, ikm, new Uint8Array(0), enc(info), 32);
}
function needPageId(pageId: string): void {
  if (typeof pageId !== "string" || !PAGE_ID.test(pageId)) throw new Error("pageId must be 16 bytes of lowercase hex");
}
function needEpoch(e: number): void {
  if (!Number.isSafeInteger(e) || e < 1) throw new Error("inboxEpoch must be an integer >= 1");
}

/** The owner's inbox X-Wing key: `seed` (32, the secret) and `publicKey` (1216). */
export function deriveVoiciInboxKey(umk: UserMasterKey, pageId: string, inboxEpoch: number): { seed: Bytes; publicKey: Bytes } {
  needPageId(pageId);
  needEpoch(inboxEpoch);
  const seed = kdf(umk.seed, `${TAG_VOICI_INBOX}|${pageId}|${inboxEpoch}`);
  return { seed, publicKey: hybridSealKeygen(seed).publicKey };
}

/** The owner's messages signing key (Ed25519): signs replies, blocks and phone acks. */
export function deriveVoiciOwnerSignKey(umk: UserMasterKey, pageId: string, inboxEpoch: number): { seed: Bytes; publicKey: Bytes } {
  needPageId(pageId);
  needEpoch(inboxEpoch);
  const seed = kdf(umk.seed, `${TAG_VOICI_OWNER_SIGN}|${pageId}|${inboxEpoch}`);
  return { seed, publicKey: ed.getPublicKey(seed) };
}

export function deriveMessagesSecret(umk: UserMasterKey): Bytes {
  return kdf(umk.seed, TAG_MESSAGES_SECRET);
}

/** The sender's pseudonym key P toward one page (Ed25519). */
export function deriveMessagesPseudonymKey(messagesSecret: Bytes, pageId: string): { seed: Bytes; publicKey: Bytes } {
  needPageId(pageId);
  const seed = kdf(messagesSecret, `${TAG_MESSAGES_PSEUDONYM}|${pageId}`);
  return { seed, publicKey: ed.getPublicKey(seed) };
}

/** The sender's thread key T toward one page (X-Wing). */
export function deriveMessagesThreadKey(messagesSecret: Bytes, pageId: string): { seed: Bytes; publicKey: Bytes } {
  needPageId(pageId);
  const seed = kdf(messagesSecret, `${TAG_MESSAGES_THREAD}|${pageId}`);
  return { seed, publicKey: hybridSealKeygen(seed).publicKey };
}

export function deriveVoiciDraftsKey(umk: UserMasterKey): Bytes {
  return kdf(umk.seed, TAG_VOICI_DRAFTS);
}

export function deriveMessagesStateKey(umk: UserMasterKey): Bytes {
  return kdf(umk.seed, TAG_MESSAGES_STATE);
}

export function voiciConv(pageId: string, pseudonymPub: string): string {
  needPageId(pageId);
  if (!isLowerHex(pseudonymPub, 32)) throw new Error("pseudonym key must be 32 bytes of lowercase hex");
  return sha256Hex(`${TAG_VOICI_CONV}|${pageId}|${pseudonymPub}`);
}

// ── sealed body ────────────────────────────────────────────────────────────

export interface VoiciPlaintext {
  v: 1;
  text: string;
  replyTo: string | null;
}

/** Fixed randomness, for vectors only. */
export interface VoiciSealRandomness {
  cek: Bytes;
  nonce: Bytes;
  /** One 64-byte X-Wing encapsulation seed per recipient. */
  eseeds: Bytes[];
}

function plaintextBytes(p: VoiciPlaintext): Bytes {
  const t = checkVoiciText("messageText", p.text);
  if (t) throw new Error(`voici body: text refused (${t})`);
  if (p.replyTo !== null && !isLowerHex(p.replyTo, 16)) throw new Error("voici body: bad replyTo");
  return canonicalJsonBytes({ v: 1, text: p.text, replyTo: p.replyTo });
}

/** Seals `plaintext` for a message (recipients [inboxPub, threadPub]) or a reply ([threadPub, inboxPub]). */
export function sealVoiciBody(
  o: { conv: string; msgId: string; sentAt: number; fromPub: string; recipients: [Bytes, Bytes]; plaintext: VoiciPlaintext },
  rnd?: VoiciSealRandomness,
): Bytes {
  if (!isLowerHex(o.msgId, 16) || !isLowerHex(o.conv, 32) || !isLowerHex(o.fromPub)) throw new Error("voici body: bad ids");
  const cek = rnd?.cek ?? crypto.getRandomValues(new Uint8Array(32));
  const nonce = rnd?.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (cek.length !== 32 || nonce.length !== 12) throw new Error("voici body: bad randomness");
  const ct = gcm(cek, nonce, enc(`${TAG_VOICI_BODY}|${o.conv}|${o.msgId}`)).encrypt(plaintextBytes(o.plaintext));
  const wraps = o.recipients.map((pub, i) => {
    const eseed = rnd?.eseeds[i] ?? crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN));
    const sealed = hybridSealWithRandomness(
      pub,
      { purpose: TAG_VOICI_CEK, senderKeyId: sha256(hexToBytes(o.fromPub)), issuedAt: o.sentAt },
      [enc(o.conv), enc(o.msgId)],
      cek,
      eseed,
    );
    return { keyId: hex(pqKeyId(SUITE_HYBRID_SEAL_V1, pub)), sealed: b64Encode(sealed) };
  });
  return canonicalJsonBytes({ suite: TAG_HYBRID_SEAL_V1, nonce: hex(nonce), ct: b64Encode(ct), wraps });
}

export interface VoiciSealedBody {
  suite: typeof TAG_HYBRID_SEAL_V1;
  nonce: string;
  ct: string;
  wraps: { keyId: string; sealed: string }[];
}

/** Strict outer schema of a sealed body (before anything is decrypted): canonical JSON, exactly two wraps. */
export function parseVoiciSealedBody(bodyBytes: Bytes): VoiciSealedBody | null {
  let r: unknown;
  let text: string;
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
  return r as unknown as VoiciSealedBody;
}

export type VoiciOpenRefusal = "malformed" | "no-wrap" | "decrypt-failed" | "inner-schema" | VoiciTextRefusal;

/** Unwraps the CEK with the recipient's X-Wing seed, decrypts, then the inner schema and the text refusals. */
export function openVoiciBody(
  bodyBytes: Bytes,
  o: { conv: string; msgId: string },
  recipientSeed: Bytes,
): { ok: true; plaintext: VoiciPlaintext } | { ok: false; code: VoiciOpenRefusal } {
  const b = parseVoiciSealedBody(bodyBytes);
  if (!b) return { ok: false, code: "malformed" };
  const myId = hex(pqKeyId(SUITE_HYBRID_SEAL_V1, hybridSealKeygen(recipientSeed).publicKey));
  const w = b.wraps.find((x) => x.keyId === myId);
  if (!w) return { ok: false, code: "no-wrap" };
  let pt: Bytes;
  try {
    const cek = hybridOpen(recipientSeed, TAG_VOICI_CEK, [enc(o.conv), enc(o.msgId)], b64Decode(w.sealed)!).plaintext;
    if (cek.length !== 32) return { ok: false, code: "decrypt-failed" };
    pt = gcm(cek, hexToBytes(b.nonce), enc(`${TAG_VOICI_BODY}|${o.conv}|${o.msgId}`)).decrypt(b64Decode(b.ct)!);
  } catch {
    return { ok: false, code: "decrypt-failed" };
  }
  let text: string;
  let r: unknown;
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
  return { ok: true, plaintext: { v: 1, text: r.text, replyTo: r.replyTo as string | null } };
}

// ── thread statement ───────────────────────────────────────────────────────

/** flagship/voici-thread-key/v1|<pageId>|<Ppub>|<Tpub>|<issuedAt>, signed by P. */
export interface VoiciThreadStatement {
  pageId: string;
  pseudonymPub: string;
  threadPub: string;
  issuedAt: number;
}

export function canonicalVoiciThreadStatement(s: VoiciThreadStatement): Bytes {
  needPageId(s.pageId);
  if (!isLowerHex(s.pseudonymPub, 32) || !isLowerHex(s.threadPub, 1216) || !isTime(s.issuedAt)) throw new Error(`${TAG_VOICI_THREAD_KEY}: bad field`);
  return enc([TAG_VOICI_THREAD_KEY, s.pageId, s.pseudonymPub, s.threadPub, String(s.issuedAt)].join("|"));
}

export function signVoiciThreadStatement(s: VoiciThreadStatement, pseudonymSeed: Bytes): string {
  return hex(ed.sign(canonicalVoiciThreadStatement(s), pseudonymSeed));
}

export function parseVoiciThreadStatement(v: unknown): VoiciThreadStatement | null {
  if (!isObj(v) || !exactKeys(v, ["pageId", "pseudonymPub", "threadPub", "issuedAt"])) return null;
  const s = v as unknown as VoiciThreadStatement;
  try {
    canonicalVoiciThreadStatement(s);
  } catch {
    return null;
  }
  return { pageId: s.pageId, pseudonymPub: s.pseudonymPub, threadPub: s.threadPub, issuedAt: s.issuedAt };
}

// ── envelope checks ────────────────────────────────────────────────────────

export interface VoiciMessageCred {
  attestation: MessagesKeyAttestation;
  delegation: WebDelegation;
  delegationSig: string;
  threadStmt: VoiciThreadStatement;
  threadSig: string;
}

export type VoiciCheckRefusal =
  | "too-large"
  | "malformed"
  | "wrong-kind"
  | "wrong-audience"
  | "not-accepting"
  | "blocked"
  | "revoked"
  | "rate-limited"
  | "bad-delegation"
  | "bad-attestation"
  | "bad-thread"
  | "wrong-conv"
  | "bad-signature"
  | "bad-grant"
  | "stale";

type Fail = { ok: false; code: VoiciCheckRefusal };
const no = (code: VoiciCheckRefusal): Fail => ({ ok: false, code });

function outer(input: unknown, maxEnvelope: number, maxBody: number): WebEnvelope | Fail {
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
const failed = (x: WebEnvelope | Fail): x is Fail => "ok" in x;
const fresh = (sentAt: number, now: number) => Math.abs(sentAt - now) <= VOICI_SEND_SKEW_MS;

export interface VoiciMessageCheckContext {
  pageId: string;
  acceptsMessages: boolean;
  /** Website origin a delegation must name ("https://voi.ci", gym "https://gym.voi.ci"). */
  origin: string;
  /** Authorized CA keys (hex) for the attestation. */
  caKeys: readonly string[];
  now: number;
  /** Pseudonyms this page blocked and pseudonyms Flagship banned (hex). */
  blocked?: ReadonlySet<string>;
  /** Revoked browser keys (delegatePub hex). */
  revoked?: ReadonlySet<string>;
  /** Called after the cheap filters, before any signature check; return a refusal to stop. */
  rateLimit?: (env: WebEnvelope) => "rate-limited" | null;
}

/**
 * The receiver's checks for a voici-message (§8.3, §12.1), cheapest first: size, outer schema, kind, audience,
 * accepting, blocked / banned, revoked, rate limits, delegation (by P, scope voici-messages, origin, audience,
 * principal = from, within the attestation's life), attestation (CA, abuse-tag hash, key = from), thread statement
 * (by P, same page and key), conv, the envelope's P-256 signature by the delegated key, freshness. Message-id
 * uniqueness and seq are the caller's (they need storage). Nothing is decrypted.
 */
export function checkVoiciMessage(
  input: unknown,
  ctx: VoiciMessageCheckContext,
): { ok: true; envelope: WebEnvelope; cred: VoiciMessageCred } | Fail {
  const env = outer(input, WEB_ENVELOPE_MAX_BYTES, WEB_ENVELOPE_MAX_BODY_BYTES);
  if (failed(env)) return env;
  if (env.kind !== "voici-message" || env.sigAlg !== "p256") return no("wrong-kind");
  if (!isLowerHex(env.from, 32) || !isLowerHex(env.conv, 32)) return no("malformed");
  if (!parseVoiciSealedBody(b64Decode(env.bodyB64)!)) return no("malformed");
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
  return {
    ok: true,
    envelope: env,
    cred: { attestation: att.attestation, delegation: del.delegation, delegationSig: c.delegationSig as string, threadStmt: ts, threadSig: c.threadSig },
  };
}

/**
 * A voici-reply: kind, audience = pageId, cred exactly {pageSeq}, from = the page's ownerSignPub (the caller resolves
 * it for `cred.pageSeq` or later), conv = `conv` when given, the Ed25519 signature, and freshness only when `freshAt`
 * is given (at `.com` on send; a browser reading history passes none).
 */
export function checkVoiciReply(
  input: unknown,
  ctx: { pageId: string; ownerSignPub: string; conv?: string; freshAt?: number },
): { ok: true; envelope: WebEnvelope; pageSeq: number } | Fail {
  const env = outer(input, WEB_ENVELOPE_MAX_BYTES, WEB_ENVELOPE_MAX_BODY_BYTES);
  if (failed(env)) return env;
  if (env.kind !== "voici-reply" || env.sigAlg !== "ed25519") return no("wrong-kind");
  if (!isLowerHex(env.conv, 32) || !exactKeys(env.cred, ["pageSeq"]) || !isTime(env.cred.pageSeq) || (env.cred.pageSeq as number) < 1) return no("malformed");
  if (!parseVoiciSealedBody(b64Decode(env.bodyB64)!)) return no("malformed");
  if (env.audience !== ctx.pageId) return no("wrong-audience");
  if (ctx.conv !== undefined && env.conv !== ctx.conv) return no("wrong-conv");
  if (env.from !== ctx.ownerSignPub || !verifyWebEnvelopeSignature(env, ctx.ownerSignPub)) return no("bad-signature");
  if (ctx.freshAt !== undefined && !fresh(env.sentAt, ctx.freshAt)) return no("stale");
  return { ok: true, envelope: env, pageSeq: env.cred.pageSeq as number };
}

/**
 * A voici-draft from another device of the owner's account: kind, audience = username, conv "", cred exactly
 * {grant, grantSignature}, the Ed25519 signature by `from`, then `checkGrant` (the caller's grant-chain check against
 * the account's admin root) and freshness when `freshAt` is given. Caps: VOICI_DRAFT_MAX_*.
 */
export function checkVoiciDraft(
  input: unknown,
  ctx: { username: string; checkGrant: (grant: unknown, grantSignature: string, devicePub: string) => boolean; freshAt?: number },
): { ok: true; envelope: WebEnvelope } | Fail {
  const env = outer(input, VOICI_DRAFT_MAX_ENVELOPE_BYTES, VOICI_DRAFT_MAX_BODY_BYTES);
  if (failed(env)) return env;
  if (env.kind !== "voici-draft" || env.sigAlg !== "ed25519") return no("wrong-kind");
  if (env.conv !== "" || !isLowerHex(env.from, 32) || !exactKeys(env.cred, ["grant", "grantSignature"]) || !isLowerHex(env.cred.grantSignature, 64)) return no("malformed");
  if (!parseVoiciDraftBody(b64Decode(env.bodyB64)!)) return no("malformed");
  if (env.audience !== ctx.username) return no("wrong-audience");
  if (!verifyWebEnvelopeSignature(env, env.from)) return no("bad-signature");
  if (!ctx.checkGrant(env.cred.grant, env.cred.grantSignature as string, env.from)) return no("bad-grant");
  if (ctx.freshAt !== undefined && !fresh(env.sentAt, ctx.freshAt)) return no("stale");
  return { ok: true, envelope: env };
}

// ── phone ack ──────────────────────────────────────────────────────────────

/**
 * flagship/voici-ack/v1|<conv>|<msgId>|<receivedAt>|<phoneRoutePub>; conv "" for a draft. Signed by the owner messages
 * signing key (voici-message) or the admin device key (voici-draft). Wire: {conv, msgId, receivedAt, phoneRoutePub,
 * signature}.
 */
export interface VoiciAck {
  conv: string;
  msgId: string;
  receivedAt: number;
  phoneRoutePub: string;
}

export function canonicalVoiciAck(a: VoiciAck): Bytes {
  if ((a.conv !== "" && !isLowerHex(a.conv, 32)) || !isLowerHex(a.msgId, 16) || !isTime(a.receivedAt) || !isLowerHex(a.phoneRoutePub) || a.phoneRoutePub.length === 0) {
    throw new Error(`${TAG_VOICI_ACK}: bad field`);
  }
  return enc([TAG_VOICI_ACK, a.conv, a.msgId, String(a.receivedAt), a.phoneRoutePub].join("|"));
}

export function signVoiciAck(a: VoiciAck, seed: Bytes): VoiciAck & { signature: string } {
  return { ...a, signature: hex(ed.sign(canonicalVoiciAck(a), seed)) };
}

/** Shape + signature by `signerPub` + it acknowledges `msgId` (and `conv` when given). */
export function verifyVoiciAck(v: unknown, signerPub: string, want: { msgId: string; conv?: string }): VoiciAck | null {
  if (!isObj(v) || !exactKeys(v, ["conv", "msgId", "receivedAt", "phoneRoutePub", "signature"]) || typeof v.signature !== "string") return null;
  const a = { conv: v.conv, msgId: v.msgId, receivedAt: v.receivedAt, phoneRoutePub: v.phoneRoutePub } as VoiciAck;
  let bytes: Bytes;
  try {
    bytes = canonicalVoiciAck(a);
  } catch {
    return null;
  }
  if (a.msgId !== want.msgId || (want.conv !== undefined && a.conv !== want.conv)) return null;
  return ed25519VerifyHex(v.signature, bytes, signerPub) ? a : null;
}

// ── block ──────────────────────────────────────────────────────────────────

/** flagship/voici-block/v1|<pageId>|<Ppub>|block|unblock|<issuedAt>, signed by the page's ownerSignPub. */
export interface VoiciBlock {
  pageId: string;
  pseudonymPub: string;
  op: "block" | "unblock";
  issuedAt: number;
}

export function canonicalVoiciBlock(b: VoiciBlock): Bytes {
  needPageId(b.pageId);
  if (!isLowerHex(b.pseudonymPub, 32) || (b.op !== "block" && b.op !== "unblock") || !isTime(b.issuedAt)) throw new Error(`${TAG_VOICI_BLOCK}: bad field`);
  return enc([TAG_VOICI_BLOCK, b.pageId, b.pseudonymPub, b.op, String(b.issuedAt)].join("|"));
}

export function signVoiciBlock(b: VoiciBlock, ownerSignSeed: Bytes): string {
  return hex(ed.sign(canonicalVoiciBlock(b), ownerSignSeed));
}

export function verifyVoiciBlock(b: VoiciBlock, signature: string, ownerSignPub: string): boolean {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciBlock(b), ownerSignPub);
  } catch {
    return false;
  }
}

export function parseVoiciBlock(v: unknown): VoiciBlock | null {
  if (!isObj(v) || !exactKeys(v, ["pageId", "pseudonymPub", "op", "issuedAt"])) return null;
  const b = v as unknown as VoiciBlock;
  try {
    canonicalVoiciBlock(b);
  } catch {
    return null;
  }
  return { pageId: b.pageId, pseudonymPub: b.pseudonymPub, op: b.op, issuedAt: b.issuedAt };
}

// ── thread fetch ───────────────────────────────────────────────────────────

/** flagship/voici-thread-fetch/v1|<conv>|<since>|<issuedAt>, signed by the browser key B (P-256, P1363 hex). */
export interface VoiciThreadFetch {
  conv: string;
  /** Opaque cursor from the previous answer, "" for the start: [A-Za-z0-9_-]{0,64}. */
  since: string;
  issuedAt: number;
}

export function canonicalVoiciThreadFetch(f: VoiciThreadFetch): Bytes {
  if (!isLowerHex(f.conv, 32) || typeof f.since !== "string" || !/^[A-Za-z0-9_-]{0,64}$/.test(f.since) || !isTime(f.issuedAt)) {
    throw new Error(`${TAG_VOICI_THREAD_FETCH}: bad field`);
  }
  return enc([TAG_VOICI_THREAD_FETCH, f.conv, f.since, String(f.issuedAt)].join("|"));
}

/** Deterministic P-256 (RFC 6979, low-S): vectors and tests; browsers sign with WebCrypto. */
export function signVoiciThreadFetchP256(f: VoiciThreadFetch, privateKey: Bytes): string {
  return hex(p256.sign(canonicalVoiciThreadFetch(f), privateKey, { lowS: true }));
}

// ── reply alerts (the "Alerts:" note in docs/voici-and-messages.md §8.3) ───

/**
 * flagship/voici-alerts/v1|<conv>|<on|off>|<endpointHash>|<issuedAt>, signed by the browser key B (P-256, P1363 hex),
 * like a thread fetch. endpointHash = SHA-256 hex of the Web Push endpoint URL (UTF-8), so the signature names the one
 * subscription it turns on or off.
 */
export const TAG_VOICI_ALERTS = "flagship/voici-alerts/v1";

export interface VoiciAlertsOrder {
  conv: string;
  op: "on" | "off";
  endpointHash: string;
  issuedAt: number;
}

export function canonicalVoiciAlerts(o: VoiciAlertsOrder): Bytes {
  if (!isLowerHex(o.conv, 32) || (o.op !== "on" && o.op !== "off") || !isLowerHex(o.endpointHash, 32) || !isTime(o.issuedAt)) {
    throw new Error(`${TAG_VOICI_ALERTS}: bad field`);
  }
  return enc([TAG_VOICI_ALERTS, o.conv, o.op, o.endpointHash, String(o.issuedAt)].join("|"));
}

/** Deterministic P-256 (RFC 6979, low-S): tests; browsers sign with WebCrypto. */
export function signVoiciAlertsP256(o: VoiciAlertsOrder, privateKey: Bytes): string {
  return hex(p256.sign(canonicalVoiciAlerts(o), privateKey, { lowS: true }));
}

export function verifyVoiciThreadFetch(f: VoiciThreadFetch, signature: string, delegatePub: string): boolean {
  try {
    return p256VerifyP1363(signature, canonicalVoiciThreadFetch(f), delegatePub);
  } catch {
    return false;
  }
}

// ── draft ops (§5.2) ───────────────────────────────────────────────────────

export type VoiciDraftOpKind = "post-add" | "post-edit" | "post-delete" | "profile" | "accept-messages";
export const VOICI_DRAFT_OP_KINDS: readonly VoiciDraftOpKind[] = ["post-add", "post-edit", "post-delete", "profile", "accept-messages"];

/**
 * The draft plaintext: {v:1, opId, op, at, deviceId, post? | postId? | profile? | accepts?, images?}.
 * post-add / post-edit carry `post` (a §2.6 post), post-delete `postId`, profile `profile` (a §2.6 profile piece),
 * accept-messages `accepts` (0|1). `images` (optional) are the re-encoded JPEGs the post or profile names:
 * [{sha256, data: base64}], each at most 150 KiB, at most 4.
 */
export interface VoiciDraftOp {
  v: 1;
  opId: string;
  op: VoiciDraftOpKind;
  at: number;
  deviceId: string;
  post?: VoiciPost;
  postId?: string;
  profile?: VoiciProfile;
  accepts?: 0 | 1;
  images?: { sha256: string; data: string }[];
}

const OP_FIELD: Record<VoiciDraftOpKind, string> = {
  "post-add": "post",
  "post-edit": "post",
  "post-delete": "postId",
  profile: "profile",
  "accept-messages": "accepts",
};

/** Strict schema of a draft op; null when malformed. */
export function parseVoiciDraftOp(v: unknown): VoiciDraftOp | null {
  if (!isObj(v) || v.v !== 1 || !isLowerHex(v.opId, 16) || !isTime(v.at)) return null;
  if (typeof v.op !== "string" || !VOICI_DRAFT_OP_KINDS.includes(v.op as VoiciDraftOpKind)) return null;
  if (typeof v.deviceId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(v.deviceId)) return null;
  const op = v.op as VoiciDraftOpKind;
  const field = OP_FIELD[op];
  if (!exactKeys(v, ["v", "opId", "op", "at", "deviceId", field], ["images"])) return null;
  const out: VoiciDraftOp = { v: 1, opId: v.opId, op, at: v.at, deviceId: v.deviceId };
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
    const imgs: { sha256: string; data: string }[] = [];
    for (const im of v.images) {
      if (!isObj(im) || !exactKeys(im, ["sha256", "data"]) || !isLowerHex(im.sha256, 32)) return null;
      const bytes = b64Decode(im.data);
      if (!bytes || bytes.length > VOICI_DRAFT_MAX_IMAGE_BYTES || sha256Hex(bytes) !== im.sha256 || !isVoiciJpeg(bytes)) return null;
      imgs.push({ sha256: im.sha256, data: im.data as string });
    }
    out.images = imgs;
  }
  return out;
}

/** The voici-draft body: canonicalJson({suite:"flagship/voici-draft/v1", nonce:<hex 12>, ct:<b64>}). */
export function sealVoiciDraft(draftsKey: Bytes, username: string, op: VoiciDraftOp, nonce: Bytes = crypto.getRandomValues(new Uint8Array(12))): Bytes {
  if (!USERNAME.test(username) || nonce.length !== 12) throw new Error(`${TAG_VOICI_DRAFT}: bad input`);
  if (!parseVoiciDraftOp(op)) throw new Error(`${TAG_VOICI_DRAFT}: malformed op`);
  const ct = gcm(draftsKey, nonce, enc(`${TAG_VOICI_DRAFT}|${username}|${op.opId}`)).encrypt(canonicalJsonBytes(op));
  return canonicalJsonBytes({ suite: TAG_VOICI_DRAFT, nonce: hex(nonce), ct: b64Encode(ct) });
}

export function parseVoiciDraftBody(bodyBytes: Bytes): { nonce: string; ct: string } | null {
  let r: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bodyBytes);
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(r) || !exactKeys(r, ["suite", "nonce", "ct"]) || r.suite !== TAG_VOICI_DRAFT || !isLowerHex(r.nonce, 12) || !b64Decode(r.ct)) return null;
  return canonicalJson(r) === text ? { nonce: r.nonce, ct: r.ct as string } : null;
}

/** Opens a draft body; the op's opId must equal the envelope's msgId (the AEAD binds both). */
export function openVoiciDraft(draftsKey: Bytes, username: string, opId: string, bodyBytes: Bytes): VoiciDraftOp | null {
  const b = parseVoiciDraftBody(bodyBytes);
  if (!b) return null;
  try {
    const pt = gcm(draftsKey, hexToBytes(b.nonce), enc(`${TAG_VOICI_DRAFT}|${username}|${opId}`)).decrypt(b64Decode(b.ct)!);
    const op = parseVoiciDraftOp(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt)));
    return op && op.opId === opId ? op : null;
  } catch {
    return null;
  }
}

// ── Messages state blob (§10.1) ────────────────────────────────────────────

/**
 * {v:1, nicknames:{<Ppub>: {name, at}}, blocks:[Ppub], accepted:[conv], archived:[conv], readUpTo:{conv: msgId},
 * signedInSites:[{pageId, delegatePub, at}], pendingOps:[draft op]} (A: nicknames carry `at` so the merge can pick
 * the newer). Sealed AES-256-GCM(stateKey, nonce 12, aad "flagship/messages-state/v1|<u>|<version>"); wire
 * {version, nonce, ct}.
 */
export interface MessagesState {
  v: 1;
  nicknames: Record<string, { name: string; at: number }>;
  blocks: string[];
  accepted: string[];
  archived: string[];
  readUpTo: Record<string, string>;
  signedInSites: { pageId: string; delegatePub: string; at: number }[];
  pendingOps: VoiciDraftOp[];
}

export function emptyMessagesState(): MessagesState {
  return { v: 1, nicknames: {}, blocks: [], accepted: [], archived: [], readUpTo: {}, signedInSites: [], pendingOps: [] };
}

export function parseMessagesState(v: unknown): MessagesState | null {
  if (!isObj(v) || v.v !== 1 || !exactKeys(v, ["v", "nicknames", "blocks", "accepted", "archived", "readUpTo", "signedInSites", "pendingOps"])) return null;
  if (!isObj(v.nicknames) || !isObj(v.readUpTo)) return null;
  const nick: MessagesState["nicknames"] = {};
  for (const [k, n] of Object.entries(v.nicknames)) {
    if (!isLowerHex(k, 32) || !isObj(n) || !exactKeys(n, ["name", "at"]) || checkVoiciText("nickname", n.name) || !isTime(n.at)) return null;
    nick[k] = { name: n.name as string, at: n.at };
  }
  const list = (x: unknown, bytes: number) => (Array.isArray(x) && x.every((s) => isLowerHex(s, bytes)) ? (x as string[]) : null);
  const blocks = list(v.blocks, 32);
  const accepted = list(v.accepted, 32);
  const archived = list(v.archived, 32);
  if (!blocks || !accepted || !archived) return null;
  const read: Record<string, string> = {};
  for (const [k, m] of Object.entries(v.readUpTo)) {
    if (!isLowerHex(k, 32) || !isLowerHex(m, 16)) return null;
    read[k] = m;
  }
  if (!Array.isArray(v.signedInSites) || !Array.isArray(v.pendingOps)) return null;
  const sites: MessagesState["signedInSites"] = [];
  for (const s of v.signedInSites) {
    if (!isObj(s) || !exactKeys(s, ["pageId", "delegatePub", "at"]) || typeof s.pageId !== "string" || !PAGE_ID.test(s.pageId) || !isLowerHex(s.delegatePub, 65) || !isTime(s.at)) return null;
    sites.push({ pageId: s.pageId as string, delegatePub: s.delegatePub, at: s.at });
  }
  const ops: VoiciDraftOp[] = [];
  for (const o of v.pendingOps) {
    const p = parseVoiciDraftOp(o);
    if (!p) return null;
    ops.push(p);
  }
  return { v: 1, nicknames: nick, blocks, accepted, archived, readUpTo: read, signedInSites: sites, pendingOps: ops };
}

const uniqSorted = (a: string[]) => [...new Set(a)].sort();

/**
 * The compare-and-set merge (§10.1): sets are unions, a nickname with the newer `at` wins (ties: the local one),
 * readUpTo keeps the local entry when both have one, signed-in sites union by delegatePub (newer `at`), pending ops
 * union by opId. Output lists are sorted, so the merge is deterministic.
 */
export function mergeMessagesState(local: MessagesState, remote: MessagesState): MessagesState {
  const nicknames: MessagesState["nicknames"] = { ...remote.nicknames };
  for (const [k, n] of Object.entries(local.nicknames)) if (!nicknames[k] || n.at >= nicknames[k]!.at) nicknames[k] = n;
  const sites = new Map<string, MessagesState["signedInSites"][number]>();
  for (const s of [...remote.signedInSites, ...local.signedInSites]) {
    const cur = sites.get(s.delegatePub);
    if (!cur || s.at >= cur.at) sites.set(s.delegatePub, s);
  }
  const ops = new Map<string, VoiciDraftOp>();
  for (const o of [...remote.pendingOps, ...local.pendingOps]) ops.set(o.opId, o);
  const sortKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
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

export function sealMessagesState(
  stateKey: Bytes,
  username: string,
  version: number,
  s: MessagesState,
  nonce: Bytes = crypto.getRandomValues(new Uint8Array(12)),
): { version: number; nonce: string; ct: string } {
  if (!USERNAME.test(username) || !isTime(version) || version < 1 || nonce.length !== 12 || !parseMessagesState(s)) throw new Error(`${TAG_MESSAGES_STATE}: bad input`);
  const pt = canonicalJsonBytes(s);
  if (pt.length > VOICI_STATE_MAX_BYTES) throw new Error(`${TAG_MESSAGES_STATE}: too large`);
  const ct = gcm(stateKey, nonce, enc(`${TAG_MESSAGES_STATE}|${username}|${version}`)).encrypt(pt);
  return { version, nonce: hex(nonce), ct: b64Encode(ct) };
}

export function openMessagesState(stateKey: Bytes, username: string, blob: unknown): MessagesState | null {
  if (!isObj(blob) || !exactKeys(blob, ["version", "nonce", "ct"]) || !isTime(blob.version) || !isLowerHex(blob.nonce, 12)) return null;
  const ct = b64Decode(blob.ct);
  if (!ct || ct.length > VOICI_STATE_MAX_BYTES + 16) return null;
  try {
    const pt = gcm(stateKey, hexToBytes(blob.nonce), enc(`${TAG_MESSAGES_STATE}|${username}|${blob.version}`)).decrypt(ct);
    return parseMessagesState(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt)));
  } catch {
    return null;
  }
}

// ── reports, bans, takedowns (§9.2-§9.6) ──────────────────────────────────

export const VOICI_REPORT_REASONS = ["spam", "harassment", "impersonation", "illegal", "other"] as const;
export type VoiciReportReason = (typeof VOICI_REPORT_REASONS)[number];

/**
 * A message report, by the owner: flagship/voici-report/v1|message|<pageId>|<H(canonicalJson(envelope))>|<reason>|
 * <H(attached bytes) or "">|<issuedAt>, Ed25519 by ownerSignPub. Wire {kind:"message", pageId, envelope, reason,
 * attached: <b64>|null, issuedAt, signature}. `attached` = hybrid-seal/v1 of canonicalJson({v:1,text,replyTo}) to the
 * abuse key, purpose flagship/voici-report-text/v1, context [UTF-8 conv, UTF-8 msgId], senderKeyId =
 * SHA-256(raw ownerSignPub), issuedAt = the report's.
 */
export interface VoiciMessageReport {
  kind: "message";
  pageId: string;
  envelope: WebEnvelope;
  reason: VoiciReportReason;
  attached: string | null;
  issuedAt: number;
}

/**
 * A page report, by anyone: flagship/voici-report/v1|page|<username>|<seq>|<reason>|<H(UTF-8 note)>|<issuedAt>.
 * Anonymous (signer null) or signed by the visitor's browser key B: signer {delegation, delegationSig, sig} with
 * sig = P-256 P1363 over these bytes by delegation.delegatePub. Wire {kind:"page", username, seq, reason, note,
 * issuedAt, signer}.
 */
export interface VoiciPageReport {
  kind: "page";
  username: string;
  seq: number;
  reason: VoiciReportReason;
  note: string;
  issuedAt: number;
}

export function canonicalVoiciReport(r: VoiciMessageReport | VoiciPageReport): Bytes {
  if (!VOICI_REPORT_REASONS.includes(r.reason) || !isTime(r.issuedAt)) throw new Error(`${TAG_VOICI_REPORT}: bad field`);
  if (r.kind === "message") {
    needPageId(r.pageId);
    if (r.attached !== null && !b64Decode(r.attached)) throw new Error(`${TAG_VOICI_REPORT}: bad attached`);
    const att = r.attached === null ? "" : sha256Hex(b64Decode(r.attached)!);
    return enc([TAG_VOICI_REPORT, "message", r.pageId, sha256Hex(canonicalJsonBytes(r.envelope)), r.reason, att, String(r.issuedAt)].join("|"));
  }
  if (typeof r.username !== "string" || !USERNAME.test(r.username) || !isTime(r.seq) || r.seq < 1 || checkVoiciText("reportNote", r.note)) throw new Error(`${TAG_VOICI_REPORT}: bad field`);
  return enc([TAG_VOICI_REPORT, "page", r.username, String(r.seq), r.reason, sha256Hex(r.note), String(r.issuedAt)].join("|"));
}

export function signVoiciMessageReport(r: VoiciMessageReport, ownerSignSeed: Bytes): string {
  return hex(ed.sign(canonicalVoiciReport(r), ownerSignSeed));
}

export function verifyVoiciMessageReport(r: VoiciMessageReport, signature: string, ownerSignPub: string): boolean {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciReport(r), ownerSignPub);
  } catch {
    return false;
  }
}

export function sealVoiciReportText(
  abuseKeyPub: Bytes,
  o: { conv: string; msgId: string; ownerSignPub: string; issuedAt: number; plaintext: VoiciPlaintext },
  eseed: Bytes = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN)),
): Bytes {
  return hybridSealWithRandomness(
    abuseKeyPub,
    { purpose: TAG_VOICI_REPORT_TEXT, senderKeyId: sha256(hexToBytes(o.ownerSignPub)), issuedAt: o.issuedAt },
    [enc(o.conv), enc(o.msgId)],
    plaintextBytes(o.plaintext),
    eseed,
  );
}

export function openVoiciReportText(abuseKeySeed: Bytes, o: { conv: string; msgId: string }, sealed: Bytes): VoiciPlaintext {
  const pt = hybridOpen(abuseKeySeed, TAG_VOICI_REPORT_TEXT, [enc(o.conv), enc(o.msgId)], sealed).plaintext;
  const r = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt)) as VoiciPlaintext;
  return { v: 1, text: r.text, replyTo: r.replyTo };
}

/** Admin requests (`x-admin-secret`, scripts/voici-abuse.mjs): not signed records, just their strict shapes. */
export interface VoiciBanRequest {
  username: string;
  reportId: string;
  reason: VoiciReportReason;
}
export interface VoiciTakedownRequest {
  username: string;
  reason: VoiciReportReason;
}

export function parseVoiciBanRequest(v: unknown): VoiciBanRequest | null {
  if (!isObj(v) || !exactKeys(v, ["username", "reportId", "reason"])) return null;
  if (typeof v.username !== "string" || !USERNAME.test(v.username) || typeof v.reportId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.reportId)) return null;
  if (!VOICI_REPORT_REASONS.includes(v.reason as VoiciReportReason)) return null;
  return { username: v.username, reportId: v.reportId, reason: v.reason as VoiciReportReason };
}

export function parseVoiciTakedownRequest(v: unknown): VoiciTakedownRequest | null {
  if (!isObj(v) || !exactKeys(v, ["username", "reason"]) || typeof v.username !== "string" || !USERNAME.test(v.username)) return null;
  if (!VOICI_REPORT_REASONS.includes(v.reason as VoiciReportReason)) return null;
  return { username: v.username, reason: v.reason as VoiciReportReason };
}

// ── Sign in with Flagship over /qr-pipe (§6.1, §6.5) ───────────────────────

/**
 * Browser → app, inside the pipe's sealed channel after the 6-digit code matches (A: the browser must hand over B
 * before the app can sign the delegation): {kind:"flagship/voici-sign-in-request/v1", origin, pageId, username,
 * delegatePub, nonce}.
 */
export interface VoiciSignInRequest {
  kind: typeof TAG_VOICI_SIGN_IN_REQUEST;
  origin: string;
  pageId: string;
  username: string;
  delegatePub: string;
  nonce: string;
}

export function parseVoiciSignInRequest(v: unknown): VoiciSignInRequest | null {
  if (!isObj(v) || !exactKeys(v, ["kind", "origin", "pageId", "username", "delegatePub", "nonce"]) || v.kind !== TAG_VOICI_SIGN_IN_REQUEST) return null;
  if (typeof v.origin !== "string" || !/^https:\/\/[a-z0-9.-]{1,253}$/.test(v.origin)) return null;
  if (typeof v.pageId !== "string" || !PAGE_ID.test(v.pageId) || typeof v.username !== "string" || !USERNAME.test(v.username)) return null;
  if (!isLowerHex(v.delegatePub, 65) || !(v.delegatePub as string).startsWith("04") || !isLowerHex(v.nonce, 16)) return null;
  return { kind: TAG_VOICI_SIGN_IN_REQUEST, origin: v.origin, pageId: v.pageId as string, username: v.username, delegatePub: v.delegatePub, nonce: v.nonce };
}

/**
 * App → browser, sealed on the pipe (the remote-ticket construction): {kind:"flagship/voici-sign-in/v1", pageId,
 * pseudonymPub, attestation, delegation, delegationSig, threadStmt, threadSig, threadSeed}. threadSeed is T's 32-byte
 * X-Wing seed (hex) so the browser can open replies.
 */
export interface VoiciSignInAnswer extends VoiciMessageCred {
  kind: typeof TAG_VOICI_SIGN_IN;
  pageId: string;
  pseudonymPub: string;
  threadSeed: string;
}

/** The browser's check of the answer: everything it will put in each message's cred must already verify. */
export function checkVoiciSignInAnswer(
  v: unknown,
  want: { request: VoiciSignInRequest; caKeys: readonly string[]; now: number },
): { ok: true; answer: VoiciSignInAnswer } | { ok: false; code: "malformed" | "bad-attestation" | "bad-delegation" | "bad-thread" } {
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
      pageId: v.pageId as string,
      pseudonymPub: v.pseudonymPub,
      attestation: att.attestation,
      delegation: del.delegation,
      delegationSig: v.delegationSig as string,
      threadStmt: ts,
      threadSig: v.threadSig,
      threadSeed: v.threadSeed,
    },
  };
}

