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
//      verify every returned request under the key it names and check that
//      key against this device's pin (lib/serverPins.js, docs/first-contact.md).
//      Before a pin the directory must name the same key; after it, a request
//      under another key is shown refused. `.com` is a blind relay, not a
//      trust anchor (invariants I2/I3).
//   2. approveUnlock — for the user-confirmed request: GET the phone-
//      sealed LUKS key, unseal it with the IRK, re-seal it FOR the box's
//      pinned STK bound to (nonce, purpose), and POST the reply to the boot
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
import { sensitiveSigner } from "./adminRoot.js";
import { controlApex, bootOrigin } from "./apex.js";
import { importX25519Private } from "./x25519.js";
import { accountReadFetch } from "./accountRead.js";

import { pinnedStk, pinServerKey, sealingStk, noteKeyChanged, forgetFirstContactSecrets } from "./serverPins.js";
import { classifyFirstContact, grantAppNames, refusalText, KEY_CHANGED } from "./firstContact.js";

import { tr } from "./i18n.js";

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
  const myKey = await importX25519Private(myX);
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
 * @property {string} directoryStkPubHex the key that signed the request (the pin, once pinned)
 * @property {object|null} deviceInfo    unsigned display hint (ip/region/os/hostname)
 * @property {object} firstContact       lib/firstContact.js classifyFirstContact: pin state, code, refusal
 */

/**
 * Fetch the account's pending boot requests. A request not signed by the key
 * it names, or (before a pin) naming a key the directory doesn't, is dropped;
 * one naming a key other than the pin is kept with a refusal to show.
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
  const comBase = deps.comBase || controlApex();
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
    }).then((r) => (r.ok ? r.json() : Promise.reject(Object.assign(new Error(`secret-requests: HTTP ${r.status}`), { status: r.status })))),
    accountReadFetch(`${comBase}/api/users/${encodeURIComponent(username)}/pods`, { cache: "no-store" }, { fetch: f, baseUrl: comBase })
      .then((r) => (r.ok ? r.json() : { pods: [] })),
  ]);

  // The directory's key and whether the box has ever come online (non-revoked entries only).
  const dir = new Map();
  for (const p of dirResp.pods ?? []) {
    if (p.revokedAt == null && p.serverDomain && p.identityPubKey) {
      dir.set(String(p.serverDomain).toLowerCase(), {
        stk: String(p.identityPubKey).toLowerCase(),
        cameOnline: p.lastReported != null || p.currentCert != null,
      });
    }
  }

  const out = [];
  for (const req of pendingResp.requests ?? []) {
    const domain = String(req.serverDomain ?? "").toLowerCase();
    const entry = dir.get(domain);
    if (!entry) continue; // not one of this account's servers
    const stkHex = String(req.stkPub ?? "").toLowerCase();
    // The request must be signed by the key it names (the box's own STK).
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
    // Before a pin, the directory must name the same key (the relay can't splice one in); after it,
    // the pin decides and a request under any other key is shown refused.
    const pinned = pinnedStk(domain);
    if (!pinned && entry.stk !== stkHex) continue;
    if (pinned && pinned !== stkHex && entry.stk !== stkHex) noteKeyChanged(domain, entry.stk);
    const firstContact = await classifyFirstContact({
      serverDomain: domain,
      stkPubHex: stkHex,
      purpose: req.purpose,
      deviceInfo: req.deviceInfo ?? null,
      cameOnline: entry.cameOnline,
    }, { umk: session.umk });
    out.push({
      id: `${req.serverDomain}#${req.requestNonceHex}`,
      serverDomain: req.serverDomain,
      purpose: req.purpose,
      requestNonceHex: req.requestNonceHex,
      directoryStkPubHex: stkHex,
      deviceInfo: req.deviceInfo ?? null,
      firstContact,
    });
  }
  return out;
}

/**
 * The key a reply for `req` is sealed or minted for. A request the device refuses never gets one;
 * a first-sight request pins its key here, the moment the owner approves.
 */
