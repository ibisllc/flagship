// Phone-as-unlock-endpoint approval — the webapp's half of the boot
// secret RELAY handshake. Mirror of the iOS SecretRequestCoordinator +
// SecretRequestsScreen (apps/mobile/.../SecretRequestCoordinator.swift)
// and docs/security-phone-as-unlock-endpoint.md.
//
// The webapp is a co-equal trust-root device (it holds the IRK via
// keystore.js), so it can approve a booting box exactly like the phone:
//
//   1. fetchVerifiedRequests — build an IRK-signed DeviceEndpointClaim
//      mailbox-auth credential, POST /api/secret-requests on .com, then
//      RE-VERIFY every returned request against the box's STK as
//      INDEPENDENTLY resolved from the directory (/api/users/:u/pods).
//      A request whose STK mismatches the directory (or whose signature
//      fails under it) is DROPPED, never surfaced — `.com` is a blind
//      relay, not a trust anchor (invariants I2/I3).
//   2. approveUnlock — for the user-confirmed request: GET the phone-
//      sealed LUKS key, unseal it with the IRK, re-seal it FOR the box's
//      STK bound to (nonce, purpose), and POST the reply to the boot
//      worker authed by an owner-IRK Flagship-Boot-v1 header.
//
// This webapp build only handles the `unlock-key` purpose (the common
// boot-approval). `entitlement` requests need the RootEntitlement /
// EntitlementBundle carrier serialisation, which the mobile app owns;
// the webapp surfaces them read-only with a "approve from your phone"
// hint rather than mis-signing.
//
// Boot-worker host is configurable (an enterprise clone self-hosts boot
// ops); defaults to boot.flagshipserver.com, matching the mobile client.

import { getSession } from "./state.js";
import {
  signWithIrk as defaultSignWithIrk,
  deriveIrkFromSeed,
  hkdf32,
  bytesToHex,
  hexToBytes,
} from "../keystore.js";
import { ed25519PubToX25519 } from "./edToMont.js";
import { controlApex, bootOrigin } from "./apex.js";

const COM_BASE = controlApex();
const BOOT_BASE = bootOrigin();

const TAG_DEVICE_ENDPOINT_CLAIM = "flagship/device-endpoint-claim/v1";
const TAG_SECRET_REQUEST = "flagship/secret-request/v1";
const TAG_SECRET_RESPONSE_CTX = "flagship/secret-response/v1";
const TAG_BOOT_AUTH = "flagship/boot-auth/v1";
const FLAGSHIP_SEAL_TAG = "flagship.seal.v1";

function te(s) {
  return new TextEncoder().encode(s);
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function concat(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Crypto helpers ──────────────────────────────────────────────────

/**
 * Derive the IRK seed (the 32-byte Ed25519 seed) from the UMK exactly as
 * keystore.js does (hkdf32(umk, "flagship.irk.v1")). The boot seal must
 * open with this same Ed25519 seed the installer sealed against. Reuses
 * the canonical hkdf32 so it can't drift.
 */
async function deriveIrkSeed(umkSeed) {
  return hkdf32(umkSeed, "flagship.irk.v1");
}

/** Ed25519 seed → X25519 private scalar (clamp(SHA-512(seed)[0..32])). */
async function edSeedToX25519Priv(edSeed) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-512", edSeed));
  const x = h.slice(0, 32);
  x[0] &= 248;
  x[31] &= 127;
  x[31] |= 64;
  return x;
}

async function hkdfSeal(sharedBits, ephPub) {
  const sharedKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: ephPub, info: te(FLAGSHIP_SEAL_TAG) },
      sharedKey,
      256,
    ),
  );
}

/**
 * Open a sealed blob (sealed FOR an Ed25519 recipient via
 * sealForEd25519Recipient) using that key's Ed25519 SEED. Mirror of
 * openSealedFromEd25519Recipient + leases.js openSealedWithIrk.
 * Blob: [ephX25519Pub:32][nonce:12][ct+tag].
 */
