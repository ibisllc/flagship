// Service access gating — capability invites (docs/service-access-gating.md).
//
// Pure webapp mirror of @flagship/protocol's serviceInvite.ts: the
// `flagship/service-invite/v1` tag family for the UMK-anchored, first-bind,
// bearer-link access model. Identity is the STABLE AID
// (keystore.deriveAccountIdFromSeed), NOT the versioned IRK.
//
//   - create        IRK-signed by the author   → .com (carries authorAID)
//   - redeem        AID-signed by the friend    → the box (first redeem binds)
//   - revoke        IRK-signed by the author     → .com (by inviteId)
//   - set-access-mode IRK-signed by the owner    → the box's pinned pipe
//   - visit         AID-signed by the friend     → header on each request
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
export const TAG_INVITE_ID = "flagship/service-invite/id/v1";
export const TAG_BUNDLE = "flagship/service-invite/bundle/v1";
export const TAG_ACCESS_MODE = "flagship/service-access-mode/v1";
export const TAG_ALLOW_REMOVE = "flagship/service-allow-remove/v1";
export const TAG_VISIT = "flagship/service-visit/v1";
export const TAG_KNOCK = "flagship/service-knock/v1";

/** Allowed per-service access modes (canonical literals). */
export const ACCESS_MODES = ["open", "restricted"];

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

/** flagship/service-invite/create/v1 | inviteId | hex(authorAID) | serviceRef | secretHash | encryptedBundle | issuedAt */
export function canonicalCreateBytes(c) {
  validateNoSepCtrl("inviteId", c.inviteId);
  validateNoSepCtrl("serviceRef", c.serviceRef);
  validateNoSepCtrl("secretHash", c.secretHash);
  validateNoSepCtrl("encryptedBundle", c.encryptedBundle);
  return enc.encode(
    [
      TAG_CREATE,
      c.inviteId,
      bytesToHex(c.authorAID),
      c.serviceRef,
      c.secretHash,
      c.encryptedBundle,
      c.issuedAt,
    ].join("|"),
  );
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
 * Build the friend share-link `https://<server>.<user>/invite#<secretHex>`.
 * The secret lives ONLY in the fragment (never sent to .com); the box reads it
 * from `location.hash` and redeems against its own redeem endpoint.
 */
export function buildInviteLink(podBaseUrl, secretHex) {
  const base = podBase(podBaseUrl);
  return `${base}/invite#${secretHex}`;
}

/** Parse `#<secretHex>` from a /invite landing. Returns the 64-hex secret or null. */
export function inviteSecretFromLocation(loc = typeof window !== "undefined" ? window.location : null) {
  if (!loc) return null;
  const path = loc.pathname ?? "";
  if (!/\/invite\/?$/.test(path)) return null;
  const hash = (loc.hash ?? "").replace(/^#/, "");
  // Tolerate `#k=<secret>` (mirrors the legacy share-link shape) or bare hex.
  const m = hash.match(/(?:^|[?&])k=([0-9a-f]{64})/i) || hash.match(/^([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Mint a NEW invite for a service: AEAD the bundle under the household key,
 * IRK-sign the create envelope, POST it to .com, and return the share-link +
 * the inviteId (and the raw secret, so the caller can show the link once).
 *
 * @param {object} args
 * @param {string} args.comBase            .com base URL
 * @param {string} args.username           the author's username (the .com route key)
 * @param {string} args.podBaseUrl         https://<server>.<user>… (for the share-link)
 * @param {Uint8Array} args.authorAID      author's stable AID pub (32 B)
 * @param {Uint8Array} args.authorDevicePub author's current device (IRK) pub — inviteId attribution
 * @param {number} args.counter            monotonic per (account, device)
 * @param {string} args.serviceRef         `<creator>-<slug>`
 * @param {{name:string, photo?:string}} args.bundle
 * @param {Uint8Array} args.householdKey   UMK-derived 32 B
 * @param {Uint8Array} args.umk            the unlocked seed (passed to signWithIrk)
 * @param {(umk,bytes)=>Promise<Uint8Array>} args.signWithIrk
 * @param {{ fetch?, now?, randomBytes? }} [deps]
 */
export async function createInvite(args, deps = {}) {
  const {
    comBase,
    username,
    podBaseUrl,
    authorAID,
    authorDevicePub,
    counter,
    serviceRef,
    bundle,
    householdKey,
    umk,
    signWithIrk,
  } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  const f = deps.fetch || fetch;
  const now = (deps.now || Date.now)();
  const rand = deps.randomBytes || randomBytes;

  const secret = rand(32);
  const secretHash = await serviceInviteSecretHash(secret);
  const inviteId = await serviceInviteId(authorAID, authorDevicePub, counter);
  const encryptedBundle = await sealInviteBundle(bundle, householdKey, inviteId);
  const create = { inviteId, authorAID, serviceRef, secretHash, encryptedBundle, issuedAt: now };
  const sig = await signWithIrk(umk, canonicalCreateBytes(create));

  const body = {
    request: {
      inviteId,
      authorAID: bytesToHex(authorAID),
      serviceRef,
      secretHash,
      encryptedBundle,
      issuedAt: now,
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
    link: buildInviteLink(podBaseUrl, bytesToHex(secret)),
  };
}

/**
 * List the author's invites for a service from .com (metadata only — never the
 * secret). Decrypts each bundle locally with the household key when openable.
 * Returns `[{ inviteId, serviceRef, bundle|null, boundAID, boundAt, createdAt, revokedAt }]`.
 */
export async function listInvites(args, deps = {}) {
  const { comBase, username, authorAID, householdKey, serviceRef } = args;
  const f = deps.fetch || fetch;
  let resp;
  try {
    resp = await f(
      `${comApiBase(comBase)}/api/users/${encodeURIComponent(username)}/service-invites?authorAID=${bytesToHex(authorAID)}`,
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
    });
  }
  return out;
}

/** IRK-sign + POST a revoke (by inviteId) to .com. Drops the friend's access. */
export async function revokeInvite(args, deps = {}) {
  const { comBase, username, inviteId, umk, signWithIrk } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  const f = deps.fetch || fetch;
  const now = (deps.now || Date.now)();
  const sig = await signWithIrk(umk, canonicalRevokeBytes({ inviteId, issuedAt: now }));
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
 * @param {object} args
 * @param {string} args.baseUrl            the box base URL (the /invite origin)
 * @param {string} args.secretHex          the 64-hex secret from the link fragment
 * @param {Uint8Array} args.visitorAID     the friend's stable AID pub (32 B)
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
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`redeem failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  return { ok: true, serviceRef: body.serviceRef, boundAID: body.boundAID, firstBind: body.firstBind === true, body };
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