async function keyForReply(req) {
  const fc = req.firstContact;
  if (!fc) {
    const k = sealingStk(req.serverDomain, req.directoryStkPubHex);
    if (!k) throw keyChangedOrUnpinned(req);
    return k;
  }
  if (fc.refusal) throw Object.assign(new Error(refusalText(fc.refusal)), { code: fc.refusal });
  const stk = String(req.directoryStkPubHex).toLowerCase();
  if (fc.pinState === "pinned") {
    const k = sealingStk(req.serverDomain, stk);
    if (!k) throw keyChangedOrUnpinned(req);
    return k;
  }
  if (fc.pinState === "awaiting-proof") return stk;
  pinServerKey(req.serverDomain, stk, fc.pinState === "proven" ? "proof" : fc.studioConfirmed ? "studio" : "first-sight");
  await forgetFirstContactSecrets(req.serverDomain);
  return stk;
}

function keyChangedOrUnpinned(req) {
  return pinnedStk(req.serverDomain)
    ? Object.assign(new Error(refusalText(KEY_CHANGED)), { code: KEY_CHANGED })
    : new Error("approve this server's start-up first");
}

/** Sign the app-name grant for a freshly pinned server in the same moment; never fails the approval. */
async function grantAfterPin(req) {
  const fc = req.firstContact;
  if (!fc || fc.refusal || fc.pinState === "pinned" || fc.pinState === "awaiting-proof") return;
  try {
    await grantAppNames(req.serverDomain);
  } catch (e) {
    console.warn("[first-contact] app-name grant not signed:", e?.message || e);
  }
}

/**
 * POST a sealed reply (whatever the request type produced) to the boot
 * worker, authed by an owner-IRK Flagship-Boot-v1 header. The transport is
 * identical for every request type — only the `sealed` bytes differ — so the
 * Box Request Inbox (docs/box-request-inbox.md) shares ONE post path and the
 * per-type responders just hand it their `sealedHex`. Mirror of
 * SecretRequestCoordinator.confirmAndRespond's single postResponse.
 */
async function postBootResponse(req, sealedHex, deps) {
  const session = getSession();
  const f = deps.fetch || fetch;
  const bootBase = deps.bootBase || bootOrigin();
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();
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
      sealed: sealedHex,
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
    // `status` lets the inbox treat "already answered" (409) as done.
    throw Object.assign(new Error(`post boot response failed: ${r.status} ${txt}`.trim()), { status: r.status, body: txt });
  }
}

/**
 * The `unlock-key` responder: fetch the phone-sealed LUKS key, unseal it with
 * the IRK, re-seal it FOR the box STK bound to (nonce, purpose), POST it, and
 * THEN deposit the entitlement (consent to boot ⇒ consent to serve, so the box
 * also comes online with this one approval). Mirror of confirmAndRespond's
 * unlock branch + the line-248 deposit.
 *
 * @param {VerifiedBootRequest} req
 * @param {{ fetch?: typeof fetch, comBase?: string, bootBase?: string, signWithIrk?: Function, now?: () => number }} [deps]
 */
