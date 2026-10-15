// Sharing a server with another account (docs/share-a-server.md §3, §4): the
// webapp port of packages/protocol/src/serverShare.ts. A owns server S; B is
// the account A shares S with. B's identity toward S is a per-share key from
// B's UMK. Nine '|'-joined Ed25519 envelopes, the link-secret derivations, the
// six-digit code both phones show, and the sealed JSON payloads `.com` relays.
//
// Everything is WebCrypto (HKDF-SHA256, SHA-256, Ed25519, AES-256-GCM), so
// every helper that hashes, derives, signs, verifies or seals is ASYNC and
// resolves to what its TS twin returns. The canonical builders, parsers,
// normalizeShareLabel, formatShareSas, shareAad, the link helpers and
// randomShareId stay synchronous. Bytes are Uint8Array; hex is lowercase.
//
// Signers: `signX(value, signer)` takes a 32-byte Ed25519 seed, an async
// `(bytes) => Uint8Array` function, or `{ umk, signWithIrk }` (keystore's
// sensitive-order signer, as appAccess.signAccessList takes it).
//
// sealShareJson encrypts the exact string it is given (callers JSON.stringify
// in the key order the spec lists); a non-string value is JSON.stringify'd.
//
// Must pass packages/protocol/test-vectors/server-share/vectors.json.

export const TAG_SERVER_SHARE = "flagship/server-share/v1";
export const TAG_SERVER_SHARE_REVOKE = "flagship/server-share-revoke/v1";
export const TAG_SERVER_SHARE_ACCEPT = "flagship/server-share-accept/v1";
export const TAG_SERVER_SHARE_LEAVE = "flagship/server-share-leave/v1";
export const TAG_SERVER_SHARE_SESSION = "flagship/server-share-session/v1";
export const TAG_SERVER_SHARE_OFFER = "flagship/server-share-offer/v1";
export const TAG_SERVER_SHARE_LIST = "flagship/server-share-list/v1";
export const TAG_SERVER_SHARE_UNLOCK = "flagship/server-share-unlock/v1";
export const TAG_SHARE_INBOX = "flagship/share-inbox/v1";
export const TAG_SERVER_SHARE_PUSH = "flagship/server-share-push/v1";
export const TAG_SERVER_SHARE_UPDATE = "flagship/server-share-update/v1";

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

export const SHARE_OFFER_TTL_MS = 7 * 24 * 3600 * 1000;
export const SHARE_LABEL_MAX = 64;
export const SHARE_UNLOCK_OFF = "off";
export const SHARE_LEVELS = Object.freeze(["view", "manage"]);
export const SHARE_PUSH_PLATFORMS = Object.freeze(["apns", "fcm", "webpush"]);

const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

// ──────────────────────────────────────────────────────────────────────
// Bytes / WebCrypto primitives (self-contained: imported in Node tests)
// ──────────────────────────────────────────────────────────────────────

function toHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesOf(v, name) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string" && /^([0-9a-f]{2})*$/i.test(v)) return fromHex(v.toLowerCase());
  throw new Error(`server-share: ${name} must be bytes or hex`);
}

async function hk(ikm, info) {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const PKCS8_ED25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function checkSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("server-share: Ed25519 seed must be 32 bytes");
}

async function importSeed(seed, extractable) {
  checkSeed(seed);
  const pkcs8 = new Uint8Array(PKCS8_ED25519.length + 32);
  pkcs8.set(PKCS8_ED25519, 0);
  pkcs8.set(seed, PKCS8_ED25519.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, extractable, ["sign"]);
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Raw 32-byte Ed25519 public key of a seed. */
export async function ed25519PublicKey(seed) {
  const jwk = await crypto.subtle.exportKey("jwk", await importSeed(seed, true));
  if (typeof jwk.x !== "string") throw new Error("server-share: Ed25519 export missing x");
  return b64urlToBytes(jwk.x);
}

async function edSign(seed, msg) {
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await importSeed(seed, false), msg));
}

async function edVerify(sig, msg, pub) {
  try {
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
  } catch {
    return false;
  }
}

async function keypair(seed) {
  return { seed, privateKey: seed, publicKey: await ed25519PublicKey(seed) };
}

