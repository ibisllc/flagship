// Service access gating — capability invites (docs/service-access-gating.md).
//
// Pure webapp mirror of @flagship/protocol's serviceInvite.ts: the
// `flagship/service-invite/v1` tag family for the UMK-anchored, first-bind,
// bearer-link access model. Identity is the STABLE AID
// (keystore.deriveAccountIdFromSeed), NOT the versioned IRK.
//
//   - create        AID-signed by the author   → .com (carries authorAID; v2)
//   - redeem        AID-signed by the friend    → the box (first redeem binds)
//   - accept        contact-AID-signed by friend → the author's box (manual tier)
//   - revoke        AID-signed by the author     → .com (by inviteId; v2)
//   - set-access-mode IRK-signed by the owner    → the box's pinned pipe
//   - visit         AID-signed by the friend     → header on each request
//
// v2 (docs §v2 hardening): create + revoke switch from IRK-signing to
// AID-signing — the box (box-as-authority) verifies the relayed create against
// the owner's STABLE AID (the IRK rotates on re-pair/recovery, the AID does
// not); .com dual-accepts AID|IRK during the client transition. The create also
// gained optional group caps (maxRedemptions / expiresAt) appended to the
// canonical bytes only when present (so a v1, no-caps create signs identically).
//
// Plus the value-blind bundle `{ name, photo? }` sealed under the household key
// (keystore.deriveHouseholdKeyFromSeed): flagshipserver.com stores ciphertext
// only and never holds the UMK → it cannot read the friend's name/photo.
//
// Canonical bytes are built here to mirror @flagship/protocol byte-for-byte
// (pinned cross-platform vectors in tests/serviceInvite.test.ts). The box /
// .com verify Ed25519 over the SAME pre-image, so a tampered field simply
// fails verify.

// ──────────────────────────────────────────────────────────────────────
// Canonical-bytes tags — MUST match @flagship/protocol.
// ──────────────────────────────────────────────────────────────────────
export const TAG_CREATE = "flagship/service-invite/create/v1";
export const TAG_REDEEM = "flagship/service-invite/redeem/v1";
export const TAG_REVOKE = "flagship/service-invite/revoke/v1";
export const TAG_ACCEPT = "flagship/service-invite/accept/v1";
export const TAG_INVITE_ID = "flagship/service-invite/id/v1";
export const TAG_BUNDLE = "flagship/service-invite/bundle/v1";
export const TAG_ACCESS_MODE = "flagship/service-access-mode/v1";
export const TAG_ALLOW_REMOVE = "flagship/service-allow-remove/v1";
export const TAG_VISIT = "flagship/service-visit/v1";
export const TAG_KNOCK = "flagship/service-knock/v1";
export const TAG_LIST_QUERY = "flagship/service-invite-list/v1";

/** Allowed per-service access modes (canonical literals). */
export const ACCESS_MODES = ["open", "restricted"];

// v2 per-author redemption identity. Re-exported from the keystore (where the
// WebCrypto Ed25519 seed→keypair derivation lives) so the gating crypto surface
// is complete in one import. `deriveContactAccountId(umkSeed, authorAidPub)` is
// the consumer's PER-AUTHOR pseudonym — unlinkable across authors — used to sign
// redeem / accept / visit for a given author's services (docs §v2 hardening H3).
export { deriveContactAccountIdFromSeed as deriveContactAccountId } from "../keystore.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ──────────────────────────────────────────────────────────────────────
// bytes / hex helpers (self-contained — this lib is imported in Node tests).
// ──────────────────────────────────────────────────────────────────────

export function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// base64url over UTF-8 — used for the acceptance-reply payload. Works in the
// browser (btoa/atob) AND in Node tests (Buffer fallback). No '=' padding on
// encode; decode tolerates its absence (the matcher already strips trailing '=').
function base64urlEncode(str) {
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(str)))
      : Buffer.from(str, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") {
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return bytesToHex(digest);
}

// ──────────────────────────────────────────────────────────────────────
// Field guard — reject '|' (the canonical separator) and control chars in any
// user-controlled string field, mirroring @flagship/protocol's
// validateNoSepCtrl so the JS builds the SAME pre-image (or refuses early).
// ──────────────────────────────────────────────────────────────────────
function validateNoSepCtrl(name, value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) throw err(`field "${name}" contains separator '|' at index ${i}`, "400");
    if (c <= 0x1f || c === 0x7f) {
      throw err(`field "${name}" contains control char 0x${c.toString(16)} at index ${i}`, "400");
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// inviteId = sha256( TAG_INVITE_ID | sha256(authorAID) | sha256(devicePub) | counter ).
// Deterministic 64-hex; mirrors serviceInviteId in @flagship/protocol.
// ──────────────────────────────────────────────────────────────────────
export async function serviceInviteId(authorAidPub, authorDevicePub, counter) {
  if (!Number.isInteger(counter) || counter < 0) {
    throw err("serviceInviteId: counter must be a non-negative integer", "400");
  }
  const inner = enc.encode(
    [
      TAG_INVITE_ID,
      await sha256Hex(authorAidPub),
      await sha256Hex(authorDevicePub),
      String(counter),
    ].join("|"),
  );
  return sha256Hex(inner);
}

/** SHA-256 hex of a 32-byte capability secret — the form .com stores + indexes. */
export async function serviceInviteSecretHash(secret) {
  return sha256Hex(secret);
}

// ──────────────────────────────────────────────────────────────────────
// The value-blind bundle — `{ name, photo? }` sealed under the household key.
//
// AES-256-GCM, random 12-byte nonce, AAD = TAG_BUNDLE|<inviteId>. Wire (hex):
// [nonce: 12 B][ciphertext + GCM tag: var]. WebCrypto appends the 16-byte tag
// to the ciphertext, matching @noble/ciphers' layout in @flagship/protocol —
// so a bundle sealed here opens on the box / a sibling device and vice-versa.
// ──────────────────────────────────────────────────────────────────────

function bundleAad(inviteId) {
  return enc.encode([TAG_BUNDLE, inviteId].join("|"));
}

function bundlePlaintext(bundle) {
  // Object key order MUST match @flagship/protocol (name first, photo only
  // when present) so the GCM-sealed JSON is byte-identical for a given nonce.
  const obj =
    bundle.photo !== undefined && bundle.photo !== null
      ? { name: bundle.name, photo: bundle.photo }
      : { name: bundle.name };
  return enc.encode(JSON.stringify(obj));
}

async function importGcmKey(householdKey) {
  if (!(householdKey instanceof Uint8Array) || householdKey.length !== 32) {
    throw err("household key must be 32 bytes", "400");
  }
  return crypto.subtle.importKey("raw", householdKey, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Seal `{ name, photo? }` under the household key, bound to `inviteId`. Returns
 * lowercase hex of `nonce || ciphertext+tag`. .com stores this verbatim and
 * cannot open it (no UMK → no household key).
 */
export async function sealInviteBundle(bundle, householdKey, inviteId) {
  if (!bundle || typeof bundle.name !== "string") throw err("bundle.name required", "400");
  const key = await importGcmKey(householdKey);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: bundleAad(inviteId) },
      key,
      bundlePlaintext(bundle),
    ),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToHex(out);
}

/**
 * Open a bundle sealed by `sealInviteBundle` (or its @flagship/protocol twin).
 * Throws on a bad key / tampered ciphertext / wrong inviteId (GCM tag + AAD).
 */
export async function openInviteBundle(sealedHex, householdKey, inviteId) {
  const key = await importGcmKey(householdKey);
  const buf = hexToBytes(sealedHex);
  if (buf.length < 12 + 16) throw err("sealed bundle too short", "400");
  const nonce = buf.slice(0, 12);
  const ct = buf.slice(12);
  let plain;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: bundleAad(inviteId) },
        key,
        ct,
      ),
    );
  } catch {
    throw err("bundle decrypt failed (bad key / tampered / wrong invite)", "400");
  }
  const obj = JSON.parse(dec.decode(plain));
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.name !== "string") {
    throw err("malformed bundle", "400");
  }
  const result = { name: obj.name };
  if (typeof obj.photo === "string") result.photo = obj.photo;
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Canonical bytes (pure — mirror @flagship/protocol exactly).
// ──────────────────────────────────────────────────────────────────────