async function respondUnlock(req, deps = {}) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock the webapp first");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();

  const stkHex = await keyForReply(req);
  const stkEdPub = hexToBytes(stkHex);

  // 1. GET the phone-sealed LUKS key (sealed FOR the IRK at install).
  const sealedRes = await f(
    `${comBase}/api/server/${encodeURIComponent(req.serverDomain)}/sealed-luks-key`,
  );
  if (sealedRes.status === 404) throw new Error("no sealed disk key is on file for this box yet");
  if (!sealedRes.ok) throw new Error(`sealed-luks-key: HTTP ${sealedRes.status}`);
  const sealedJson = await sealedRes.json();
  const sealedBlob = hexToBytes(sealedJson.sealedKey);

  // 2. Unseal with the IRK seed (the webapp's primary key is the IRK).
  const irkSeed = await deriveIrkSeed(session.umk);
  let luksKey;
  try {
    luksKey = await openSealedWithEd25519Seed(sealedBlob, irkSeed);
  } catch {
    throw new Error("couldn't unseal the disk key with this browser's account key");
  }

  // 3. Re-seal FOR the box STK, bound to (nonce, purpose); POST it.
  const sealed = await buildSealedResponse(luksKey, {
    stkEdPub,
    nonceHex: req.requestNonceHex,
    purpose: req.purpose,
  });
  await postBootResponse(req, bytesToHex(sealed), deps);

  // The device that made the recipe waits for the box's proof, which only its entitlement request
  // can carry (the start-up unlock is asked before the disk, and the secret on it, is open): no
  // deposit, so the box asks for its entitlement next and the code is checked there.
  if (req.firstContact?.pinState === "awaiting-proof") return { ok: true };
  await grantAfterPin(req);

  // 4. Fold "authorize it to serve" INTO this unlock approval (the primary
  // layer). Best-effort — a failure never fails the unlock; the box can still
  // request the entitlement via the inbox fallback.
  try {
    // Slice D: route the folded-in RootEntitlement deposit through the gated
    // signer so its carrier signs under the admin master root when present. The
    // gate is tag-routed, so the co-signed IRK mailbox-auth still falls back to
    // `sign` (the membership IRK the deposit lane needs).
    await depositEntitlement(
      { serverDomain: req.serverDomain, stkPubHex: stkHex },
      { fetch: f, comBase, signWithIrk: sensitiveSigner(sign), now: () => now },
    );
  } catch (e) {
    console.warn(
      "[box-inbox] entitlement deposit failed (the box will request it via the inbox):",
      e?.message || e,
    );
  }
  return { ok: true };
}

/**
 * The `entitlement` responder: mint an admin-root-signed (owner-IRK on a
 * pre-wipe box) RootEntitlement carrier for the box's STK and POST it as the
 * reply to the box's entitlement request.
 * Same transport as unlock — only the sealed bytes differ (the PUBLIC carrier,
 * not a secret). Mirror of confirmAndRespond's `.entitlement` branch. This is
 * the inbox FALLBACK for boxes that never got a deposit (unencrypted boxes, or
 * a deposit that failed).
 *
 * @param {VerifiedBootRequest} req
 * @param {{ fetch?: typeof fetch, bootBase?: string, signWithIrk?: Function, now?: () => number }} [deps]
 */
async function respondEntitlement(req, deps = {}) {
  const session = getSession();
  const username = session.username;
  if (!username) throw new Error("sign in first");
  if (!session.umk) throw new Error("unlock the webapp first");
  // Slice D: the RootEntitlement carrier signs under the admin master root when
  // present (else the legacy owner IRK) — the tag-routed gate. The boot-auth
  // header on postBootResponse stays IRK (its tag is not sensitive).
  const sign = deps.signWithIrk || sensitiveSigner();
  const now = (deps.now || Date.now)();
  const stkHex = await keyForReply(req);

  const carrierHex = await buildEntitlementCarrier({
    username,
    podPubKeyHex: stkHex,
    podCanonical: req.serverDomain,
    issuedAt: now,
    signWithIrk: sign,
    umk: session.umk,
  });
  await postBootResponse(req, carrierHex, deps);
  await grantAfterPin(req);
  return { ok: true };
}

/**
 * The Box Request type registry (docs/box-request-inbox.md): type → how to
 * present it and how to satisfy it. Adding a future type is one entry here +
 * a `purpose` string — no new plumbing, no new watcher. The webapp is now at
 * parity with mobile: it answers BOTH `unlock-key` and `entitlement`.
 *
 * `title(ctx)` takes an optional `{ firstBoot }` context: on a FIRST boot the
 * unlock approval ALSO deposits the box's entitlement (consent to boot ⇒ consent
 * to serve), so it both unlocks AND authorizes serving — the fuller copy. On an
 * established reboot the box is already authorized, so the "…join your cloud"
 * phrase is noise. `firstBoot` defaults true (unknown ⇒ the fuller copy = the old
 * wording). The deposit still fires on every approval — harmless on reboots — so
 * this is copy only.
 */