// ──────────────────────────────────────────────────────────────────────
// Keys
// ──────────────────────────────────────────────────────────────────────

function umkSeedOf(umk) {
  const seed = umk && !(umk instanceof Uint8Array) && umk.seed instanceof Uint8Array ? umk.seed : umk;
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("server-share: UMK seed must be 32 bytes");
  return seed;
}

/** B's identity toward one share: `{seed, privateKey (= seed), publicKey}`. */
export async function deriveShareMemberKey(umkSeed, shareId) {
  checkShareId(shareId);
  return keypair(await hk(umkSeedOf(umkSeed), `${INFO_MEMBER}|${shareId}`));
}

/** Sign with B's member key for one share (its sign-ins to that server's apps). */
export async function signWithShareMemberKey(umkSeed, shareId, bytes) {
  return edSign((await deriveShareMemberKey(umkSeed, shareId)).seed, bytes);
}

/** Signs B's "Shared with me" inbox requests; its public key is the inbox id. */
export async function deriveShareInboxKey(umkSeed) {
  return keypair(await hk(umkSeedOf(umkSeed), INFO_INBOX));
}

/** Seals B's inbox entries (32 raw bytes). */
export async function deriveShareInboxSealKey(umkSeed) {
  return hk(umkSeedOf(umkSeed), INFO_INBOX_KEY);
}

/** The bearer token the link grants (`x-flagship-share-token`), lowercase hex. */
export async function shareTokenFromSecret(secret) {
  checkSecret(secret);
  return toHex(await hk(secret, INFO_TOKEN));
}

/** What `.com` stores for the token: SHA-256 hex of the token's bytes. */
export async function shareTokenHash(tokenHex) {
  if (typeof tokenHex !== "string" || !HEX64.test(tokenHex)) throw new Error("server-share: token must be 64 lowercase hex");
  return toHex(await sha256(fromHex(tokenHex)));
}

/** AES-256-GCM key (32 raw bytes) for the offer and the acceptance. */
export async function shareLinkKey(secret) {
  checkSecret(secret);
  return hk(secret, INFO_LINK_KEY);
}

/** The six digits both phones show, as `"123456"`. */
export async function shareSas(shareId, memberPubHex, secret) {
  checkShareId(shareId);
  checkHex64("memberPubHex", memberPubHex);
  checkSecret(secret);
  const d = await sha256(enc.encode([SAS_TAG, shareId, memberPubHex, toHex(secret)].join("|")));
  const n = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

/** `"123456"` → `"123 456"`. */
export function formatShareSas(sas) {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Sealed JSON payloads (lowercase hex `nonce12 || ct+tag`)
// ──────────────────────────────────────────────────────────────────────

export function shareAad(prefix, id) {
  legacyFieldGuard("aad id", id);
  return enc.encode(`${prefix}|${id}`);
}

async function gcmKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("server-share: key must be 32 bytes");
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Seal `plaintext` (the exact string; anything else is JSON.stringify'd) under
 * `key` with `aad`. `nonce` (12 bytes) is for vectors only; omit it.
 */
export async function sealShareJson(key, aad, plaintext, nonce) {
  const k = await gcmKey(key);
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (!(n instanceof Uint8Array) || n.length !== 12) throw new Error("server-share: nonce must be 12 bytes");
  const text = typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: n, additionalData: aad }, k, enc.encode(text)),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(n, 0);
  out.set(ct, 12);
  return toHex(out);
}

/** Parsed JSON. Rejects on a wrong key, wrong AAD or tampered ciphertext. */
export async function openShareJson(key, aad, sealedHex) {
  const k = await gcmKey(key);
  if (typeof sealedHex !== "string" || !/^([0-9a-f]{2})+$/.test(sealedHex)) {
    throw new Error("server-share: sealed payload must be hex");
  }
  const buf = fromHex(sealedHex);
  if (buf.length < 12 + 16) throw new Error("server-share: sealed payload too short");
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: aad }, k, buf.slice(12)),
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
}