/**
 * flagship/service-invite/create/v1 | inviteId | hex(authorAID) | serviceRef |
 * secretHash | encryptedBundle | issuedAt [| maxN=<n>] [| exp=<ms>]
 *
 * The group caps (`maxRedemptions` → `maxN=`, `expiresAt` → `exp=`) are appended
 * ONLY when present, in that fixed order, byte-identical to @flagship/protocol —
 * so a personal (no-caps) create signs/verifies exactly as the v1 form.
 */
export function canonicalCreateBytes(c) {
  validateNoSepCtrl("inviteId", c.inviteId);
  validateNoSepCtrl("serviceRef", c.serviceRef);
  validateNoSepCtrl("secretHash", c.secretHash);
  validateNoSepCtrl("encryptedBundle", c.encryptedBundle);
  const parts = [
    TAG_CREATE,
    c.inviteId,
    bytesToHex(c.authorAID),
    c.serviceRef,
    c.secretHash,
    c.encryptedBundle,
    c.issuedAt,
  ];
  if (c.maxRedemptions !== undefined) {
    if (!Number.isInteger(c.maxRedemptions) || c.maxRedemptions < 0) {
      throw err("maxRedemptions must be a non-negative integer", "400");
    }
    parts.push(`maxN=${c.maxRedemptions}`);
  }
  if (c.expiresAt !== undefined) {
    if (!Number.isInteger(c.expiresAt) || c.expiresAt < 0) {
      throw err("expiresAt must be a non-negative integer", "400");
    }
    parts.push(`exp=${c.expiresAt}`);
  }
  return enc.encode(parts.join("|"));
}

/** flagship/service-invite/redeem/v1 | secretHash | hex(visitorAID) | redeemedAt */
export function canonicalRedeemBytes(r) {
  validateNoSepCtrl("secretHash", r.secretHash);
  return enc.encode([TAG_REDEEM, r.secretHash, bytesToHex(r.visitorAID), r.redeemedAt].join("|"));
}

/** flagship/service-invite/revoke/v1 | inviteId | issuedAt */
export function canonicalRevokeBytes(r) {
  validateNoSepCtrl("inviteId", r.inviteId);
  return enc.encode([TAG_REVOKE, r.inviteId, r.issuedAt].join("|"));
}

/**
 * flagship/service-invite/accept/v1 | inviteId | serviceRef | hex(contactAID) | acceptedAt
 *
 * The MANUAL-approve acceptance (v2 Phase 3 tier 2): the FRIEND signs this with
 * their PER-AUTHOR contact AID (`deriveContactAccountIdFromSeed`) and replies it
 * to the author, who submits it to their own box to finalize the bind. Mirrors
 * @flagship/protocol's `canonicalAccept` byte-for-byte.
 */
export function canonicalAcceptBytes(a) {
  validateNoSepCtrl("inviteId", a.inviteId);
  validateNoSepCtrl("serviceRef", a.serviceRef);
  return enc.encode([TAG_ACCEPT, a.inviteId, a.serviceRef, bytesToHex(a.contactAID), a.acceptedAt].join("|"));
}

/**
 * Contact-AID-sign an `AcceptServiceInvite`. Byte-exact mirror of
 * @flagship/protocol's `signAcceptServiceInvite`. `signWithContactAccountId` is
 * the injected `(umk, authorAID, bytes) => Promise<Uint8Array>` signer
 * (keystore.js provides it) so the friend signs with the per-author pseudonym.
 *
 * @param {object} args
 * @param {string} args.inviteId
 * @param {string} args.serviceRef
 * @param {Uint8Array} args.contactAID   the friend's per-author contact AID pub (32 B)
 * @param {Uint8Array} args.authorAID    the AUTHOR's stable AID pub (32 B) — selects the contact key
 * @param {number} args.acceptedAt
 * @param {Uint8Array} args.umk
 * @param {(umk, authorAID, bytes) => Promise<Uint8Array>} signWithContactAccountId
 * @returns {Promise<Uint8Array>} the 64-byte Ed25519 signature
 */
export async function signAcceptServiceInvite(args, signWithContactAccountId) {
  const { inviteId, serviceRef, contactAID, authorAID, acceptedAt, umk } = args;
  if (!umk || typeof signWithContactAccountId !== "function") throw err("unlock the webapp first", "400");
  return signWithContactAccountId(umk, authorAID, canonicalAcceptBytes({ inviteId, serviceRef, contactAID, acceptedAt }));
}

/**
 * A random 128-bit invite id (32 bytes → 64-char lowercase hex), the v2
 * replacement for the structured {@link serviceInviteId} (which baked
 * `hash(devicePub)` into the id — a device-fingerprint leak via the listing,
 * v2 §M2). Same uniqueness, zero metadata. Mirrors @flagship/protocol's
 * `randomServiceInviteId`.
 */