export const BOX_REQUEST_TYPES = {
  "unlock-key": {
    title: (ctx = {}) =>
      (ctx.firstBoot ?? true)
        ? tr("Unlock device and authorize it to join your cloud")
        : tr("Unlock device"),
    detail: (ctx = {}) =>
      (ctx.firstBoot ?? true)
        ? tr("Unlocks the encrypted disk and authorizes this box to serve your account.")
        : tr("Unlocks the encrypted disk so this box comes back online."),
    respond: respondUnlock,
  },
  entitlement: {
    title: () => tr("Authorize this box to serve your account"),
    detail: () => tr("Lets this box come online and serve your services."),
    respond: respondEntitlement,
  },
};

/**
 * Satisfy a verified box request by dispatching to its type's responder.
 * The ONE entry point the inbox calls for any type.
 * @param {VerifiedBootRequest} req
 */
export async function satisfy(req, deps = {}) {
  const spec = BOX_REQUEST_TYPES[req.purpose];
  if (!spec) throw new Error(`unsupported request type: ${req.purpose}`);
  return spec.respond(req, deps);
}

/**
 * Back-compat alias — the existing boot-approval view calls approveUnlock.
 * Now a thin wrapper over the registry's unlock responder.
 * @param {VerifiedBootRequest} req
 */
export async function approveUnlock(req, deps = {}) {
  if (req.purpose !== "unlock-key") throw new Error(`approveUnlock: not an unlock-key request (${req.purpose})`);
  return respondUnlock(req, deps);
}

/**
 * Mint an admin-root-signed (owner-IRK on a pre-wipe box) RootEntitlement for
 * THIS box's STK and DEPOSIT it on `.com`, so the box claims it on first boot
 * with no separate "authorize to serve" approval. The carrier is the PUBLIC EntitlementBundle JSON (what the
 * box presents at the hub HELLO), not a secret — so the deposit is content-blind
 * to `.com` and a public consume-once read by the box is harmless.
 *
 * @param {{ serverDomain: string, stkPubHex: string }} args
 * @param {{ fetch?: typeof fetch, comBase?: string, signWithIrk?: Function, now?: () => number }} [deps]
 */
export async function depositEntitlement(args, deps = {}) {
  const session = getSession();
  const username = session.username;
  if (!username) throw new Error("sign in first");
  if (!session.umk) throw new Error("unlock the webapp first");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  // Slice D: the RootEntitlement is an ADMIN-ROOT order (only admins bring a box
  // online) — a reburned admin-pinned box REJECTS an IRK-signed RootEntitlement
  // at HELLO (server-daemon entitlementRelay → authorizeSensitiveOrder). The
  // gated signer routes the `flagship/root-entitlement/v1` carrier to the admin
  // master root (when present) while the co-signed IRK mailbox-auth
  // (`device-endpoint-claim`) stays the membership IRK the deposit lane requires.
  // Legacy (pre-wipe) accounts sign both with the IRK.
  const sign = deps.signWithIrk || sensitiveSigner();
  const now = (deps.now || Date.now)();

  const stkPubHex = sealingStk(args.serverDomain, args.stkPubHex);
  if (!stkPubHex) throw new Error("this server's key isn't pinned on this device");
  const carrierHex = await buildEntitlementCarrier({
    username,
    podPubKeyHex: stkPubHex,
    podCanonical: args.serverDomain,
    issuedAt: now,
    signWithIrk: sign,
    umk: session.umk,
  });

  // IRK mailbox-auth — same shape as the pairing deposit.
  const phoneIrkPubHex = await irkPubHex(session.umk);
  const nonceHex = bytesToHex(randomBytes(32));
  const authCore = {
    username, endpointLabel: "device", phoneIrkPub: phoneIrkPubHex,
    issuedAt: now, expiresAt: now + 120_000, nonce: nonceHex,
  };
  const authSig = await sign(
    session.umk,
    canonicalDeviceEndpointClaim({ ...authCore, phoneIrkPubHex, nonceHex }),
  );
  const body = {
    auth: authCore,
    authSignature: bytesToHex(authSig),
    deposit: {
      serverDomain: args.serverDomain,
      requestNonceHex: bytesToHex(randomBytes(32)),
      stkPub: stkPubHex,
      sealed: carrierHex,
      issuedAt: now,
    },
  };
  const r = await f(
    `${comBase}/api/server/${encodeURIComponent(args.serverDomain)}/entitlement-deposit`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`entitlement-deposit: HTTP ${r.status} ${txt}`.trim());
  }
  return { ok: true };
}

