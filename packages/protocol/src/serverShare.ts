/**
 * Sharing a server with another account (docs/share-a-server.md).
 *
 * A is the owner of server S; B is the account A shares S with. B's identity
 * toward S is a per-share key derived from B's UMK, so no owner can link B
 * across servers or apps. Nine '|'-joined envelopes (§4 of the spec), the
 * link-secret derivations, the 6-digit code both phones show, and the sealed
 * JSON payloads `.com` relays without being able to read.
 *
 * `test-vectors/server-share/vectors.json` is the cross-platform reference.
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes, Keypair, UserMasterKey } from "./types.js";

export const TAG_SERVER_SHARE = "flagship/server-share/v1";
export const TAG_SERVER_SHARE_REVOKE = "flagship/server-share-revoke/v1";
export const TAG_SERVER_SHARE_ACCEPT = "flagship/server-share-accept/v1";
export const TAG_SERVER_SHARE_LEAVE = "flagship/server-share-leave/v1";
export const TAG_SERVER_SHARE_SESSION = "flagship/server-share-session/v1";
export const TAG_SERVER_SHARE_OFFER = "flagship/server-share-offer/v1";
export const TAG_SERVER_SHARE_LIST = "flagship/server-share-list/v1";
export const TAG_SERVER_SHARE_UNLOCK = "flagship/server-share-unlock/v1";
export const TAG_SHARE_INBOX = "flagship/share-inbox/v1";

const INFO_MEMBER = "flagship/server-share-member/v1";
const INFO_TOKEN = "flagship/server-share/token/v1";
const INFO_LINK_KEY = "flagship/server-share/link-key/v1";
const INFO_INBOX = "flagship/share-inbox/v1";
const INFO_INBOX_KEY = "flagship/share-inbox-key/v1";
const SAS_TAG = "flagship/server-share/sas/v1";
export const AAD_SHARE_OFFER = "flagship/server-share/offer/v1";
export const AAD_SHARE_ACCEPTANCE = "flagship/server-share/acceptance/v1";
export const AAD_SHARE_OWNER = "flagship/server-share/owner/v1";
export const AAD_SHARE_INBOX_ENTRY = "flagship/share-inbox/entry/v1";

/** How long B has to accept a link. */
export const SHARE_OFFER_TTL_MS = 7 * 24 * 3600 * 1000;
export const SHARE_LABEL_MAX = 64;
/** `sealedSha256` value that withdraws B's boot copy. */
export const SHARE_UNLOCK_OFF = "off";

export type ShareLevel = "view" | "manage";
export const SHARE_LEVELS: readonly ShareLevel[] = ["view", "manage"];
export type ShareInboxOp = "put" | "list" | "delete";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

// ──────────────────────────────────────────────────────────────────────
// Keys
// ──────────────────────────────────────────────────────────────────────

function hk(ikm: Bytes, info: string): Bytes {
  return hkdf(sha256, ikm, new Uint8Array(0), enc.encode(info), 32);
}

function keypair(seed: Bytes): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

/** B's identity toward one share (so one server): unlinkable everywhere else. */
export function deriveShareMemberKey(umk: UserMasterKey, shareId: string): Keypair {
  checkShareId(shareId);
  return keypair(hk(umk.seed, `${INFO_MEMBER}|${shareId}`));
}

/** Signs B's "Shared with me" inbox requests; its public key is the inbox id. */
export function deriveShareInboxKey(umk: UserMasterKey): Keypair {
  return keypair(hk(umk.seed, INFO_INBOX));
}

/** Seals B's inbox entries. */
export function deriveShareInboxSealKey(umk: UserMasterKey): Bytes {
  return hk(umk.seed, INFO_INBOX_KEY);
}

/** The bearer token the link grants (`x-flagship-share-token`), lowercase hex. */
export function shareTokenFromSecret(secret: Bytes): string {
  checkSecret(secret);
  return hex(hk(secret, INFO_TOKEN));
}

/** What `.com` stores for the token: SHA-256 hex of the token's bytes. */
export function shareTokenHash(tokenHex: string): string {
  if (!HEX64.test(tokenHex)) throw new Error("server-share: token must be 64 lowercase hex");
  return hex(sha256(fromHex(tokenHex)));
}

/** AES-256-GCM key for the offer and the acceptance. */
export function shareLinkKey(secret: Bytes): Bytes {
  checkSecret(secret);
  return hk(secret, INFO_LINK_KEY);
}