export function randomServiceInviteId() {
  return bytesToHex(randomBytes(32));
}

/**
 * flagship/service-invite-list/v1 | username | authorAID | scope | cursor | issuedAt
 *
 * The owner-signed LIST query (v2 §C2 — the v1 list was an open graph dump).
 * `.com` verifies it against the account's registered AID OR IRK. `username`
 * MUST be the LOWERCASED label `.com` keys by (it re-derives the same bytes).
 * Mirrors @flagship/protocol's `canonicalListQuery`.
 */
export function canonicalListQueryBytes(q) {
  validateNoSepCtrl("username", q.username);
  validateNoSepCtrl("authorAID", q.authorAID);
  if (q.scope !== "list" && q.scope !== "revoked-since") {
    throw err("scope must be 'list' or 'revoked-since'", "400");
  }
  return enc.encode([TAG_LIST_QUERY, q.username, q.authorAID, q.scope, q.cursor, q.issuedAt].join("|"));
}

/** flagship/service-access-mode/v1 | serverId | serviceRef | mode | issuedAt */
export function canonicalSetAccessModeBytes(s) {
  validateNoSepCtrl("serverId", s.serverId);
  validateNoSepCtrl("serviceRef", s.serviceRef);
  if (s.mode !== "open" && s.mode !== "restricted") {
    throw err(`service access mode must be 'open' or 'restricted'`, "400");
  }
  return enc.encode([TAG_ACCESS_MODE, s.serverId, s.serviceRef, s.mode, s.issuedAt].join("|"));
}

/** flagship/service-allow-remove/v1 | serverId | serviceRef | aid | issuedAt */
export function canonicalRemoveServiceAllowBytes(s) {
  validateNoSepCtrl("serverId", s.serverId);
  validateNoSepCtrl("serviceRef", s.serviceRef);
  validateNoSepCtrl("aid", s.aid);
  return enc.encode([TAG_ALLOW_REMOVE, s.serverId, s.serviceRef, s.aid, s.issuedAt].join("|"));
}

/** flagship/service-visit/v1 | serverId | serviceRef | hex(visitorAID) | issuedAt */
export function canonicalVisitBytes(v) {
  validateNoSepCtrl("serverId", v.serverId);
  validateNoSepCtrl("serviceRef", v.serviceRef);
  return enc.encode([TAG_VISIT, v.serverId, v.serviceRef, bytesToHex(v.visitorAID), v.issuedAt].join("|"));
}

/** flagship/service-knock/v1 | serverId | serviceRef | pageId | hex(visitorAID) | issuedAt */
export function canonicalKnockBytes(k) {
  validateNoSepCtrl("serverId", k.serverId);
  validateNoSepCtrl("serviceRef", k.serviceRef);
  validateNoSepCtrl("pageId", k.pageId);
  return enc.encode([TAG_KNOCK, k.serverId, k.serviceRef, k.pageId, bytesToHex(k.visitorAID), k.issuedAt].join("|"));
}

// ──────────────────────────────────────────────────────────────────────
// Wire helpers — build + sign + POST. `signWithIrk` / `signWithAccountId` are
// injected `(umk, bytes) => Promise<Uint8Array>` (keystore.js provides them)
// so tests can drive a fixed key.
// ──────────────────────────────────────────────────────────────────────

function comApiBase(comBase) {
  return String(comBase || "").replace(/\/+$/, "");
}

function podBase(baseUrl) {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(b)) throw err("pod baseUrl must be https://", "400");
  return b;
}

/**
 * Build the friend share-link `https://<server>.<user>/invite#<secret>&a=<authorAID>&i=<inviteId>`.
 *
 * Everything rides the FRAGMENT (never sent to .com): the `secret` is the bearer
 * capability — the BARE leading token (canonical cross-client format, no `k=`
 * prefix); the author's AID (`a`) lets the friend derive their PER-AUTHOR contact
 * identity (`deriveContactAccountId`) so they redeem under a pseudonym unlinkable
 * across authors; the inviteId (`i`) lets the friend's app emit the
 * manual-approve acceptance. `authorAID`/`inviteId` are OPTIONAL — omitting them
 * yields the v1 bare `#<secret>` form (the friend then redeems under the global
 * AID, no manual loop).
 *
 * @param {string} podBaseUrl
 * @param {string} secretHex             64-hex capability secret
 * @param {{ authorAID?: Uint8Array|string, inviteId?: string }} [ctx]
 */
export function buildInviteLink(podBaseUrl, secretHex, ctx = {}) {
  const base = podBase(podBaseUrl);
  const sec = String(secretHex || "").toLowerCase();
  const authorHex =
    ctx.authorAID instanceof Uint8Array ? bytesToHex(ctx.authorAID) : (ctx.authorAID || "");
  if (!authorHex && !ctx.inviteId) {
    // v1 bare form — keep it exactly as before.
    return `${base}/invite#${sec}`;
  }
  // Canonical v2: BARE leading secret, then &a=/&i= (matches iOS + Android).
  const parts = [sec];
  if (authorHex) parts.push(`a=${authorHex.toLowerCase()}`);
  if (ctx.inviteId) parts.push(`i=${String(ctx.inviteId).toLowerCase()}`);
  return `${base}/invite#${parts.join("&")}`;
}

/** Parse `#<secretHex>` from a /invite landing. Returns the 64-hex secret or null. */
export function inviteSecretFromLocation(loc = typeof window !== "undefined" ? window.location : null) {
  const ctx = inviteContextFromLocation(loc);
  return ctx ? ctx.secret : null;
}

/**
 * Parse the FULL invite context from a /invite landing: `{ secret, authorAID,
 * inviteId }`. `authorAID`/`inviteId` are present only for v2 links (the
 * canonical `#<secret>&a=…&i=…` shape); a v1 bare `#<secret>` yields them null.
 * Returns null when the path isn't /invite or there is no valid 64-hex secret.
 *
 * The secret is matched as the CANONICAL bare leading token (`#<secret>` or
 * `#<secret>&…`), and — for backward-compat — also the legacy `k=<secret>` form
 * (old webapp-minted links + the iOS/Android custom-scheme `flagship://invite?k=`
 * hand-off, whose fragment-less query maps through the same parser).
 */