/**
 * SWK delivery (secret-free recipe, docs/recipe-delivery-and-remote-install.md).
 * Mirror of @flagship/protocol `buildSwkDelivery` + `swkDeliveryToCarrierHex`.
 *
 * Seal the 32-byte SWK FOR the box's Ed25519 identity pub (via `sealForBoxStk`,
 * the same ed→x25519 seal the pairing/disk-key flows use) and IRK-sign the
 * wrapper binding `(serverDomain, sealed, issuedAt)`:
 *
 *   flagship/swk-delivery/v1|<serverDomain>|<hex(sealed)>|<issuedAt>
 *
 * Returns the carrier hex (UTF-8 JSON {serverDomain, sealed, issuedAt, signature}
 * → hex), byte-identical to the TS so the box parses + verifies + unseals it.
 *
 * @param {{ serverDomain: string, swk: Uint8Array, boxIdentityPub: Uint8Array,
 *   issuedAt: number, signWithIrk: Function, umk: Uint8Array }} args
 */
export async function buildSwkDeliveryCarrier({ serverDomain, swk, boxIdentityPub, issuedAt, signWithIrk, umk }) {
  if (swk.length !== 32) throw new Error(tr("SWK must be 32 bytes"));
  if (boxIdentityPub.length !== 32) throw new Error("box identity pubkey must be 32 bytes");
  const sealed = await sealForBoxStk(swk, boxIdentityPub);
  // Field guard: serverDomain must never contain '|' or control chars (mirrors
  // legacyFieldGuard) — true for every real FQDN; assert it defensively.
  if (/[|\u0000-\u001f\u007f]/.test(serverDomain)) {
    throw new Error("serverDomain contains a reserved canonical-bytes char");
  }
  const sealedHex = bytesToHex(sealed);
  const canonical = te(
    ["flagship/swk-delivery/v1", serverDomain, sealedHex, issuedAt].join("|"),
  );
  const sig = await signWithIrk(umk, canonical);
  const json = JSON.stringify({
    serverDomain,
    sealed: sealedHex,
    issuedAt,
    signature: bytesToHex(sig),
  });
  return bytesToHex(te(json));
}

/**
 * Deposit the SWK for a box that has registered, on `.com`'s blind swk-deposit
 * lane. Secret-free recipe: the recipe carried NO SWK; once the box is in the
 * directory (with its identity pub), the webapp seals the SWK to it + IRK-signs
 * the wrapper + deposits the sealed carrier here. The box claims it on boot and
 * turns on its service platform. `.com` holds ciphertext only (I1). Mirror of
 * the mobile SwkDepositCoordinator. `deposit.stkPub` binds the REGISTERED STK.
 *
 * @param {{ serverDomain: string, stkPubHex: string, swkHex: string }} args
 * @param {{ fetch?: typeof fetch, comBase?: string, signWithIrk?: Function, now?: () => number }} [deps]
 */