async function openSealedWithEd25519Seed(blob, edSeed) {
  if (blob.length < 44) throw new Error("sealed blob too short");
  const ephPub = blob.slice(0, 32);
  const nonce = blob.slice(32, 44);
  const ct = blob.slice(44);
  const myX = await edSeedToX25519Priv(edSeed);
  const myKey = await crypto.subtle.importKey("raw", myX, "X25519", false, ["deriveBits"]);
  const ephKey = await crypto.subtle.importKey("raw", ephPub, "X25519", false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: ephKey }, myKey, 256);
  const sym = await hkdfSeal(shared, ephPub);
  const aesKey = await crypto.subtle.importKey("raw", sym, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ct);
  return new Uint8Array(pt);
}

/**
 * Seal `plaintext` FOR a box's Ed25519 STK pubkey. Mirror of
 * sealForEd25519Recipient + sealForRecipient: convert the STK to its
 * X25519 pubkey, ECDH with a fresh ephemeral X25519 key, HKDF, AES-GCM.
 * Returns [ephX25519Pub:32][nonce:12][ct+tag].
 */
async function sealForBoxStk(plaintext, stkEdPub) {
  const recipX = ed25519PubToX25519(stkEdPub);
  const recipKey = await crypto.subtle.importKey("raw", recipX, "X25519", false, []);
  // Fresh ephemeral X25519 keypair via WebCrypto.
  const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: recipKey }, eph.privateKey, 256);
  const sym = await hkdfSeal(shared, ephPub);
  const aesKey = await crypto.subtle.importKey("raw", sym, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));
  return concat(ephPub, nonce, ct);
}

/**
 * Build the SealedSecretResponse `sealed` bytes: prepend a length-
 * prefixed (nonce, purpose) context header so the box rejects a replayed
 * / repurposed response, then seal FOR the box STK. Mirror of
 * buildSealedSecretResponse: payload = [ctxLen:4 BE][ctx][secret].
 */
async function buildSealedResponse(secret, { stkEdPub, nonceHex, purpose }) {
  const ctx = te([TAG_SECRET_RESPONSE_CTX, nonceHex, purpose].join("|"));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, ctx.length, false);
  const payload = concat(header, ctx, secret);
  return sealForBoxStk(payload, stkEdPub);
}

// ── Canonical bytes (mirror @flagship/protocol) ─────────────────────

function canonicalDeviceEndpointClaim({ username, endpointLabel, phoneIrkPubHex, issuedAt, expiresAt, nonceHex }) {
  return te(
    [TAG_DEVICE_ENDPOINT_CLAIM, username, endpointLabel, phoneIrkPubHex, issuedAt, expiresAt, nonceHex].join("|"),
  );
}

function canonicalSecretRequest({ serverDomain, stkPubHex, purpose, nonceHex, issuedAt }) {
  return te([TAG_SECRET_REQUEST, serverDomain, stkPubHex, purpose, nonceHex, issuedAt].join("|"));
}

function canonicalBootAuth({ role, serverDomain, method, path, pubKeyHex, nonceHex, issuedAt }) {
  return te([TAG_BOOT_AUTH, role, serverDomain, method.toUpperCase(), path, pubKeyHex.toLowerCase(), nonceHex.toLowerCase(), issuedAt].join("|"));
}

/** Build the owner-IRK `Authorization: Flagship-Boot-v1 …` header. */
async function ownerBootHeader({ serverDomain, method, path, umk, signWithIrk, now }) {
  const irkSeed = await deriveIrkSeed(umk);
  const pubKeyHex = await irkPubHex(umk);
  const nonceHex = bytesToHex(randomBytes(32));
  const issuedAt = now;
  const envelope = { role: "owner", serverDomain, method: method.toUpperCase(), path, pubKeyHex, nonceHex, issuedAt };
  const sig = await signWithIrk(umk, canonicalBootAuth(envelope));
  const full = { ...envelope, signatureHex: bytesToHex(sig) };
  return `Flagship-Boot-v1 ${b64urlEncode(te(JSON.stringify(full)))}`;
}