export function inviteContextFromLocation(loc = typeof window !== "undefined" ? window.location : null) {
  if (!loc) return null;
  const path = loc.pathname ?? "";
  if (!/\/invite\/?$/.test(path)) return null;
  const hash = (loc.hash ?? "").replace(/^#/, "");
  // Canonical bare leading secret (`<secret>` or `<secret>&…`), or legacy `k=<secret>`.
  const m =
    hash.match(/^([0-9a-f]{64})(?:&|$)/i) || hash.match(/(?:^|[?&])k=([0-9a-f]{64})/i);
  if (!m) return null;
  const secret = m[1].toLowerCase();
  const a = hash.match(/(?:^|[?&])a=([0-9a-f]{64})/i);
  const i = hash.match(/(?:^|[?&])i=([0-9a-f]{64})/i);
  return {
    secret,
    authorAID: a ? a[1].toLowerCase() : null,
    inviteId: i ? i[1].toLowerCase() : null,
  };
}

/**
 * Mint a NEW invite for a service: AEAD the bundle under the household key,
 * AID-sign the create envelope (v2 box-as-authority — the box verifies it
 * against the owner's STABLE AID), POST it to .com, and return the share-link +
 * the inviteId (and the raw secret, so the caller can show the link once).
 *
 * The TIER is expressed by the caller:
 *   - personal auto-approve  — no caps, `approvalMode` "auto"/omitted (first-bind).
 *   - personal manual-approve — `approvalMode:"manual"` (the friend's redeem is
 *     held {pending}; the author finalizes via the accept loop). Single-use.
 *   - group / multi-use — `maxRedemptions` (0 = unlimited) + optional `expiresAt`,
 *     always auto-approve. `maxRedemptions`/`expiresAt` are SIGNED (in the
 *     canonical bytes); `approvalMode` is a .com-side policy field (not signed).
 *
 * @param {object} args
 * @param {string} args.comBase            .com base URL
 * @param {string} args.username           the author's username (the .com route key)
 * @param {string} args.podBaseUrl         https://<server>.<user>… (for the share-link)
 * @param {Uint8Array} args.authorAID      author's stable AID pub (32 B)
 * @param {string} [args.inviteId]         explicit 64-hex id; else a random 128-bit id (v2 §M2)
 * @param {string} args.serviceRef         `<creator>-<slug>`
 * @param {{name:string, photo?:string}} args.bundle
 * @param {Uint8Array} args.householdKey   UMK-derived 32 B
 * @param {"auto"|"manual"} [args.approvalMode]   .com redeem policy (default auto)
 * @param {number} [args.maxRedemptions]   group cap, 0 = unlimited (SIGNED)
 * @param {number} [args.expiresAt]        optional expiry epoch-ms (SIGNED)
 * @param {Uint8Array} args.umk            the unlocked seed (passed to signWithAccountId)
 * @param {(umk,bytes)=>Promise<Uint8Array>} args.signWithAccountId   the AID signer
 * @param {{ fetch?, now?, randomBytes? }} [deps]
 */
export async function createInvite(args, deps = {}) {
  const {
    comBase,
    username,
    podBaseUrl,
    authorAID,
    serviceRef,
    bundle,
    householdKey,
    approvalMode,
    maxRedemptions,
    expiresAt,
    umk,
    signWithAccountId,
  } = args;
  if (!umk || typeof signWithAccountId !== "function") throw err("unlock the webapp first", "400");
  if (approvalMode !== undefined && approvalMode !== "auto" && approvalMode !== "manual") {
    throw err("approvalMode must be 'auto' or 'manual'", "400");
  }
  const f = deps.fetch || fetch;
  const now = (deps.now || Date.now)();
  const rand = deps.randomBytes || randomBytes;

  const secret = rand(32);
  const secretHash = await serviceInviteSecretHash(secret);
  const inviteId =
    typeof args.inviteId === "string" && /^[0-9a-f]{64}$/i.test(args.inviteId)
      ? args.inviteId.toLowerCase()
      : randomServiceInviteId();
  const encryptedBundle = await sealInviteBundle(bundle, householdKey, inviteId);
  const create = {
    inviteId,
    authorAID,
    serviceRef,
    secretHash,
    encryptedBundle,
    issuedAt: now,
    ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  const sig = await signWithAccountId(umk, canonicalCreateBytes(create));

  const body = {
    request: {
      inviteId,
      authorAID: bytesToHex(authorAID),
      serviceRef,
      secretHash,
      encryptedBundle,
      issuedAt: now,
      ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(approvalMode !== undefined ? { approvalMode } : {}),
    },
    signature: bytesToHex(sig),
  };
  let resp;
  try {
    resp = await f(`${comApiBase(comBase)}/api/users/${encodeURIComponent(username)}/service-invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw err("could not reach flagshipserver.com", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`create failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  await resp.json().catch(() => ({}));
  return {
    inviteId,
    secretHex: bytesToHex(secret),
    // The v2 link carries the author AID + inviteId in the fragment so the friend
    // can redeem under their per-author contact identity + (manual) reply an
    // acceptance. (Off-`.com`: fragments aren't sent in requests.)
    link: buildInviteLink(podBaseUrl, bytesToHex(secret), { authorAID, inviteId }),
    // The signed create — the AUTHOR retains this so it can FINALIZE a manual
    // acceptance later (the box verifies the owner's authority from it). The
    // wire shape mirrors what `.com` relays + `/api/service-access/accept` expects.
    create: {
      inviteId,
      authorAID: bytesToHex(authorAID),
      serviceRef,
      secretHash,
      encryptedBundle,
      issuedAt: now,
      ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    createSig: bytesToHex(sig),
    approvalMode: approvalMode ?? "auto",
  };
}

/**
 * List the author's invites for a service from .com (metadata only — never the
 * secret). The query is OWNER-AID-SIGNED (v2 §C2 — the v1 unsigned list was an
 * open graph dump); `.com` verifies it against the account's registered AID|IRK.
 * Decrypts each bundle locally with the household key when openable. Returns
 * `[{ inviteId, serviceRef, bundle|null, boundAID, …, maxRedemptions, redemptions }]`.
 *
 * @param {object} args
 * @param {string} args.comBase
 * @param {string} args.username           the author's username (lowercased for signing)
 * @param {Uint8Array} args.authorAID
 * @param {Uint8Array} args.householdKey
 * @param {string} [args.serviceRef]       filter to one service
 * @param {Uint8Array} args.umk
 * @param {(umk,bytes)=>Promise<Uint8Array>} args.signWithAccountId   the AID signer
 * @param {{ fetch?, now? }} [deps]
 */
export async function listInvites(args, deps = {}) {
  const { comBase, username, authorAID, householdKey, serviceRef, umk, signWithAccountId } = args;
  if (!umk || typeof signWithAccountId !== "function") throw err("unlock the webapp first", "400");
  const f = deps.fetch || fetch;
  const now = (deps.now || Date.now)();
  const authorHex = bytesToHex(authorAID);
  // The canonical bytes use the LOWERCASED username + authorAID `.com` keys by.
  const query = { username: String(username).toLowerCase(), authorAID: authorHex, scope: "list", cursor: 0, issuedAt: now };
  const sig = await signWithAccountId(umk, canonicalListQueryBytes(query));
  const qs = new URLSearchParams({
    authorAID: authorHex,
    scope: "list",
    cursor: "0",
    issuedAt: String(now),
    sig: bytesToHex(sig),
  });
  let resp;
  try {
    resp = await f(
      `${comApiBase(comBase)}/api/users/${encodeURIComponent(username)}/service-invites?${qs.toString()}`,
      { cache: "no-store" },
    );
  } catch {
    throw err("could not reach flagshipserver.com", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`list failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const j = await resp.json().catch(() => ({ invites: [] }));
  const rows = Array.isArray(j.invites) ? j.invites : [];
  const out = [];
  for (const i of rows) {
    if (serviceRef && i.serviceRef !== serviceRef) continue;
    let bundle = null;
    if (householdKey && typeof i.encryptedBundle === "string") {
      try {
        bundle = await openInviteBundle(i.encryptedBundle, householdKey, i.inviteId);
      } catch {
        bundle = null; // ciphertext from another account / corrupt — show "unknown"
      }
    }
    out.push({
      inviteId: i.inviteId,
      serviceRef: i.serviceRef,
      bundle,
      boundAID: i.boundAID ?? null,
      boundAt: i.boundAt ?? null,
      createdAt: i.createdAt ?? null,
      revokedAt: i.revokedAt ?? null,
      // v2 group/multi-use fields (absent ⇒ a personal single-bind invite).
      maxRedemptions: typeof i.maxRedemptions === "number" ? i.maxRedemptions : null,
      expiresAt: typeof i.expiresAt === "number" ? i.expiresAt : null,
      redemptions: typeof i.redemptions === "number" ? i.redemptions : null,
      boundAIDs: Array.isArray(i.boundAIDs) ? i.boundAIDs : null,
      approvalMode: i.approvalMode === "manual" || i.approvalMode === "auto" ? i.approvalMode : null,
    });
  }
  return out;
}

/**
 * AID-sign + POST a revoke (by inviteId) to .com (v2 box-as-authority — the
 * revoke is verified against the owner's STABLE AID, the same key as create).
 * For a GROUP invite this drops the WHOLE set; the box's revocation poller +
 * the per-AID box prune are what enforce it on the serving path.
 */
export async function revokeInvite(args, deps = {}) {
  const { comBase, username, inviteId, umk, signWithAccountId } = args;
  if (!umk || typeof signWithAccountId !== "function") throw err("unlock the webapp first", "400");
  const f = deps.fetch || fetch;
  const now = (deps.now || Date.now)();
  const sig = await signWithAccountId(umk, canonicalRevokeBytes({ inviteId, issuedAt: now }));
  let resp;
  try {
    resp = await f(
      `${comApiBase(comBase)}/api/users/${encodeURIComponent(username)}/service-invites/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: { inviteId, issuedAt: now }, signature: bytesToHex(sig) }),
      },
    );
  } catch {
    throw err("could not reach flagshipserver.com", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`revoke failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  return resp.json().catch(() => ({ revoked: true }));
}

/**
 * IRK-sign + POST a per-service access-mode change to the box's pinned pipe
 * (POST <pod>/api/service-access). `open` lets anyone; `restricted` gates the
 * service to its bound AID allow-list. Mirrors lib/frontPage.js's envelope.
 */
export async function setServiceAccessMode(args, deps = {}) {
  const { baseUrl, serviceRef, mode, umk, signWithIrk } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  if (mode !== "open" && mode !== "restricted") throw err(`invalid access mode: ${String(mode)}`, "400");
  const base = podBase(baseUrl);
  const serverId = new URL(base).host;
  const now = (deps.now || Date.now)();
  const f = deps.fetch || fetch;
  const order = { serverId, serviceRef, mode, issuedAt: now };
  const sig = await signWithIrk(umk, canonicalSetAccessModeBytes(order));
  let resp;
  try {
    resp = await f(`${base}/api/service-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: order, signature: bytesToHex(sig) }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`request failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  return { ok: true, serverId, serviceRef, mode, body };
}

/**
 * OWNER-IRK-sign + POST a single-AID prune to the box's pinned pipe
 * (POST <pod>/api/service-access/allow-remove). The `.com` invite revoke records
 * the revocation but never reaches the box (the box's allow-list is add-only),
 * so the admin fires THIS alongside it — it's what actually drops the friend's
 * access (the box re-checks the allow-list per request, so a live browser cookie
 * bound to that AID dies too). `aid` = the friend's bound AID (lowercase hex).
 * Mirrors setServiceAccessMode's envelope.
 */
export async function removeServiceAllow(args, deps = {}) {
  const { baseUrl, serviceRef, aid, umk, signWithIrk } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  if (typeof aid !== "string" || !/^[0-9a-f]{64}$/i.test(aid)) throw err("invalid AID", "400");
  const base = podBase(baseUrl);
  const serverId = new URL(base).host;
  const aidLower = aid.toLowerCase();
  const now = (deps.now || Date.now)();
  const f = deps.fetch || fetch;
  const order = { serverId, serviceRef, aid: aidLower, issuedAt: now };
  const sig = await signWithIrk(umk, canonicalRemoveServiceAllowBytes(order));
  let resp;
  try {
    resp = await f(`${base}/api/service-access/allow-remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: order, signature: bytesToHex(sig) }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`request failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  return { ok: true, serverId, serviceRef, aid: aidLower, removed: body.removed === true, body };
}

/**
 * Friend redeem: AID-sign the redeem over { secretHash, visitorAID, redeemedAt }
 * and POST the raw secret to the BOX's redeem endpoint (same origin as /invite).
 * The box re-verifies the AID sig, delegates the first-bind decision to .com,
 * then adds the bound AID to the service allow-list.
 *
 * `visitorAID` should be the friend's PER-AUTHOR contact AID
 * (`deriveContactAccountId(friendUMK, authorAID)`) for a v2 invite (the link
 * carries the author's AID), so redemptions are unlinkable across authors; the
 * caller supplies the matching contact-bound `signWithAccountId` closure.
 *
 * Returns `{ approvalMode, pending, serviceRef, boundAID, firstBind, body }`:
 *  - AUTO-approve → `{ approvalMode:"auto", pending:false, boundAID, firstBind }`.
 *  - MANUAL-approve → `{ approvalMode:"manual", pending:true, serviceRef }` (NO
 *    bind yet — the friend's app emits an acceptance and the AUTHOR finalizes).
 *
 * @param {object} args
 * @param {string} args.baseUrl            the box base URL (the /invite origin)
 * @param {string} args.secretHex          the 64-hex secret from the link fragment
 * @param {Uint8Array} args.visitorAID     the friend's contact AID pub (32 B)
 * @param {Uint8Array} args.umk
 * @param {(umk,bytes)=>Promise<Uint8Array>} args.signWithAccountId
 * @param {{ fetch?, now? }} [deps]
 */
export async function redeemInvite(args, deps = {}) {
  const { baseUrl, secretHex, visitorAID, umk, signWithAccountId } = args;
  if (!umk || typeof signWithAccountId !== "function") throw err("unlock the webapp first", "400");
  if (typeof secretHex !== "string" || !/^[0-9a-f]{64}$/i.test(secretHex)) {
    throw err("invalid invite secret", "400");
  }
  const base = podBase(baseUrl);
  const now = (deps.now || Date.now)();
  const f = deps.fetch || fetch;
  const secretHash = await serviceInviteSecretHash(hexToBytes(secretHex));
  const redeem = { secretHash, visitorAID, redeemedAt: now };
  const sig = await signWithAccountId(umk, canonicalRedeemBytes(redeem));
  // Send the raw secret (the box re-derives the hash) + the AID sig.
  let resp;
  try {
    resp = await f(`${base}/api/service-invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: secretHex.toLowerCase(),
        visitorAID: bytesToHex(visitorAID),
        aidSig: bytesToHex(sig),
        redeemedAt: now,
      }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (resp.status === 404) throw err("This invite link is unknown or was withdrawn.", "404");
  if (resp.status === 409) throw err("This invite is already linked to another account.", "409");
  if (resp.status === 403) throw err("This invite has been revoked.", "403");
  if (resp.status === 410) throw err("This invite has expired or reached its limit.", "410");
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`redeem failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  const pending = body.pending === true || body.approvalMode === "manual";
  return {
    ok: true,
    pending,
    approvalMode: pending ? "manual" : "auto",
    serviceRef: body.serviceRef,
    boundAID: body.boundAID,
    firstBind: body.firstBind === true,
    body,
  };
}

// ──────────────────────────────────────────────────────────────────────
// MANUAL-approve out-of-band acceptance loop (v2 Phase 3 tier 2).
//
// FRIEND side: after a {pending} redeem the friend's app derives its PER-AUTHOR
// contact AID, signs an `AcceptServiceInvite` with it, and replies the encoded
// acceptance back to the author over the SAME private channel (a link/code/QR,
// symmetric to the invite). AUTHOR side: the author opens that reply, pairs it
// with the signed create it RETAINED at create-time, and submits both to its OWN
// box's `/api/service-access/accept`, which verifies the owner's create AND the
// friend's signature, then binds the contact AID. The author finalizes, so a
// link-thief who never reached the author↔friend channel can't get bound.
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// CANONICAL acceptance-reply form (cross-client): the friend's app emits, and
// the AUTHOR opens, a deep-link
//
//   flagship://invite-accept?server=&iid=&ref=&aid=&sig=&at=
//
// carrying ONLY `{accept, acceptSig}` — the friend's contact-AID-signed
// `AcceptServiceInvite` (inviteId/serviceRef/contactAID/acceptedAt + sig) + the
// box host. It carries NO create: the AUTHOR's box now FETCHES the owner's signed
// create from `.com` by inviteId at finalize, so the reply needn't ship it. Same
// shape on webapp/iOS/Android (a real deeplink the native camera / share / QR can
// open; the webapp can't own the scheme, so it parses a pasted/typed URL). The
// friend's USERNAME never appears — only the box-derived contact pseudonym.
// ──────────────────────────────────────────────────────────────────────

/**
 * FRIEND: build the canonical acceptance reply deep-link.
 * @param {string} serverDomain  the AUTHOR's box host (the finalize target)
 * @param {object} accept        { inviteId, serviceRef, contactAID(hex), acceptedAt }
 * @param {string} acceptSig     128-hex contact-AID signature
 */
export function buildAcceptReply(serverDomain, accept, acceptSig) {
  const host = String(serverDomain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) throw err("missing the server host", "400");
  if (!accept || typeof accept.inviteId !== "string" || typeof accept.serviceRef !== "string") {
    throw err("malformed acceptance", "400");
  }
  if (typeof accept.contactAID !== "string" || !/^[0-9a-f]{64}$/i.test(accept.contactAID)) {
    throw err("malformed acceptance contact AID", "400");
  }
  if (typeof acceptSig !== "string" || !/^[0-9a-f]{128}$/i.test(acceptSig)) {
    throw err("malformed acceptance signature", "400");
  }
  const q = new URLSearchParams({
    server: host,
    iid: accept.inviteId.toLowerCase(),
    ref: accept.serviceRef,
    aid: accept.contactAID.toLowerCase(),
    sig: acceptSig.toLowerCase(),
    at: String(accept.acceptedAt),
  });
  return `flagship://invite-accept?${q.toString()}`;
}

/**
 * AUTHOR: parse a `flagship://invite-accept?…` reply (tolerating pasted
 * whitespace). Returns `{ serverDomain, accept, acceptSig }` or null when it
 * isn't a valid acceptance reply. (`accept.contactAID` stays hex; the caller
 * binds it.) Back-compat: also accepts the legacy `flagship-accept:<base64url>`
 * form (which had no server host — the caller supplies the box origin then).
 */
export function parseAcceptReply(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  // Legacy base64url form (no server host).
  const legacy = s.match(/^flagship-accept:([A-Za-z0-9_-]+)=*$/);
  if (legacy) {
    let obj;
    try {
      obj = JSON.parse(dec.decode(base64urlDecode(legacy[1])));
    } catch {
      return null;
    }
    const a = obj && obj.accept;
    if (!validAcceptShape(a, obj && obj.acceptSig)) return null;
    return {
      serverDomain: null,
      accept: normalizeAccept(a),
      acceptSig: obj.acceptSig.toLowerCase(),
    };
  }
  // Canonical deep-link form.
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "flagship:") return null;
  // `new URL("flagship://invite-accept?…")` puts `invite-accept` in host.
  const kind = (url.host || url.pathname.replace(/^\/+/, "")).toLowerCase();
  if (kind !== "invite-accept") return null;
  const p = url.searchParams;
  const accept = {
    inviteId: p.get("iid"),
    serviceRef: p.get("ref"),
    contactAID: p.get("aid"),
    acceptedAt: Number(p.get("at")),
  };
  if (!validAcceptShape(accept, p.get("sig"))) return null;
  const host = String(p.get("server") || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    serverDomain: host || null,
    accept: normalizeAccept(accept),
    acceptSig: String(p.get("sig")).toLowerCase(),
  };
}