/** The six digits both phones show, as `"123456"`. */
export function shareSas(shareId: string, memberPubHex: string, secret: Bytes): string {
  checkShareId(shareId);
  checkHex64("memberPubHex", memberPubHex);
  checkSecret(secret);
  const d = sha256(enc.encode([SAS_TAG, shareId, memberPubHex, hex(secret)].join("|")));
  const n = ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

/** `"123456"` → `"123 456"`. */
export function formatShareSas(sas: string): string {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Sealed JSON payloads (lowercase hex `nonce12 || ct+tag`)
// ──────────────────────────────────────────────────────────────────────

export function shareAad(prefix: string, id: string): Bytes {
  legacyFieldGuard("aad id", id);
  return enc.encode(`${prefix}|${id}`);
}

export function sealShareJson(key: Bytes, aad: Bytes, value: unknown, nonce?: Bytes): string {
  if (key.length !== 32) throw new Error("server-share: key must be 32 bytes");
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (n.length !== 12) throw new Error("server-share: nonce must be 12 bytes");
  const ct = gcm(key, n, aad).encrypt(enc.encode(JSON.stringify(value)));
  const out = new Uint8Array(12 + ct.length);
  out.set(n, 0);
  out.set(ct, 12);
  return hex(out);
}

/** Throws on a wrong key, wrong AAD or tampered ciphertext. */
export function openShareJson(key: Bytes, aad: Bytes, sealedHex: string): unknown {
  if (key.length !== 32) throw new Error("server-share: key must be 32 bytes");
  if (!/^([0-9a-f]{2})+$/.test(sealedHex)) throw new Error("server-share: sealed payload must be hex");
  const buf = fromHex(sealedHex);
  if (buf.length < 12 + 16) throw new Error("server-share: sealed payload too short");
  const plain = gcm(key, buf.slice(0, 12), aad).decrypt(buf.slice(12));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as unknown;
}

export interface ShareOfferPayload {
  v: 1;
  serverDomain: string;
  /** A's short name for the server, as A's app shows it. */
  serverName: string;
  /** The box STK, so B seals boot approvals only for it (.com can't swap it). */
  stkPubHex: string;
  level: ShareLevel;
  unlockAtBoot: boolean;
  seeAppData: boolean;
  expiresAt: number;
}

export interface ShareOwnerRecord {
  v: 1;
  secretHex: string;
  label: string;
  level: ShareLevel;
  unlockAtBoot: boolean;
  seeAppData: boolean;
}

export interface ShareAcceptancePayload {
  v: 1;
  accept: ServerShareAccept;
  signature: string;
}

export interface ShareInboxEntry {
  v: 1;
  shareId: string;
  secretHex: string;
  serverDomain: string;
  serverName: string;
  acceptedAt: number;
}

export function parseShareOfferPayload(v: unknown): ShareOfferPayload | null {
  const o = obj(v);
  if (!o || o.v !== 1) return null;
  if (typeof o.serverDomain !== "string" || o.serverDomain.length === 0) return null;
  if (typeof o.serverName !== "string") return null;
  if (typeof o.stkPubHex !== "string" || !HEX64.test(o.stkPubHex)) return null;
  if (o.level !== "view" && o.level !== "manage") return null;
  if (typeof o.unlockAtBoot !== "boolean" || typeof o.seeAppData !== "boolean") return null;
  if (!isTime(o.expiresAt)) return null;
  return {
    v: 1,
    serverDomain: o.serverDomain,
    serverName: o.serverName,
    stkPubHex: o.stkPubHex,
    level: o.level,
    unlockAtBoot: o.unlockAtBoot,
    seeAppData: o.seeAppData,
    expiresAt: o.expiresAt,
  };
}

export function parseShareOwnerRecord(v: unknown): ShareOwnerRecord | null {
  const o = obj(v);
  if (!o || o.v !== 1) return null;
  if (typeof o.secretHex !== "string" || !HEX64.test(o.secretHex)) return null;
  if (typeof o.label !== "string" || normalizeShareLabel(o.label) === null) return null;
  if (o.level !== "view" && o.level !== "manage") return null;
  if (typeof o.unlockAtBoot !== "boolean" || typeof o.seeAppData !== "boolean") return null;
  return { v: 1, secretHex: o.secretHex, label: o.label, level: o.level, unlockAtBoot: o.unlockAtBoot, seeAppData: o.seeAppData };
}

export function parseShareAcceptancePayload(v: unknown): ShareAcceptancePayload | null {
  const o = obj(v);
  if (!o || o.v !== 1 || typeof o.signature !== "string" || !/^[0-9a-f]{128}$/.test(o.signature)) return null;
  const accept = parseServerShareAccept(o.accept);
  return accept ? { v: 1, accept, signature: o.signature } : null;
}

export function parseShareInboxEntry(v: unknown): ShareInboxEntry | null {
  const o = obj(v);
  if (!o || o.v !== 1) return null;
  if (typeof o.shareId !== "string" || !HEX32.test(o.shareId)) return null;
  if (typeof o.secretHex !== "string" || !HEX64.test(o.secretHex)) return null;
  if (typeof o.serverDomain !== "string" || typeof o.serverName !== "string") return null;
  if (!isTime(o.acceptedAt)) return null;
  return { v: 1, shareId: o.shareId, secretHex: o.secretHex, serverDomain: o.serverDomain, serverName: o.serverName, acceptedAt: o.acceptedAt };
}

// ──────────────────────────────────────────────────────────────────────
// The link: https://<apex>/share#s=<shareId>&k=<secretHex>
// ──────────────────────────────────────────────────────────────────────

export function buildShareLink(apexOrigin: string, shareId: string, secret: Bytes): string {
  checkShareId(shareId);
  checkSecret(secret);
  return `${apexOrigin.replace(/\/+$/, "")}/share#s=${shareId}&k=${hex(secret)}`;
}

/**
 * Accepts the https link (fragment), `flagship://share?s=&k=`, or a bare
 * `s=…&k=…`. Returns null for anything else.
 */
export function parseShareLink(text: string): { shareId: string; secretHex: string } | null {
  const t = text.trim();
  let params: string;
  const hash = t.indexOf("#");
  const q = t.indexOf("?");
  if (/^https?:\/\//i.test(t)) {
    if (hash < 0) return null;
    let path: string;
    try {
      path = new URL(t).pathname;
    } catch {
      return null;
    }
    if (path !== "/share") return null;
    params = t.slice(hash + 1);
  } else if (/^flagship:\/\/share/i.test(t)) {
    params = q >= 0 ? t.slice(q + 1) : hash >= 0 ? t.slice(hash + 1) : "";
  } else {
    params = t;
  }
  let s: string | null = null;
  let k: string | null = null;
  for (const part of params.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1).toLowerCase();
    if (key === "s") s = value;
    if (key === "k") k = value;
  }
  if (!s || !k || !HEX32.test(s) || !HEX64.test(k)) return null;
  return { shareId: s, secretHex: k };
}

// ──────────────────────────────────────────────────────────────────────
// Envelopes
// ──────────────────────────────────────────────────────────────────────

/** #1 — signed by A's sensitive key; the box keeps the newest per shareId. */
export interface ServerShareGrant {
  serverDomain: string;
  shareId: string;
  memberPubHex: string;
  level: ShareLevel;
  unlockAtBoot: boolean;
  seeAppData: boolean;
  /** A's name for B on this server. */
  label: string;
  issuedAt: number;
}

/** #2 — signed by A's sensitive key; ends the share id forever. */
export interface ServerShareRevoke {
  serverDomain: string;
  shareId: string;
  issuedAt: number;
}

/** #3 — signed by B's member key. */
export interface ServerShareAccept {
  serverDomain: string;
  shareId: string;
  memberPubHex: string;
  acceptedAt: number;
}

/** #4 — signed by B's member key; ends the share id forever. */
export interface ServerShareLeave {
  serverDomain: string;
  shareId: string;
  memberPubHex: string;
  issuedAt: number;
}

/** #5 — signed by B's member key over a box nonce. */
export interface ServerShareSession {
  serverDomain: string;
  shareId: string;
  memberPubHex: string;
  nonceHex: string;
  issuedAt: number;
}

/** #6 — signed by A's sensitive key; creates the `.com` offer row. */
export interface ServerShareOffer {
  username: string;
  serverDomain: string;
  shareId: string;
  tokenHash: string;
  /** SHA-256 hex of the sealed offer hex. */
  offerSha256: string;
  /** SHA-256 hex of the sealed owner-record hex. */
  ownerSha256: string;
  expiresAt: number;
  issuedAt: number;
}

/** #7 — signed by A; lists A's offer rows. */
export interface ServerShareList {
  username: string;
  issuedAt: number;
}

/** #8 — signed by A's sensitive key; puts or withdraws B's boot copy. */
export interface ServerShareUnlock {
  serverDomain: string;
  shareId: string;
  memberPubHex: string;
  /** SHA-256 hex of the sealed copy's hex, or `off`. */
  sealedSha256: string;
  issuedAt: number;
}

/** #9 — signed by B's inbox key. */
export interface ShareInboxRequest {
  inboxPubHex: string;
  op: ShareInboxOp;
  /** 32 hex, or "" for `list`. */
  entryId: string;
  /** SHA-256 hex of the entry ciphertext's hex for `put`, else "". */
  ctSha256: string;
  issuedAt: number;
}

export function serverShareGrantCanonicalBytes(g: ServerShareGrant): Bytes {
  domain(g.serverDomain);
  checkShareId(g.shareId);
  checkHex64("memberPubHex", g.memberPubHex);
  if (g.level !== "view" && g.level !== "manage") throw new Error("server-share: level must be view or manage");
  bool("unlockAtBoot", g.unlockAtBoot);
  bool("seeAppData", g.seeAppData);
  if (normalizeShareLabel(g.label) !== g.label) throw new Error("server-share: label must be 1-64 trimmed characters");
  time("issuedAt", g.issuedAt);
  return join(TAG_SERVER_SHARE, [
    g.serverDomain,
    g.shareId,
    g.memberPubHex,
    g.level,
    g.unlockAtBoot ? "1" : "0",
    g.seeAppData ? "1" : "0",
    g.label,
    String(g.issuedAt),
  ]);
}

export function serverShareRevokeCanonicalBytes(r: ServerShareRevoke): Bytes {
  domain(r.serverDomain);
  checkShareId(r.shareId);
  time("issuedAt", r.issuedAt);
  return join(TAG_SERVER_SHARE_REVOKE, [r.serverDomain, r.shareId, String(r.issuedAt)]);
}

export function serverShareAcceptCanonicalBytes(a: ServerShareAccept): Bytes {
  domain(a.serverDomain);
  checkShareId(a.shareId);
  checkHex64("memberPubHex", a.memberPubHex);
  time("acceptedAt", a.acceptedAt);
  return join(TAG_SERVER_SHARE_ACCEPT, [a.serverDomain, a.shareId, a.memberPubHex, String(a.acceptedAt)]);
}

export function serverShareLeaveCanonicalBytes(l: ServerShareLeave): Bytes {
  domain(l.serverDomain);
  checkShareId(l.shareId);
  checkHex64("memberPubHex", l.memberPubHex);
  time("issuedAt", l.issuedAt);
  return join(TAG_SERVER_SHARE_LEAVE, [l.serverDomain, l.shareId, l.memberPubHex, String(l.issuedAt)]);
}

export function serverShareSessionCanonicalBytes(s: ServerShareSession): Bytes {
  domain(s.serverDomain);
  checkShareId(s.shareId);
  checkHex64("memberPubHex", s.memberPubHex);
  checkHex64("nonceHex", s.nonceHex);
  time("issuedAt", s.issuedAt);
  return join(TAG_SERVER_SHARE_SESSION, [s.serverDomain, s.shareId, s.memberPubHex, s.nonceHex, String(s.issuedAt)]);
}

export function serverShareOfferCanonicalBytes(o: ServerShareOffer): Bytes {
  nonEmpty("username", o.username);
  domain(o.serverDomain);
  checkShareId(o.shareId);
  checkHex64("tokenHash", o.tokenHash);
  checkHex64("offerSha256", o.offerSha256);
  checkHex64("ownerSha256", o.ownerSha256);
  time("expiresAt", o.expiresAt);
  time("issuedAt", o.issuedAt);
  return join(TAG_SERVER_SHARE_OFFER, [
    o.username,
    o.serverDomain,
    o.shareId,
    o.tokenHash,
    o.offerSha256,
    o.ownerSha256,
    String(o.expiresAt),
    String(o.issuedAt),
  ]);
}

export function serverShareListCanonicalBytes(l: ServerShareList): Bytes {
  nonEmpty("username", l.username);
  time("issuedAt", l.issuedAt);
  return join(TAG_SERVER_SHARE_LIST, [l.username, String(l.issuedAt)]);
}

export function serverShareUnlockCanonicalBytes(u: ServerShareUnlock): Bytes {
  domain(u.serverDomain);
  checkShareId(u.shareId);
  checkHex64("memberPubHex", u.memberPubHex);
  if (u.sealedSha256 !== SHARE_UNLOCK_OFF) checkHex64("sealedSha256", u.sealedSha256);
  time("issuedAt", u.issuedAt);
  return join(TAG_SERVER_SHARE_UNLOCK, [u.serverDomain, u.shareId, u.memberPubHex, u.sealedSha256, String(u.issuedAt)]);
}

export function shareInboxRequestCanonicalBytes(r: ShareInboxRequest): Bytes {
  checkHex64("inboxPubHex", r.inboxPubHex);
  if (r.op !== "put" && r.op !== "list" && r.op !== "delete") throw new Error("share-inbox: op must be put, list or delete");
  if (r.op === "list") {
    if (r.entryId !== "") throw new Error("share-inbox: list takes no entryId");
  } else if (!HEX32.test(r.entryId)) {
    throw new Error("share-inbox: entryId must be 32 lowercase hex");
  }
  if (r.op === "put") checkHex64("ctSha256", r.ctSha256);
  else if (r.ctSha256 !== "") throw new Error("share-inbox: only put carries ctSha256");
  time("issuedAt", r.issuedAt);
  return join(TAG_SHARE_INBOX, [r.inboxPubHex, r.op, r.entryId, r.ctSha256, String(r.issuedAt)]);
}

type Canon<T> = (v: T) => Bytes;

function signer<T>(canon: Canon<T>) {
  return (v: T, s: MsgSigner): Bytes => resolveMsgSigner(s)(canon(v));
}

function verifier<T>(canon: Canon<T>) {
  return (v: T, sig: Bytes, pub: Bytes): boolean => {
    try {
      return ed.verify(sig, canon(v), pub);
    } catch {
      return false;
    }
  };
}

export const signServerShareGrant = signer(serverShareGrantCanonicalBytes);
export const verifyServerShareGrant = verifier(serverShareGrantCanonicalBytes);
export const signServerShareRevoke = signer(serverShareRevokeCanonicalBytes);
export const verifyServerShareRevoke = verifier(serverShareRevokeCanonicalBytes);
export const signServerShareAccept = signer(serverShareAcceptCanonicalBytes);
export const verifyServerShareAccept = verifier(serverShareAcceptCanonicalBytes);
export const signServerShareLeave = signer(serverShareLeaveCanonicalBytes);
export const verifyServerShareLeave = verifier(serverShareLeaveCanonicalBytes);
export const signServerShareSession = signer(serverShareSessionCanonicalBytes);
export const verifyServerShareSession = verifier(serverShareSessionCanonicalBytes);
export const signServerShareOffer = signer(serverShareOfferCanonicalBytes);
export const verifyServerShareOffer = verifier(serverShareOfferCanonicalBytes);
export const signServerShareList = signer(serverShareListCanonicalBytes);
export const verifyServerShareList = verifier(serverShareListCanonicalBytes);
export const signServerShareUnlock = signer(serverShareUnlockCanonicalBytes);
export const verifyServerShareUnlock = verifier(serverShareUnlockCanonicalBytes);
export const signShareInboxRequest = signer(shareInboxRequestCanonicalBytes);
export const verifyShareInboxRequest = verifier(shareInboxRequestCanonicalBytes);

// ──────────────────────────────────────────────────────────────────────
// Untrusted JSON → envelope (shape only; the canonical builder re-checks)
// ──────────────────────────────────────────────────────────────────────

function parsed<T>(canon: Canon<T>, build: (o: Record<string, unknown>) => T | null) {
  return (v: unknown): T | null => {
    const o = obj(v);
    if (!o) return null;
    const out = build(o);
    if (!out) return null;
    try {
      canon(out);
    } catch {
      return null;
    }
    return out;
  };
}

const str = (v: unknown): v is string => typeof v === "string";

export const parseServerShareGrant = parsed(serverShareGrantCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && (o.level === "view" || o.level === "manage") &&
  typeof o.unlockAtBoot === "boolean" && typeof o.seeAppData === "boolean" && str(o.label) && isTime(o.issuedAt)
    ? {
        serverDomain: o.serverDomain,
        shareId: o.shareId,
        memberPubHex: o.memberPubHex,
        level: o.level as ShareLevel,
        unlockAtBoot: o.unlockAtBoot,
        seeAppData: o.seeAppData,
        label: o.label,
        issuedAt: o.issuedAt,
      }
    : null,
);

export const parseServerShareRevoke = parsed(serverShareRevokeCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && isTime(o.issuedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, issuedAt: o.issuedAt }
    : null,
);

export const parseServerShareAccept = parsed(serverShareAcceptCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && isTime(o.acceptedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, memberPubHex: o.memberPubHex, acceptedAt: o.acceptedAt }
    : null,
);

export const parseServerShareLeave = parsed(serverShareLeaveCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && isTime(o.issuedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, memberPubHex: o.memberPubHex, issuedAt: o.issuedAt }
    : null,
);

export const parseServerShareSession = parsed(serverShareSessionCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && str(o.nonceHex) && isTime(o.issuedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, memberPubHex: o.memberPubHex, nonceHex: o.nonceHex, issuedAt: o.issuedAt }
    : null,
);

export const parseServerShareOffer = parsed(serverShareOfferCanonicalBytes, (o) =>
  str(o.username) && str(o.serverDomain) && str(o.shareId) && str(o.tokenHash) && str(o.offerSha256) &&
  str(o.ownerSha256) && isTime(o.expiresAt) && isTime(o.issuedAt)
    ? {
        username: o.username,
        serverDomain: o.serverDomain,
        shareId: o.shareId,
        tokenHash: o.tokenHash,
        offerSha256: o.offerSha256,
        ownerSha256: o.ownerSha256,
        expiresAt: o.expiresAt,
        issuedAt: o.issuedAt,
      }
    : null,
);

export const parseServerShareList = parsed(serverShareListCanonicalBytes, (o) =>
  str(o.username) && isTime(o.issuedAt) ? { username: o.username, issuedAt: o.issuedAt } : null,
);

export const parseServerShareUnlock = parsed(serverShareUnlockCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && str(o.sealedSha256) && isTime(o.issuedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, memberPubHex: o.memberPubHex, sealedSha256: o.sealedSha256, issuedAt: o.issuedAt }
    : null,
);

export const parseShareInboxRequest = parsed(shareInboxRequestCanonicalBytes, (o) =>
  str(o.inboxPubHex) && (o.op === "put" || o.op === "list" || o.op === "delete") && str(o.entryId) &&
  str(o.ctSha256) && isTime(o.issuedAt)
    ? { inboxPubHex: o.inboxPubHex, op: o.op as ShareInboxOp, entryId: o.entryId, ctSha256: o.ctSha256, issuedAt: o.issuedAt }
    : null,
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Trimmed label, or null when it can't be a label (empty, too long, `|`, control chars). */
export function normalizeShareLabel(raw: string): string | null {
  const t = raw.trim();
  if (t.length === 0 || [...t].length > SHARE_LABEL_MAX) return null;
  if (/[|\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** SHA-256 hex of a string's UTF-8 bytes (the `*Sha256` fields). */
export function shareSha256Hex(s: string): string {
  return hex(sha256(enc.encode(s)));
}

/** 16 random bytes as 32 lowercase hex (share ids, inbox entry ids). */
export function randomShareId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function join(tag: string, fields: string[]): Bytes {
  return enc.encode([tag, ...fields].join("|"));
}

function domain(v: string): void {
  nonEmpty("serverDomain", v);
}

function nonEmpty(name: string, v: string): void {
  if (typeof v !== "string" || v.length === 0) throw new Error(`server-share: empty ${name}`);
  legacyFieldGuard(name, v);
}

function checkShareId(v: string): void {
  if (typeof v !== "string" || !HEX32.test(v)) throw new Error("server-share: shareId must be 32 lowercase hex");
}

function checkHex64(name: string, v: string): void {
  if (typeof v !== "string" || !HEX64.test(v)) throw new Error(`server-share: ${name} must be 64 lowercase hex`);
}

function checkSecret(s: Bytes): void {
  if (s.length !== 32) throw new Error("server-share: link secret must be 32 bytes");
}

function bool(name: string, v: boolean): void {
  if (typeof v !== "boolean") throw new Error(`server-share: ${name} must be a boolean`);
}

function time(name: string, v: number): void {
  if (!isTime(v)) throw new Error(`server-share: bad ${name}`);
}

function isTime(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function fromHex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