async function irkPubHex(umk) {
  const session = getSession();
  // Prefer the already-derived session IRK pub (avoids a re-derive).
  if (session.irk?.publicKey) return bytesToHex(session.irk.publicKey);
  // Fallback: derive the IRK keypair from the UMK seed the same way
  // state.js does on unlock (deriveIrkFromSeed → { publicKey }).
  const irk = await deriveIrkFromSeed(umk);
  return bytesToHex(irk.publicKey);
}

// ── Public API (mirror SecretRequestCoordinator) ────────────────────

/**
 * One pending boot-secret request that PASSED directory re-verification.
 * @typedef {Object} VerifiedBootRequest
 * @property {string} id                 stable list id (`domain#nonce`)
 * @property {string} serverDomain
 * @property {string} purpose            "unlock-key" | "entitlement"
 * @property {string} requestNonceHex
 * @property {string} directoryStkPubHex the STK from the DIRECTORY (not the echo)
 * @property {object|null} deviceInfo    unsigned display hint (ip/region/os/hostname)
 */

/**
 * Fetch the account's pending boot requests + keep only those that
 * re-verify against the directory STK. A request `.com` returns whose
 * STK isn't directory-bound — or whose signature fails under it, or
 * whose echo differs from the directory — is SILENTLY dropped.
 *
 * @param {{ fetch?: typeof fetch, comBase?: string, signWithIrk?: Function, now?: () => number }} [deps]
 * @returns {Promise<VerifiedBootRequest[]>}
 */
export async function fetchVerifiedRequests(deps = {}) {
  const session = getSession();
  const username = session.username;
  if (!username) throw new Error("sign in to approve a box");
  if (!session.umk) throw new Error("unlock the webapp first");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || COM_BASE;
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();

  // 1. IRK-signed mailbox-auth (a DeviceEndpointClaim, repurposed).
  const phoneIrkPubHex = await irkPubHex(session.umk);
  const issuedAt = now;
  const expiresAt = now + 120_000;
  const nonceHex = bytesToHex(randomBytes(32));
  const authCore = {
    username,
    endpointLabel: "device",
    phoneIrkPub: phoneIrkPubHex,
    issuedAt,
    expiresAt,
    nonce: nonceHex,
  };
  const authSig = await sign(
    session.umk,
    canonicalDeviceEndpointClaim({ ...authCore, phoneIrkPubHex, nonceHex }),
  );
  const authBody = { auth: authCore, authSignature: bytesToHex(authSig) };

  const [pendingResp, dirResp] = await Promise.all([
    f(`${comBase}/api/secret-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authBody),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`secret-requests: HTTP ${r.status}`)))),
    f(`${comBase}/api/users/${encodeURIComponent(username)}/pods`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { pods: [] })),
  ]);

  // Directory STK map (non-revoked entries only).
  const dirStk = new Map();
  for (const p of dirResp.pods ?? []) {
    if (p.revokedAt == null && p.serverDomain && p.identityPubKey) {
      dirStk.set(String(p.serverDomain).toLowerCase(), String(p.identityPubKey).toLowerCase());
    }
  }

  const out = [];
  for (const req of pendingResp.requests ?? []) {
    const domain = String(req.serverDomain ?? "").toLowerCase();
    const stkHex = dirStk.get(domain);
    if (!stkHex) continue; // no directory entry → `.com` can't vouch
    // The mailbox echo MUST equal the directory STK (relay can't splice).
    if (String(req.stkPub ?? "").toLowerCase() !== stkHex) continue;
    // RE-VERIFY the box's request signature under the DIRECTORY STK.
    let stkPub;
    let sig;
    try {
      stkPub = hexToBytes(stkHex);
      sig = hexToBytes(req.requestSignature);
      if (stkPub.length !== 32 || sig.length !== 64) continue;
    } catch {
      continue;
    }
    const canonical = canonicalSecretRequest({
      serverDomain: req.serverDomain,
      stkPubHex: stkHex,
      purpose: req.purpose,
      nonceHex: req.requestNonceHex,
      issuedAt: req.issuedAt,
    });
    let verified = false;
    try {
      const key = await crypto.subtle.importKey("raw", stkPub, { name: "Ed25519" }, false, ["verify"]);
      verified = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, canonical);
    } catch {
      verified = false;
    }
    if (!verified) continue;
    out.push({
      id: `${req.serverDomain}#${req.requestNonceHex}`,
      serverDomain: req.serverDomain,
      purpose: req.purpose,
      requestNonceHex: req.requestNonceHex,
      directoryStkPubHex: stkHex,
      deviceInfo: req.deviceInfo ?? null,
    });
  }
  return out;
}