export function parseShareOfferPayload(v) {
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

export function parseShareOwnerRecord(v) {
  const o = obj(v);
  if (!o || o.v !== 1) return null;
  if (typeof o.secretHex !== "string" || !HEX64.test(o.secretHex)) return null;
  if (typeof o.label !== "string" || normalizeShareLabel(o.label) === null) return null;
  if (o.level !== "view" && o.level !== "manage") return null;
  if (typeof o.unlockAtBoot !== "boolean" || typeof o.seeAppData !== "boolean") return null;
  return { v: 1, secretHex: o.secretHex, label: o.label, level: o.level, unlockAtBoot: o.unlockAtBoot, seeAppData: o.seeAppData };
}

export function parseShareAcceptancePayload(v) {
  const o = obj(v);
  if (!o || o.v !== 1 || typeof o.signature !== "string" || !/^[0-9a-f]{128}$/.test(o.signature)) return null;
  const accept = parseServerShareAccept(o.accept);
  return accept ? { v: 1, accept, signature: o.signature } : null;
}

export function parseShareInboxEntry(v) {
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

export function buildShareLink(apexOrigin, shareId, secret) {
  checkShareId(shareId);
  checkSecret(secret);
  return `${apexOrigin.replace(/\/+$/, "")}/share#s=${shareId}&k=${toHex(secret)}`;
}

/**
 * Accepts the https link (fragment), `flagship://share?s=&k=`, or a bare
 * `s=…&k=…`. Returns `{shareId, secretHex}` or null.
 */
export function parseShareLink(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  let params;
  const hash = t.indexOf("#");
  const q = t.indexOf("?");
  if (/^https?:\/\//i.test(t)) {
    if (hash < 0) return null;
    let path;
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
  let s = null;
  let k = null;
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
// Envelopes (canonical bytes; field order per spec §4)
// ──────────────────────────────────────────────────────────────────────

/** #1 grant — A's sensitive key. */
export function serverShareGrantCanonicalBytes(g) {
  domain(g.serverDomain);
  checkShareId(g.shareId);
  checkHex64("memberPubHex", g.memberPubHex);
  if (g.level !== "view" && g.level !== "manage") throw new Error("server-share: level must be view or manage");
  bool("unlockAtBoot", g.unlockAtBoot);
  bool("seeAppData", g.seeAppData);
  if (typeof g.label !== "string" || normalizeShareLabel(g.label) !== g.label) {
    throw new Error("server-share: label must be 1-64 trimmed characters");
  }
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

/** #2 revoke — A's sensitive key. */
export function serverShareRevokeCanonicalBytes(r) {
  domain(r.serverDomain);
  checkShareId(r.shareId);
  time("issuedAt", r.issuedAt);
  return join(TAG_SERVER_SHARE_REVOKE, [r.serverDomain, r.shareId, String(r.issuedAt)]);
}

/** #3 accept — B's member key. */
export function serverShareAcceptCanonicalBytes(a) {
  domain(a.serverDomain);
  checkShareId(a.shareId);
  checkHex64("memberPubHex", a.memberPubHex);
  time("acceptedAt", a.acceptedAt);
  return join(TAG_SERVER_SHARE_ACCEPT, [a.serverDomain, a.shareId, a.memberPubHex, String(a.acceptedAt)]);
}

/** #4 leave — B's member key. */
export function serverShareLeaveCanonicalBytes(l) {
  domain(l.serverDomain);
  checkShareId(l.shareId);
  checkHex64("memberPubHex", l.memberPubHex);
  time("issuedAt", l.issuedAt);
  return join(TAG_SERVER_SHARE_LEAVE, [l.serverDomain, l.shareId, l.memberPubHex, String(l.issuedAt)]);
}

/** #5 session — B's member key over a box nonce. */
export function serverShareSessionCanonicalBytes(s) {
  domain(s.serverDomain);
  checkShareId(s.shareId);
  checkHex64("memberPubHex", s.memberPubHex);
  checkHex64("nonceHex", s.nonceHex);
  time("issuedAt", s.issuedAt);
  return join(TAG_SERVER_SHARE_SESSION, [s.serverDomain, s.shareId, s.memberPubHex, s.nonceHex, String(s.issuedAt)]);
}

/** #6 offer — A's sensitive key; creates the `.com` offer row. */
export function serverShareOfferCanonicalBytes(o) {
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

/** #7 list — A; lists A's offer rows. */
export function serverShareListCanonicalBytes(l) {
  nonEmpty("username", l.username);
  time("issuedAt", l.issuedAt);
  return join(TAG_SERVER_SHARE_LIST, [l.username, String(l.issuedAt)]);
}

/** #8 unlock — A's sensitive key; `sealedSha256` is 64 hex or `off`. */
export function serverShareUnlockCanonicalBytes(u) {
  domain(u.serverDomain);
  checkShareId(u.shareId);
  checkHex64("memberPubHex", u.memberPubHex);
  if (u.sealedSha256 !== SHARE_UNLOCK_OFF) checkHex64("sealedSha256", u.sealedSha256);
  time("issuedAt", u.issuedAt);
  return join(TAG_SERVER_SHARE_UNLOCK, [u.serverDomain, u.shareId, u.memberPubHex, u.sealedSha256, String(u.issuedAt)]);
}

/** #9 inbox request — B's inbox key. */
export function shareInboxRequestCanonicalBytes(r) {
  checkHex64("inboxPubHex", r.inboxPubHex);
  if (r.op !== "put" && r.op !== "list" && r.op !== "delete") throw new Error("share-inbox: op must be put, list or delete");
  if (r.op === "list") {
    if (r.entryId !== "") throw new Error("share-inbox: list takes no entryId");
  } else if (typeof r.entryId !== "string" || !HEX32.test(r.entryId)) {
    throw new Error("share-inbox: entryId must be 32 lowercase hex");
  }
  if (r.op === "put") checkHex64("ctSha256", r.ctSha256);
  else if (r.ctSha256 !== "") throw new Error("share-inbox: only put carries ctSha256");
  time("issuedAt", r.issuedAt);
  return join(TAG_SHARE_INBOX, [r.inboxPubHex, r.op, r.entryId, r.ctSha256, String(r.issuedAt)]);
}

/** #10 push — B's member key; one device's push token for start-up approvals. */
export function serverSharePushCanonicalBytes(p) {
  domain(p.serverDomain);
  checkShareId(p.shareId);
  checkHex64("memberPubHex", p.memberPubHex);
  if (p.op !== "put" && p.op !== "delete") throw new Error("server-share: push op must be put or delete");
  if (!SHARE_PUSH_PLATFORMS.includes(p.platform)) throw new Error("server-share: push platform must be apns, fcm or webpush");
  checkHex64("tokenSha256", p.tokenSha256);
  time("issuedAt", p.issuedAt);
  return join(TAG_SERVER_SHARE_PUSH, [p.serverDomain, p.shareId, p.memberPubHex, p.op, p.platform, p.tokenSha256, String(p.issuedAt)]);
}

/** #11 update — B's member key at manage level; the box checks the endorsement. */
export function serverShareUpdateCanonicalBytes(u) {
  domain(u.serverDomain);
  checkShareId(u.shareId);
  checkHex64("memberPubHex", u.memberPubHex);
  if (typeof u.targetCommit !== "string" || !HEX40.test(u.targetCommit)) throw new Error("server-share: targetCommit must be 40 lowercase hex");
  if (typeof u.fromCommit !== "string" || !HEX40.test(u.fromCommit)) throw new Error("server-share: fromCommit must be 40 lowercase hex");
  checkHex64("nonce", u.nonce);
  time("issuedAt", u.issuedAt);
  return join(TAG_SERVER_SHARE_UPDATE, [u.serverDomain, u.shareId, u.memberPubHex, u.targetCommit, u.fromCommit, u.nonce, String(u.issuedAt)]);
}

async function resolveSign(signer, msg) {
  if (signer instanceof Uint8Array) return edSign(signer, msg);
  if (typeof signer === "function") return new Uint8Array(await signer(msg));
  if (signer && typeof signer.signWithIrk === "function") return new Uint8Array(await signer.signWithIrk(signer.umk, msg));
  throw new Error("server-share: signer must be a 32-byte seed, a function, or {umk, signWithIrk}");
}

function signerFor(canon) {
  return async (v, signer) => resolveSign(signer, canon(v));
}

function verifierFor(canon) {
  return async (v, sig, pub) => {
    try {
      return await edVerify(bytesOf(sig, "signature"), canon(v), bytesOf(pub, "public key"));
    } catch {
      return false;
    }
  };
}

export const signServerShareGrant = signerFor(serverShareGrantCanonicalBytes);
export const verifyServerShareGrant = verifierFor(serverShareGrantCanonicalBytes);
export const signServerShareRevoke = signerFor(serverShareRevokeCanonicalBytes);
export const verifyServerShareRevoke = verifierFor(serverShareRevokeCanonicalBytes);
export const signServerShareAccept = signerFor(serverShareAcceptCanonicalBytes);
export const verifyServerShareAccept = verifierFor(serverShareAcceptCanonicalBytes);
export const signServerShareLeave = signerFor(serverShareLeaveCanonicalBytes);
export const verifyServerShareLeave = verifierFor(serverShareLeaveCanonicalBytes);
export const signServerShareSession = signerFor(serverShareSessionCanonicalBytes);
export const verifyServerShareSession = verifierFor(serverShareSessionCanonicalBytes);
export const signServerShareOffer = signerFor(serverShareOfferCanonicalBytes);
export const verifyServerShareOffer = verifierFor(serverShareOfferCanonicalBytes);
export const signServerShareList = signerFor(serverShareListCanonicalBytes);
export const verifyServerShareList = verifierFor(serverShareListCanonicalBytes);
export const signServerShareUnlock = signerFor(serverShareUnlockCanonicalBytes);
export const verifyServerShareUnlock = verifierFor(serverShareUnlockCanonicalBytes);
export const signShareInboxRequest = signerFor(shareInboxRequestCanonicalBytes);
export const verifyShareInboxRequest = verifierFor(shareInboxRequestCanonicalBytes);
export const signServerSharePush = signerFor(serverSharePushCanonicalBytes);
export const verifyServerSharePush = verifierFor(serverSharePushCanonicalBytes);
export const signServerShareUpdate = signerFor(serverShareUpdateCanonicalBytes);
export const verifyServerShareUpdate = verifierFor(serverShareUpdateCanonicalBytes);

// ──────────────────────────────────────────────────────────────────────
// Untrusted JSON → envelope (shape only; the canonical builder re-checks)
// ──────────────────────────────────────────────────────────────────────

function parsedFor(canon, build) {
  return (v) => {
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

const str = (v) => typeof v === "string";

export const parseServerShareGrant = parsedFor(serverShareGrantCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && (o.level === "view" || o.level === "manage") &&
  typeof o.unlockAtBoot === "boolean" && typeof o.seeAppData === "boolean" && str(o.label) && isTime(o.issuedAt)
    ? {
        serverDomain: o.serverDomain,
        shareId: o.shareId,
        memberPubHex: o.memberPubHex,
        level: o.level,
        unlockAtBoot: o.unlockAtBoot,
        seeAppData: o.seeAppData,
        label: o.label,
        issuedAt: o.issuedAt,
      }
    : null,
);

export const parseServerShareRevoke = parsedFor(serverShareRevokeCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && isTime(o.issuedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, issuedAt: o.issuedAt }
    : null,
);

export const parseServerShareAccept = parsedFor(serverShareAcceptCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && isTime(o.acceptedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, memberPubHex: o.memberPubHex, acceptedAt: o.acceptedAt }
    : null,
);

export const parseServerShareLeave = parsedFor(serverShareLeaveCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && isTime(o.issuedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, memberPubHex: o.memberPubHex, issuedAt: o.issuedAt }
    : null,
);

export const parseServerShareSession = parsedFor(serverShareSessionCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && str(o.nonceHex) && isTime(o.issuedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, memberPubHex: o.memberPubHex, nonceHex: o.nonceHex, issuedAt: o.issuedAt }
    : null,
);

export const parseServerShareOffer = parsedFor(serverShareOfferCanonicalBytes, (o) =>
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

export const parseServerShareList = parsedFor(serverShareListCanonicalBytes, (o) =>
  str(o.username) && isTime(o.issuedAt) ? { username: o.username, issuedAt: o.issuedAt } : null,
);

export const parseServerShareUnlock = parsedFor(serverShareUnlockCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && str(o.sealedSha256) && isTime(o.issuedAt)
    ? { serverDomain: o.serverDomain, shareId: o.shareId, memberPubHex: o.memberPubHex, sealedSha256: o.sealedSha256, issuedAt: o.issuedAt }
    : null,
);

export const parseShareInboxRequest = parsedFor(shareInboxRequestCanonicalBytes, (o) =>
  str(o.inboxPubHex) && (o.op === "put" || o.op === "list" || o.op === "delete") && str(o.entryId) &&
  str(o.ctSha256) && isTime(o.issuedAt)
    ? { inboxPubHex: o.inboxPubHex, op: o.op, entryId: o.entryId, ctSha256: o.ctSha256, issuedAt: o.issuedAt }
    : null,
);

export const parseServerSharePush = parsedFor(serverSharePushCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && (o.op === "put" || o.op === "delete") &&
  str(o.platform) && str(o.tokenSha256) && isTime(o.issuedAt)
    ? {
        serverDomain: o.serverDomain,
        shareId: o.shareId,
        memberPubHex: o.memberPubHex,
        op: o.op,
        platform: o.platform,
        tokenSha256: o.tokenSha256,
        issuedAt: o.issuedAt,
      }
    : null,
);

export const parseServerShareUpdate = parsedFor(serverShareUpdateCanonicalBytes, (o) =>
  str(o.serverDomain) && str(o.shareId) && str(o.memberPubHex) && str(o.targetCommit) && str(o.fromCommit) &&
  str(o.nonce) && isTime(o.issuedAt)
    ? {
        serverDomain: o.serverDomain,
        shareId: o.shareId,
        memberPubHex: o.memberPubHex,
        targetCommit: o.targetCommit,
        fromCommit: o.fromCommit,
        nonce: o.nonce,
        issuedAt: o.issuedAt,
      }
    : null,
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Trimmed label, or null (empty, over 64 code points, `|`, control chars). */
export function normalizeShareLabel(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || [...t].length > SHARE_LABEL_MAX) return null;
  if (/[|\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** SHA-256 hex of a string's UTF-8 bytes (the `*Sha256` fields). */
export async function shareSha256Hex(s) {
  return toHex(await sha256(enc.encode(s)));
}

/** 16 random bytes as 32 lowercase hex (share ids, inbox entry ids). */
export function randomShareId() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** 32 random bytes: a fresh link secret `k`. */
export function randomShareSecret() {
  return crypto.getRandomValues(new Uint8Array(32));
}

function legacyFieldGuard(name, value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) throw new Error(`canonical-bytes field "${name}" contains separator '|' at index ${i}`);
    if (c <= 0x1f || c === 0x7f) {
      throw new Error(`canonical-bytes field "${name}" contains control char 0x${c.toString(16)} at index ${i}`);
    }
  }
}

function join(tag, fields) {
  return enc.encode([tag, ...fields].join("|"));
}

function domain(v) {
  nonEmpty("serverDomain", v);
}

function nonEmpty(name, v) {
  if (typeof v !== "string" || v.length === 0) throw new Error(`server-share: empty ${name}`);
  legacyFieldGuard(name, v);
}

function checkShareId(v) {
  if (typeof v !== "string" || !HEX32.test(v)) throw new Error("server-share: shareId must be 32 lowercase hex");
}

function checkHex64(name, v) {
  if (typeof v !== "string" || !HEX64.test(v)) throw new Error(`server-share: ${name} must be 64 lowercase hex`);
}

function checkSecret(s) {
  if (!(s instanceof Uint8Array) || s.length !== 32) throw new Error("server-share: link secret must be 32 bytes");
}

function bool(name, v) {
  if (typeof v !== "boolean") throw new Error(`server-share: ${name} must be a boolean`);
}

function time(name, v) {
  if (!isTime(v)) throw new Error(`server-share: bad ${name}`);
}

function isTime(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function obj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}