/** Validate the `{inviteId, serviceRef, contactAID, acceptedAt}` + sig shape. */
function validAcceptShape(a, sig) {
  return !!(
    a &&
    typeof a.inviteId === "string" &&
    /^[0-9a-f]{64}$/i.test(a.inviteId) &&
    typeof a.serviceRef === "string" &&
    a.serviceRef.length > 0 &&
    typeof a.contactAID === "string" &&
    /^[0-9a-f]{64}$/i.test(a.contactAID) &&
    Number.isFinite(a.acceptedAt) &&
    typeof sig === "string" &&
    /^[0-9a-f]{128}$/i.test(sig)
  );
}

function normalizeAccept(a) {
  return {
    inviteId: a.inviteId.toLowerCase(),
    serviceRef: a.serviceRef,
    contactAID: a.contactAID.toLowerCase(),
    acceptedAt: a.acceptedAt,
  };
}

/**
 * AUTHOR: finalize a manual-approve acceptance. POST ONLY `{accept, acceptSig}`
 * to the box's `/api/service-access/accept`; the box FETCHES the owner's signed
 * create from `.com` by inviteId (STK-signed) and re-verifies the owner authority
 * itself, then the friend's contact-AID signature, then binds — so the author can
 * finalize from ANY of their devices (no local create cache). No phone/IRK
 * signature here — the friend's signature already rides in the body.
 *
 * @param {object} args
 * @param {string} args.baseUrl           the AUTHOR's box base URL
 * @param {object} args.accept            { inviteId, serviceRef, contactAID(hex), acceptedAt }
 * @param {string} args.acceptSig         128-hex friend contact-AID signature
 * @param {{ fetch? }} [deps]
 * @returns {Promise<{bound:boolean, serviceRef:string, boundAID:string}>}
 */