/**
 * Approve a verified `unlock-key` request: fetch the phone-sealed LUKS
 * key, unseal it with the IRK, re-seal it FOR the box STK bound to
 * (nonce, purpose), and POST the sealed reply to the boot worker authed
 * by an owner-IRK Flagship-Boot-v1 header. Mirror of
 * SecretRequestCoordinator.confirmAndRespond (unlock-key branch).
 *
 * @param {VerifiedBootRequest} req
 * @param {{ fetch?: typeof fetch, comBase?: string, bootBase?: string, signWithIrk?: Function, now?: () => number }} [deps]
 */
export async function approveUnlock(req, deps = {}) {
  if (req.purpose !== "unlock-key") {
    throw new Error("approve this request type from your phone");
  }
  const session = getSession();
  if (!session.umk) throw new Error("unlock the webapp first");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || COM_BASE;
  const bootBase = deps.bootBase || BOOT_BASE;
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();

  const stkEdPub = hexToBytes(req.directoryStkPubHex);

  // 1. GET the phone-sealed LUKS key (sealed FOR the IRK at install).
  const sealedRes = await f(
    `${comBase}/api/server/${encodeURIComponent(req.serverDomain)}/sealed-luks-key`,
  );
  if (sealedRes.status === 404) throw new Error("no sealed disk key is on file for this box yet");
  if (!sealedRes.ok) throw new Error(`sealed-luks-key: HTTP ${sealedRes.status}`);
  const sealedJson = await sealedRes.json();
  const sealedBlob = hexToBytes(sealedJson.sealedKey);

  // 2. Unseal with the IRK seed (whichever phone key the installer sealed
  //    against — the webapp's primary key is the IRK).
  const irkSeed = await deriveIrkSeed(session.umk);
  let luksKey;
  try {
    luksKey = await openSealedWithEd25519Seed(sealedBlob, irkSeed);
  } catch {
    throw new Error("couldn't unseal the disk key with this browser's account key");
  }

  // 3. Re-seal FOR the box STK, bound to (nonce, purpose).
  const sealed = await buildSealedResponse(luksKey, {
    stkEdPub,
    nonceHex: req.requestNonceHex,
    purpose: req.purpose,
  });

  // 4. POST the reply to the boot worker, owner-IRK Flagship-Boot-v1 auth.
  const path = "/api/boot/response";
  const authHeader = await ownerBootHeader({
    serverDomain: req.serverDomain,
    method: "POST",
    path,
    umk: session.umk,
    signWithIrk: sign,
    now,
  });
  const body = {
    response: {
      serverDomain: req.serverDomain,
      requestNonceHex: req.requestNonceHex,
      purpose: req.purpose,
      sealed: bytesToHex(sealed),
      issuedAt: now,
    },
  };
  const r = await f(`${bootBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!(r.status === 200 || r.status === 201 || r.status === 204)) {
    const txt = await r.text().catch(() => "");
    throw new Error(`post boot response failed: ${r.status} ${txt}`.trim());
  }
  return { ok: true };
}

// Exported for the conversion / seal unit test cross-check.
export const _internal = {
  buildSealedResponse,
  sealForBoxStk,
  openSealedWithEd25519Seed,
  canonicalSecretRequest,
  canonicalBootAuth,
  deriveIrkSeed,
};