export async function depositSwk(args, deps = {}) {
  const session = getSession();
  const username = session.username;
  if (!username) throw new Error("sign in first");
  if (!session.umk) throw new Error("unlock the webapp first");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();

  const stkPubHex = sealingStk(args.serverDomain, args.stkPubHex);
  if (!stkPubHex) throw new Error("this server's key isn't pinned on this device");
  const carrierHex = await buildSwkDeliveryCarrier({
    serverDomain: args.serverDomain,
    swk: hexToBytes(args.swkHex),
    boxIdentityPub: hexToBytes(stkPubHex),
    issuedAt: now,
    signWithIrk: sign,
    umk: session.umk,
  });

  // IRK mailbox-auth — same shape as the pairing / entitlement deposit.
  const phoneIrkPubHex = await irkPubHex(session.umk);
  const nonceHex = bytesToHex(randomBytes(32));
  const authCore = {
    username, endpointLabel: "device", phoneIrkPub: phoneIrkPubHex,
    issuedAt: now, expiresAt: now + 120_000, nonce: nonceHex,
  };
  const authSig = await sign(
    session.umk,
    canonicalDeviceEndpointClaim({ ...authCore, phoneIrkPubHex, nonceHex }),
  );
  const body = {
    auth: authCore,
    authSignature: bytesToHex(authSig),
    deposit: {
      serverDomain: args.serverDomain,
      requestNonceHex: bytesToHex(randomBytes(32)),
      stkPub: stkPubHex,
      sealed: carrierHex,
      issuedAt: now,
    },
  };
  const r = await f(
    `${comBase}/api/server/${encodeURIComponent(args.serverDomain)}/swk-deposit`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`swk-deposit: HTTP ${r.status} ${txt}`.trim());
  }
  return { ok: true };
}

/**
 * CGK delivery (per-cloud gossip key, docs/multi-pod-liveness-session-leadership.md
 * Phase 6). The EXACT twin of `buildSwkDeliveryCarrier` — only the tag + payload
 * differ. Mirror of @flagship/protocol `buildCgkDelivery` + `cgkDeliveryToCarrierHex`.
 *
 * Seal the 32-byte CGK FOR the box's Ed25519 identity pub (via `sealForBoxStk`, the
 * same ed→x25519 seal the SWK/pairing flows use) and IRK-sign the wrapper binding
 * `(serverDomain, sealed, issuedAt)`:
 *
 *   flagship/cgk-delivery/v1|<serverDomain>|<hex(sealed)>|<issuedAt>
 *
 * Returns the carrier hex (UTF-8 JSON {serverDomain, sealed, issuedAt, signature}
 * → hex), byte-identical to the TS so the box parses + verifies + unseals it.
 *
 * @param {{ serverDomain: string, cgk: Uint8Array, boxIdentityPub: Uint8Array,
 *   issuedAt: number, signWithIrk: Function, umk: Uint8Array }} args
 */
export async function buildCgkDeliveryCarrier({ serverDomain, cgk, boxIdentityPub, issuedAt, signWithIrk, umk }) {
  if (cgk.length !== 32) throw new Error(tr("CGK must be 32 bytes"));
  if (boxIdentityPub.length !== 32) throw new Error("box identity pubkey must be 32 bytes");
  const sealed = await sealForBoxStk(cgk, boxIdentityPub);
  // Field guard: serverDomain must never contain '|' or control chars (mirrors
  // legacyFieldGuard) — true for every real FQDN; assert it defensively.
  if (/[| -]/.test(serverDomain)) {
    throw new Error("serverDomain contains a reserved canonical-bytes char");
  }
  const sealedHex = bytesToHex(sealed);
  const canonical = te(
    ["flagship/cgk-delivery/v1", serverDomain, sealedHex, issuedAt].join("|"),
  );
  const sig = await signWithIrk(umk, canonical);
  const json = JSON.stringify({
    serverDomain,
    sealed: sealedHex,
    issuedAt,
    signature: bytesToHex(sig),
  });
  return bytesToHex(te(json));
}

/**
 * Deposit the CGK for a box that has registered, on `.com`'s blind cgk-deposit
 * lane. Per-cloud (NO serverId in the derivation) — but the DELIVERY is addressed
 * to one box (sealed to its identity). Once the box is in the directory (with its
 * identity pub), the webapp seals the CGK to it + IRK-signs the wrapper + deposits
 * the sealed carrier here. The box claims it on boot and enables per-service
 * leadership gossip. `.com` holds ciphertext only (I1). The exact twin of
 * `depositSwk` (same `{auth,…,deposit}` mailbox wrapper); `deposit.stkPub` binds
 * the REGISTERED STK (I2).
 *
 * @param {{ serverDomain: string, stkPubHex: string, cgkHex: string }} args
 * @param {{ fetch?: typeof fetch, comBase?: string, signWithIrk?: Function, now?: () => number }} [deps]
 */