export async function submitAccept(args, deps = {}) {
  const { baseUrl, accept, acceptSig } = args;
  if (!accept || typeof accept.inviteId !== "string") throw err("malformed acceptance", "400");
  if (typeof acceptSig !== "string" || !/^[0-9a-f]{128}$/i.test(acceptSig)) {
    throw err("malformed acceptance signature", "400");
  }
  const base = podBase(baseUrl);
  const f = deps.fetch || fetch;
  let resp;
  try {
    resp = await f(`${base}/api/service-access/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accept: {
          inviteId: accept.inviteId.toLowerCase(),
          serviceRef: accept.serviceRef,
          contactAID: String(accept.contactAID).toLowerCase(),
          acceptedAt: accept.acceptedAt,
        },
        acceptSig: acceptSig.toLowerCase(),
      }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (resp.status === 403) throw err("That acceptance didn't verify. Ask them to send a fresh one.", "403");
  if (resp.status === 409) throw err("That invite isn't for a service on this server.", "409");
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`accept failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  if (body.bound !== true) throw err("Couldn't finalize that acceptance.", "500");
  return { bound: true, serviceRef: body.serviceRef, boundAID: body.boundAID };
}

/**
 * Build the `x-flagship-visit` header value a restricted-service request
 * carries: base64(JSON({ proof, sig })). AID-signed. The box checks the sig +
 * that the AID is allow-listed, with a short replay window on issuedAt.
 */
export async function buildVisitHeader(args, deps = {}) {
  const { serverId, serviceRef, visitorAID, umk, signWithAccountId } = args;
  if (!umk || typeof signWithAccountId !== "function") throw err("unlock the webapp first", "400");
  const now = (deps.now || Date.now)();
  const proof = { serverId, serviceRef, visitorAID, issuedAt: now };
  const sig = await signWithAccountId(umk, canonicalVisitBytes(proof));
  const json = JSON.stringify({
    proof: { serverId, serviceRef, visitorAID: bytesToHex(visitorAID), issuedAt: now },
    sig: bytesToHex(sig),
  });
  // btoa over the UTF-8 bytes (serverId/serviceRef are ASCII DNS-ish).
  const b64 = typeof btoa === "function" ? btoa(json) : Buffer.from(json, "utf8").toString("base64");
  return b64;
}

// ──────────────────────────────────────────────────────────────────────
// Web-experience gating — QR-login knock authorization
// (docs/service-access-gating.md, "Web-experience gating").
//
// A plain browser can't AID-sign the visit header, so a restricted service's
// website is unreachable from one. The box serves a "knock page" carrying a
// deeplink (`flagship://access?server=&svc=&ref=&page=`); a Flagship client
// AUTHORIZES it by AID-signing `{serverId, serviceRef, pageId, visitorAID,
// issuedAt}` and POSTing it to the box. The pageId is IN the signature, so a
// visit proof can never be replayed to authorize a different page.
//
// The webapp is a BROWSER (it can't own the `flagship://` scheme), so its role
// is the PASTE path: the user copies the deeplink from the knock page's "Get
// link" affordance and pastes it into Settings → "Process URL".
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse a `flagship://access?server=&svc=&ref=&page=` deeplink. Tolerates
 * surrounding whitespace (it's pasted) and percent-encoded params. Returns
 * `{ serverId, svc, serviceRef, pageId }` or null when it isn't an access link
 * or is missing a required field.
 *
 * @param {string} raw  the pasted link
 * @returns {{serverId:string, svc:string, serviceRef:string, pageId:string}|null}
 */
export function parseAccessDeepLink(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  // Scheme check (case-insensitive) before handing to URL — `flagship:` is a
  // non-special scheme, so URLSearchParams over the query is the reliable path.
  if (!/^flagship:\/\/access\b/i.test(s)) return null;
  const q = s.indexOf("?");
  if (q < 0) return null;
  let params;
  try {
    params = new URLSearchParams(s.slice(q + 1));
  } catch {
    return null;
  }
  const serverId = (params.get("server") || "").trim();
  const svc = (params.get("svc") || "").trim();
  const serviceRef = (params.get("ref") || "").trim();
  const pageId = (params.get("page") || "").trim();
  if (!serverId || !serviceRef || !pageId) return null;
  // The signed fields can't contain the canonical separator / control chars.
  try {
    validateNoSepCtrl("serverId", serverId);
    validateNoSepCtrl("serviceRef", serviceRef);
    validateNoSepCtrl("pageId", pageId);
  } catch {
    return null;
  }
  return { serverId, svc, serviceRef, pageId };
}

/** The tier-1 canonical URL of the service behind a knock — `https://<svc>.<server>`. */
export function serviceUrlFromDeepLink(parsed) {
  if (!parsed || !parsed.svc || !parsed.serverId) return null;
  return `https://${parsed.svc}.${parsed.serverId}`;
}

/**
 * AID-sign a `KnockAuthorization`. Byte-exact mirror of @flagship/protocol's
 * `signKnockAuthorization` — the box verifies Ed25519 over the SAME pre-image
 * (`canonicalKnockBytes`). `signWithAccountId` is the injected
 * `(umk, bytes) => Promise<Uint8Array>` AID signer (keystore.js provides it).
 *
 * @param {object} args
 * @param {string} args.serverId
 * @param {string} args.serviceRef
 * @param {string} args.pageId
 * @param {Uint8Array} args.visitorAID   the in-page account AID pub (32 B)
 * @param {number} args.issuedAt
 * @param {Uint8Array} args.umk
 * @param {(umk,bytes)=>Promise<Uint8Array>} signWithAccountId
 * @returns {Promise<Uint8Array>} the 64-byte Ed25519 signature
 */
export async function signKnockAuthorization(args, signWithAccountId) {
  const { serverId, serviceRef, pageId, visitorAID, issuedAt, umk } = args;
  if (!umk || typeof signWithAccountId !== "function") throw err("unlock the webapp first", "400");
  return signWithAccountId(umk, canonicalKnockBytes({ serverId, serviceRef, pageId, visitorAID, issuedAt }));
}

/**
 * Authorize a browser's knock: AID-sign the `KnockAuthorization` and POST it to
 * the box's `…/knock/authorize`. The box re-verifies sig + allow-list and mints
 * a browser session; the secretId comes back to US (the phone/webapp), never to
 * the knocking browser. Maps the documented status codes to clear errors.
 *
 * @param {object} args
 * @param {string} args.serverId         the box fqdn (the authorize target host)
 * @param {string} args.serviceRef
 * @param {string} args.pageId
 * @param {string} [args.svc]            the url-label (carried through for the SecuredSession url)
 * @param {Uint8Array} args.visitorAID
 * @param {Uint8Array} args.umk
 * @param {(umk,bytes)=>Promise<Uint8Array>} args.signWithAccountId
 * @param {{ fetch?, now? }} [deps]
 * @returns {Promise<{secretId:string, serviceRef:string, browserAgent:string, startedAt:number, expiresAt:number, serverId:string, svc?:string}>}
 */
export async function authorizeKnock(args, deps = {}) {
  const { serverId, serviceRef, pageId, svc, visitorAID, umk, signWithAccountId } = args;
  if (!umk || typeof signWithAccountId !== "function") throw err("unlock the webapp first", "400");
  const base = podBase(`https://${serverId}`);
  const now = (deps.now || Date.now)();
  const f = deps.fetch || fetch;
  const authorization = { serverId, serviceRef, pageId, visitorAID, issuedAt: now };
  const sig = await signWithAccountId(umk, canonicalKnockBytes(authorization));
  let resp;
  try {
    resp = await f(`${base}/api/service-access/knock/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorization: {
          serverId,
          serviceRef,
          pageId,
          visitorAID: bytesToHex(visitorAID),
          issuedAt: now,
        },
        sig: bytesToHex(sig),
      }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (resp.status === 401) throw err("You don't have access to this service.", "401");
  if (resp.status === 403) throw err("Couldn't authorize — try refreshing the page.", "403");
  if (resp.status === 404) throw err("The page expired — refresh it and try again.", "404");
  if (resp.status === 409) throw err("That page was already authorized.", "409");
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`authorize failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  if (!body || body.authorized !== true || typeof body.secretId !== "string") {
    throw err("Couldn't authorize — try refreshing the page.", "403");
  }
  return {
    secretId: body.secretId,
    serviceRef: body.serviceRef ?? serviceRef,
    browserAgent: typeof body.browserAgent === "string" ? body.browserAgent : "",
    startedAt: typeof body.startedAt === "number" ? body.startedAt : now,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : now,
    serverId,
    svc,
  };
}

/**
 * Query a held session's liveness. secretId rides the BODY (never the URL — so
 * it can't land in access logs). The box rate-limits ~1/min/secretId (429), and
 * an UNKNOWN secretId returns `offline` (no enumeration oracle). Maps 429 to a
 * dedicated code so the caller can keep showing the last-known status.
 *
 * @returns {Promise<"online"|"offline">}
 */
export async function sessionStatus(args, deps = {}) {
  const { serverId, secretId } = args;
  if (typeof secretId !== "string" || !/^[0-9a-f]{64}$/i.test(secretId)) throw err("invalid session", "400");
  const base = podBase(`https://${serverId}`);
  const f = deps.fetch || fetch;
  let resp;
  try {
    resp = await f(`${base}/api/service-access/session/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secretId: secretId.toLowerCase() }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (resp.status === 429) throw err("Checked too recently — try again in a moment.", "429");
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`status failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  return body.status === "online" ? "online" : "offline";
}

/**
 * Close a held session — kills the browser's cookie. secretId rides the BODY.
 * Idempotent + oracle-free on the box (always 200 {closed:true}).
 *
 * @returns {Promise<{closed:boolean}>}
 */
export async function closeSession(args, deps = {}) {
  const { serverId, secretId } = args;
  if (typeof secretId !== "string" || !/^[0-9a-f]{64}$/i.test(secretId)) throw err("invalid session", "400");
  const base = podBase(`https://${serverId}`);
  const f = deps.fetch || fetch;
  let resp;
  try {
    resp = await f(`${base}/api/service-access/session/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secretId: secretId.toLowerCase() }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`close failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  return resp.json().catch(() => ({ closed: true }));
}