export async function depositCgk(args, deps = {}) {
  const session = getSession();
  const username = session.username;
  if (!username) throw new Error("sign in first");
  if (!session.umk) throw new Error("unlock the webapp first");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();

  const stkPubHex = sealingStk(args.serverDomain, args.stkPubHex);
  if (!stkPubHex) throw new Error("this server's key isn't pinned on this device");
  const carrierHex = await buildCgkDeliveryCarrier({
    serverDomain: args.serverDomain,
    cgk: hexToBytes(args.cgkHex),
    boxIdentityPub: hexToBytes(stkPubHex),
    issuedAt: now,
    signWithIrk: sign,
    umk: session.umk,
  });

  // IRK mailbox-auth — same shape as the swk / pairing / entitlement deposit.
  const phoneIrkPubHex = await irkPubHex(session.umk);
  const nonceHex = bytesToHex(randomBytes(32));
  const authCore = {
    username, endpointLabel: "device", phoneIrkPub: phoneIrkPubHex,
    issuedAt: now, expiresAt: now + 120_000, nonce: nonceHex,
  };
  const authSig = await sign(
    session.umk,
    canonicalDeviceEndpointClaim({ ...authCore, phoneIrkPubHex, nonceHex }),
  );
  const body = {
    auth: authCore,
    authSignature: bytesToHex(authSig),
    deposit: {
      serverDomain: args.serverDomain,
      requestNonceHex: bytesToHex(randomBytes(32)),
      stkPub: stkPubHex,
      sealed: carrierHex,
      issuedAt: now,
    },
  };
  const r = await f(
    `${comBase}/api/server/${encodeURIComponent(args.serverDomain)}/cgk-deposit`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`cgk-deposit: HTTP ${r.status} ${txt}`.trim());
  }
  return { ok: true };
}

/**
 * The PUBLIC entitlement carrier hex: a RootEntitlement serialized as the
 * daemon's on-disk EntitlementBundle JSON (UTF-8 → hex). Canonical bytes + JSON
 * field shape MUST match packages/protocol `canonicalRootEntitlement` +
 * server-daemon `serializeEntitlementBundle`.
 *
 * Slice D: the `signWithIrk` the callers pass is the tag-routed sensitive signer,
 * so a `flagship/root-entitlement/v1` carrier is signed by the ADMIN MASTER ROOT
 * when the account has one (a reburned admin-pinned box rejects an IRK-signed
 * RootEntitlement at HELLO), falling back to the owner IRK on a pre-wipe box. The
 * signing KEY changes; the canonical bytes are byte-identical.
 */
async function buildEntitlementCarrier({ username, podPubKeyHex, podCanonical, issuedAt, signWithIrk, umk }) {
  const canonical = te(
    ["flagship/root-entitlement/v1", username, podPubKeyHex, podCanonical, issuedAt].join("|"),
  );
  const sig = await signWithIrk(umk, canonical);
  const json = JSON.stringify({
    rootEntitlement: { username, podPubKey: podPubKeyHex, podCanonical, issuedAt },
    rootEntitlementSig: bytesToHex(sig),
    serviceEntitlement: null,
    serviceEntitlementSig: null,
  });
  return bytesToHex(te(json));
}

export function pairingOrderToJson(request, signature) {
  return JSON.stringify({
    request: {
      type: "add-paired-session",
      serverId: request.serverId,
      token: request.token,
      issuedAt: request.issuedAt,
    },
    signature: bytesToHex(signature),
  });
}

/**
 * Build the owner-IRK-signed `add-paired-session` order at CREATE time (the
 * secret-free pairing path -- NO pairing keypair, NO recipe-embedded secret).
 * Reuses the create-server biometric IRK. Returns the `token` (persist as this
 * device's session token so the BFF auths the moment the box claims the order)
 * + the plaintext `pairingOrderJson` (`pairingOrderToJson` shape) the caller
 * either EMBEDS (offline) or STASHES to seal + deposit post-registration.
 *
 * @param {{ serverDomain: string }} args
 * @param {{ signWithIrk?: Function, now?: () => number, token?: string }} [deps]
 * @returns {Promise<{ token: string, pairingOrderJson: string }>}
 */
export async function buildPairingOrder(args, deps = {}) {
  const { serverDomain } = args;
  const session = getSession();
  if (!session.username) throw new Error("sign in first");
  if (!session.umk) throw new Error("unlock the webapp first");
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();

  const token = deps.token || bytesToHex(randomBytes(32));
  // v2 carries NO label: a paired session is identified by its opaque
  // token-derived code, never by a human name the box or `.com` could read.
  const orderCanonical = te(
    ["flagship/order/add-paired-session/v2", serverDomain, token, now].join("|"),
  );
  const orderSig = await sign(session.umk, orderCanonical);
  const pairingOrderJson = pairingOrderToJson(
    { serverId: serverDomain, token, issuedAt: now },
    orderSig,
  );
  return { token, pairingOrderJson };
}

/**
 * DEFAULT (online) pairing deposit -- the secret-free twin of `depositSwk`.
 * Once the box has registered (carrying its IDENTITY pub in `/pods`), SEAL the
 * create-time `pairingOrderJson` to that identity and deposit it on `.com`'s
 * blind `pairing-deposit` lane. `.com` holds only ciphertext (I1); the box
 * unseals with its identity key, verifies the owner-IRK order, and adds the
 * session (no manual tap). Sealing is a public-key op -- NO second biometric.
 *
 * @param {{ serverDomain: string, identityPubKeyHex: string, pairingOrderJson: string }} args
 * @param {{ fetch?: typeof fetch, comBase?: string, signWithIrk?: Function, now?: () => number }} [deps]
 */
export async function depositPairingOrder(args, deps = {}) {
  const { serverDomain, identityPubKeyHex, pairingOrderJson } = args;
  const session = getSession();
  const username = session.username;
  if (!username) throw new Error("sign in first");
  if (!session.umk) throw new Error("unlock the webapp first");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();

  const stkPubHex = sealingStk(serverDomain, identityPubKeyHex);
  if (!stkPubHex) throw new Error("this server's key isn't pinned on this device");
  // Seal the plaintext order JSON DIRECTLY to the box identity -- the daemon's
  // pairing-deposit consumer unseals `deposit.sealed` and decodes it as the
  // `{request, signature}` JSON (no carrier wrapper, unlike the SWK lane).
  const sealed = await sealForBoxStk(te(pairingOrderJson), hexToBytes(stkPubHex));

  // IRK mailbox-auth -- same shape as the SWK / entitlement deposit.
  const phoneIrkPubHex = await irkPubHex(session.umk);
  const nonceHex = bytesToHex(randomBytes(32));
  const authCore = {
    username, endpointLabel: "device", phoneIrkPub: phoneIrkPubHex,
    issuedAt: now, expiresAt: now + 120_000, nonce: nonceHex,
  };
  const authSig = await sign(
    session.umk,
    canonicalDeviceEndpointClaim({ ...authCore, phoneIrkPubHex, nonceHex }),
  );
  const body = {
    auth: authCore,
    authSignature: bytesToHex(authSig),
    deposit: {
      serverDomain,
      requestNonceHex: bytesToHex(randomBytes(32)),
      stkPub: stkPubHex,
      sealed: bytesToHex(sealed),
      issuedAt: now,
    },
  };
  const r = await f(`${comBase}/api/server/${encodeURIComponent(serverDomain)}/pairing-deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`pairing-deposit: HTTP ${r.status} ${txt}`.trim());
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
  buildEntitlementCarrier,
  buildSwkDeliveryCarrier,
  buildCgkDeliveryCarrier,
};
