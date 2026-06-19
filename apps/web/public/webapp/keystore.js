// Flagship webapp keystore.
//
// Generates a UMK on first run, wraps it with PBKDF2(passphrase) → AES-GCM,
// stores the wrapped blob in IndexedDB. Exposes deriveIRK/BAK that mirror
// the canonical-bytes shapes the rest of Flagship uses (Ed25519 via the
// browser's WebCrypto subtle interface).
//
// IMPORTANT: this is software-only key storage. The Secure Enclave / StrongBox
// path is reserved for the native iOS / Android apps.
//
// Multi-profile keying (docs/login-and-account-redesign.md — "Multi-profile
// integration"). One browser profile can hold multiple clouds (personal +
// family + work — see lib/profiles.js). Each cloud has its OWN device key, so
// the wrapped UMK is stored under a per-profile IndexedDB record key derived
// from the profile's `cloudName` (lowercased). A second profile's UMK must
// never clobber the first.
//
// Backward-compat: a sentinel DEFAULT profile reuses the EXISTING `wrappedUmk`
// record so pre-existing installs (and recovery.js export/import, which reads
// that exact key) keep working unchanged. Non-default profiles get keyed
// records (`wrappedUmk.<profileId>`). The active profile is sourced from
// lib/profiles.js (`activeCloudName`) — see {@link activeProfileId} — with an
// in-process override ({@link setActiveKeystoreProfile}) for callers that want
// to scope an op without touching localStorage.

import * as profilesStore from "./lib/profilesStore.js";

const DB_NAME = "flagship-webapp";
const DB_STORE = "keystore";
const RECORD_KEY = "wrappedUmk";

// The `flagship-webapp` IndexedDB is SHARED across keystore.js / providers.js /
// lib/labelBook.js / lib/buildDraft.js — all four open the SAME database. Its
// schema version is 2 (labelBook + buildDraft bumped it from keystore.js's
// original v1 to add their stores). Every opener MUST therefore open at the
// SAME version: opening at a LOWER version than the DB already has throws
// `VersionError`, so once a v2 store has been created (e.g. the user touched the
// build-draft / label features) a stale v1 keystore open would break unlock /
// PIN / providers. We open at v2 and create EVERY known store in the upgrade
// handler so whichever module first creates the DB provisions all of them
// (an opener at the same version never re-runs onupgradeneeded, so it would
// otherwise find a sibling's store missing).
const DB_VERSION = 2;
function upgradeFlagshipWebappDb(db) {
  if (!db.objectStoreNames.contains("keystore")) db.createObjectStore("keystore");
  if (!db.objectStoreNames.contains("labelBook")) db.createObjectStore("labelBook");
  if (!db.objectStoreNames.contains("buildDrafts")) {
    db.createObjectStore("buildDrafts", { keyPath: "id" });
  }
}

/** Sentinel profileId that maps to the legacy {@link RECORD_KEY} record so
 *  pre-multi-profile installs read/write the same row they always did. */
export const DEFAULT_PROFILE_ID = "__default__";

// PBKDF2 parameters. iters is intentionally high — this is a one-off
// per session and we want to make a brute-force on the IndexedDB blob expensive.
const PBKDF2_ITERS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const AES_NONCE_BYTES = 12;

/* ---------- IndexedDB helpers ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      upgradeFlagshipWebappDb(r.result);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const r = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- shared KV (used by lib/pinLock.js) ----------
 * Thin re-exports of the same `flagship-webapp`/`keystore` object store so
 * the PIN-lock feature persists alongside the wrapped UMK in ONE database
 * (no second connection, no upgrade-version race). Values may be any
 * structured-cloneable type — including a non-extractable CryptoKey. */
export const kvGet = dbGet;
export const kvPut = dbPut;
export const kvDel = dbDel;

/* ---------- per-profile keying ---------- */

// In-process override for the active profile. When non-null it wins over the
// localStorage-backed active profile (lib/profiles.js). Lets callers scope a
// keystore op (e.g. "store this NEW profile's UMK") without first having to
// mutate the persisted active pointer — and keeps the resolution testable in
// environments without localStorage.
let _activeProfileOverride = null;

/** Normalize a cloudName into a profileId. Empty / nullish → the DEFAULT
 *  sentinel (legacy record). Otherwise lowercased (cloudName is the
 *  identity handle; case is not significant for the record key).
 *  @param {string|null|undefined} cloudName
 *  @returns {string}
 */
export function profileIdFromCloudName(cloudName) {
  if (typeof cloudName !== "string") return DEFAULT_PROFILE_ID;
  const v = cloudName.trim().toLowerCase();
  return v ? v : DEFAULT_PROFILE_ID;
}

/** Set (or clear, with null) the in-process active keystore profile. This is
 *  the explicit handle the ADD-profile flows use to point subsequent
 *  wrapped-UMK writes at the NEW profile before it's been made the persisted
 *  active one — so adding profile B never clobbers profile A's record.
 *  @param {string|null|undefined} cloudName  pass null to clear the override
 *  @returns {string}  the resolved profileId now in effect
 */
export function setActiveKeystoreProfile(cloudName) {
  _activeProfileOverride =
    cloudName == null ? null : profileIdFromCloudName(cloudName);
  return activeProfileId();
}

/** Resolve the active profileId: the in-process override if set, else the
 *  persisted active cloud from lib/profiles.js, else the DEFAULT sentinel.
 *  Reading profiles.js is best-effort — any failure (no localStorage, parse
 *  error) degrades to DEFAULT so the legacy single-profile path always works.
 *  @returns {string}
 */
export function activeProfileId() {
  if (_activeProfileOverride != null) return _activeProfileOverride;
  try {
    const active = readActiveCloudName();
    return active ? profileIdFromCloudName(active) : DEFAULT_PROFILE_ID;
  } catch {
    return DEFAULT_PROFILE_ID;
  }
}

/** Read the persisted active cloudName straight from lib/profiles.js storage.
 *  Synchronous + dependency-light (the keystore can't await an import on every
 *  read) — we parse the same `flagship.profiles.v1` localStorage blob
 *  profiles.js owns. Returns null when there's no active profile / no storage.
 *  @returns {string|null}
 */
function readActiveCloudName() {
  const storage = globalThis.localStorage;
  if (!storage) return null;
  const raw = storage.getItem("flagship.profiles.v1");
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  return typeof parsed.activeCloudName === "string" ? parsed.activeCloudName : null;
}

/** Map a profileId to its IndexedDB record key. DEFAULT reuses the legacy
 *  `wrappedUmk` row (backward-compat); every other profile gets a keyed row.
 *  @param {string} [profileId]  defaults to the active profile
 *  @returns {string}
 */
export function wrappedUmkRecordKey(profileId = activeProfileId()) {
  return profileId === DEFAULT_PROFILE_ID
    ? RECORD_KEY
    : `${RECORD_KEY}.${profileId}`;
}

/* ---------- bytes / hex helpers ---------- */

export function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/* ---------- KEK derivation + UMK wrap/unwrap ---------- */

async function deriveKek(passphrase, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERS,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function wrapUmk(passphrase, umkSeed) {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const nonce = randomBytes(AES_NONCE_BYTES);
  const kek = await deriveKek(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, kek, umkSeed),
  );
  return {
    version: 1,
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ciphertext),
  };
}

async function unwrapUmk(passphrase, blob) {
  const salt = hexToBytes(blob.salt);
  const nonce = hexToBytes(blob.nonce);
  const ciphertext = hexToBytes(blob.ciphertext);
  const kek = await deriveKek(passphrase, salt);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, kek, ciphertext),
  );
}

/* ---------- HKDF + Ed25519 derivations (mirror @flagship/protocol) ---------- */

export async function hkdf32(ikm, info) {
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

function pkcs8FromSeed(seed) {
  // PKCS8 prefix for Ed25519 private key (RFC 8410 §7):
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const out = new Uint8Array(prefix.length + seed.length);
  out.set(prefix, 0);
  out.set(seed, prefix.length);
  return out;
}

/** HKDF info for the IRK at a given version. Version 1 is the canonical
 *  `flagship.irk.v1` the rest of Flagship registers; higher versions are
 *  the rotation slots a re-pair/takeover moves to (a fresh DEVICE key
 *  derived from the SAME user key — see ReplaceDeviceViewModel + the
 *  versioned `flagship/irk/v<N>` keystore on mobile). The webapp keeps
 *  the dotted `flagship.irk.v<N>` shape it already ships for v1. */
function irkInfo(version) {
  return `flagship.irk.v${version}`;
}

async function irkFromInfoSeed(umkSeed, info) {
  const seed = await hkdf32(umkSeed, info);
  const pkcs8 = pkcs8FromSeed(seed);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  // We don't have a portable way to derive the public key from PKCS8 via
  // WebCrypto, but the keypair-import-from-seed pattern lets us also
  // generate a JWK-exportable form.
  const jwkPub = await jwkPubFromSeed(seed);
  return { privateKey, publicKey: jwkPub };
}

/** Read the current IRK rotation version for the active profile.
 *  Persists in localStorage under `flagship.irk.version` (legacy /
 *  default profile) or `flagship.irk.version.<profileId>`. Defaults to
 *  1 so every existing install keeps signing under `flagship.irk.v1`
 *  exactly as before — this is the Worker's registered key for any
 *  account that hasn't run a Replace-device ceremony from the webapp.
 *
 *  A successful Replace-device complete on the webapp writes
 *  `version+1` here so subsequent signing (push, recovery, release-
 *  server-name, RCK orders…) uses the rotated IRK. */
export function currentIrkVersion(profileId = activeProfileId()) {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return 1;
    // Default profile keeps the legacy direct-read path (the legacy
    // flat key has no cloudName under which profilesStore could
    // index it). Named profiles read through profilesStore — that's
    // the B3 cut-over.
    if (profileId === DEFAULT_PROFILE_ID) {
      const raw = ls.getItem("flagship.irk.version");
      const n = raw == null ? 1 : Number(raw);
      return Number.isInteger(n) && n >= 1 ? n : 1;
    }
    const fromStore = profilesStore.get("currentIrkVersion", {
      storage: ls,
      cloudName: profileId,
    });
    if (fromStore != null) {
      const n = Number(fromStore);
      if (Number.isInteger(n) && n >= 1) return n;
    }
    // Pre-B3 installs wrote `flagship.irk.version.<profileId>`
    // directly. Read forward + migrate one-shot into profilesStore
    // so the next call hits the canonical path. We don't bother
    // migrating when the value is 1 — that's the implicit default,
    // already what an absent slot resolves to.
    const raw = ls.getItem(`flagship.irk.version.${profileId}`);
    if (raw != null) {
      const n = Number(raw);
      const valid = Number.isInteger(n) && n >= 1 ? n : 1;
      if (valid > 1) {
        try {
          profilesStore.set("currentIrkVersion", String(valid), {
            storage: ls,
            cloudName: profileId,
            mirror: false,
          });
        } catch {
          // best-effort migration; reading the legacy value still
          // returns a correct result this round.
        }
      }
      return valid;
    }
    return 1;
  } catch {
    return 1;
  }
}

/** Persist the active IRK rotation version. Used by the webapp's
 *  Replace-device ceremony AFTER the server's complete leg has
 *  succeeded. */
export function setCurrentIrkVersion(version, profileId = activeProfileId()) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("irk version must be a positive integer");
  }
  const ls = globalThis.localStorage;
  if (!ls) return; // best-effort
  if (profileId !== DEFAULT_PROFILE_ID) {
    // Canonical: per-profile slot in profilesStore. mirror:false
    // suppresses the SLOT_FIELDS auto-mirror (which would write
    // `flagship.irk.version` — the DEFAULT-profile key — clobbering
    // the default profile's value with this named profile's version).
    try {
      profilesStore.set("currentIrkVersion", String(version), {
        storage: ls,
        cloudName: profileId,
        mirror: false,
      });
    } catch {
      // fall through to the legacy mirror so we don't drop the write.
    }
  }
  // Always also write the profile-specific legacy key. For the
  // default profile this is the canonical store. For named profiles
  // it's a backward-compat mirror so an old webapp tab reading the
  // suffix key directly stays consistent until it refreshes.
  const key = profileId === DEFAULT_PROFILE_ID
    ? "flagship.irk.version"
    : `flagship.irk.version.${profileId}`;
  ls.setItem(key, String(version));
}

export async function deriveIrkFromSeed(umkSeed) {
  return irkFromInfoSeed(umkSeed, irkInfo(currentIrkVersion()));
}

/** Derive the IRK at a specific rotation version. v1 == {@link
 *  deriveIrkFromSeed} (the registered key). A takeover rotates to the
 *  next version so the NEW device key signs the re-pair while the OLD
 *  (v1, currently-registered) key is what the swap displaces. */
export async function deriveIrkVersioned(umkSeed, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("irk version must be a positive integer");
  }
  return irkFromInfoSeed(umkSeed, irkInfo(version));
}

/**
 * Account Identity Key (AID) — the STABLE, NON-rotating account identity,
 * mirroring `deriveAccountId` in @flagship/protocol byte-for-byte (HKDF-SHA256
 * over the UMK seed under the FIXED info `flagship/account-id/v1`). Unlike the
 * IRK (versioned, rotates on re-pair / Wipe & restart), the AID is a pure
 * function of the UMK, so it survives every IRK rotation and is the right
 * identifier for service-access allow-lists + capability-invite bindings
 * (docs/service-access-gating.md). The friend signs the redeem + each visit
 * proof with this key; the author records it as the bound principal.
 *
 * Returns `{ privateKey: CryptoKey (sign), publicKey: Uint8Array(32) }`, the
 * same shape `deriveIrkFromSeed` returns.
 */
export async function deriveAccountIdFromSeed(umkSeed) {
  return irkFromInfoSeed(umkSeed, "flagship/account-id/v1");
}

/**
 * Household encryption key — a 32-byte symmetric AEAD key derived from the UMK
 * under the FIXED info `flagship/household-key/v1`, byte-identical to
 * `deriveHouseholdKey` in @flagship/protocol. Every device of the account (all
 * share the UMK) derives the same key, so it seals the capability-invite
 * `{ name, photo? }` bundle that flagshipserver.com only ever stores as
 * ciphertext (it holds no UMK → cannot read the friend's name/photo).
 *
 * Returns the raw 32 key bytes (not a CryptoKey) — lib/serviceInvite.js seals
 * with WebCrypto AES-256-GCM, whose ciphertext||tag layout matches the
 * @noble/ciphers GCM the protocol uses, so a bundle is openable on either side.
 */
export async function deriveHouseholdKeyFromSeed(umkSeed) {
  return hkdf32(umkSeed, "flagship/household-key/v1");
}

/**
 * Sign canonical-bytes with the account AID (stable). Mirrors `signWithIrk`
 * but uses {@link deriveAccountIdFromSeed} — the friend's redeem + visit
 * proofs are AID-signed (the IRK rotates; the AID does not).
 */
export async function signWithAccountId(umkSeed, canonicalBytes) {
  const aid = await deriveAccountIdFromSeed(umkSeed);
  return new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, aid.privateKey, canonicalBytes),
  );
}

export async function deriveBakFromSeed(umkSeed, serverId) {
  const seed = await hkdf32(umkSeed, `flagship.bak.v1|${serverId}`);
  const pkcs8 = pkcs8FromSeed(seed);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const jwkPub = await jwkPubFromSeed(seed);
  return { privateKey, publicKey: jwkPub };
}

async function jwkPubFromSeed(seed) {
  // Generate the keypair, immediately export the public part as raw bytes.
  // We do this by importing the seed as a JWK (after deriving x via curve math
  // on the private scalar). Browsers' WebCrypto Ed25519 implementations don't
  // expose a way to derive x from the seed without doing the curve-mul, so we
  // fall back to an in-process implementation: load the seed as PKCS8 keypair,
  // export-then-export.
  const kp = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8FromSeed(seed),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp);
  // The jwk.x is base64url of the public 32 bytes.
  if (typeof jwk.x !== "string") throw new Error("Ed25519 export missing x");
  return base64urlToBytes(jwk.x);
}

function base64urlToBytes(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Sign a canonical-bytes payload with the IRK derived from a seed. Mirrors
 * `signRebuildRequest` etc. in @flagship/protocol — callers compose the
 * canonical-bytes string in the same shape the server expects.
 */
export async function signWithIrk(umkSeed, canonicalBytes) {
  const irk = await deriveIrkFromSeed(umkSeed);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, irk.privateKey, canonicalBytes),
  );
  return sig;
}

/** Sign canonical-bytes with a SPECIFIC IRK rotation version. The
 *  re-pair-initiate envelope must be signed by the NEW IRK (the one the
 *  swap installs), so the takeover flow signs with the rotated version. */
export async function signWithIrkVersioned(umkSeed, version, canonicalBytes) {
  const irk = await deriveIrkVersioned(umkSeed, version);
  return new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, irk.privateKey, canonicalBytes),
  );
}

/**
 * Verify an Ed25519 signature over `canonicalBytes` under a raw 32-byte
 * public key. Used by the cross-device pairing incoming side to check a
 * `DeviceAdmit` vouch under the account's registered IRK pub (the admin
 * holds the matching private key). Returns false (never throws) on a bad
 * key / signature so callers can branch cleanly.
 *
 * @param {Uint8Array} pub             raw 32-byte Ed25519 public key
 * @param {Uint8Array} signature       64-byte Ed25519 signature
 * @param {Uint8Array} canonicalBytes  the signed pre-image
 * @returns {Promise<boolean>}
 */
export async function verifyWithEd25519Pub(pub, signature, canonicalBytes) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      pub,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, canonicalBytes);
  } catch {
    return false;
  }
}

/**
 * Generate an ephemeral X25519/ECDH pubkey the same way the dev/phone.html
 * dance does: P-256 ECDH, take the X coordinate as a 32-byte representative
 * pubkey. The control plane treats it as opaque bytes — we only need it for
 * the pairing handshake's wifiPskHash slot per the existing protocol.
 */
export async function generateEphemeralPub() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  // raw[0] = 0x04 (uncompressed marker); X coordinate is the next 32 bytes.
  return raw.slice(1, 33);
}

/* ---------- public surface ---------- */

export async function hasWrappedUmk(profileId = activeProfileId()) {
  return !!(await dbGet(wrappedUmkRecordKey(profileId)));
}

export async function bootstrapNewIdentity(passphrase, profileId = activeProfileId()) {
  if (await hasWrappedUmk(profileId)) throw new Error("device already has an identity");
  if (!passphrase || passphrase.length < 8) throw new Error("passphrase must be 8+ chars");
  const seed = randomBytes(32);
  const wrapped = await wrapUmk(passphrase, seed);
  await dbPut(wrappedUmkRecordKey(profileId), wrapped);
  return seed;
}

/**
 * Persist a recovered UMK seed under a fresh local passphrase. Used by
 * the cloud-recovery flow on a new browser: the WebAuthn-PRF unwrap
 * gives us back the original 32-byte seed, and we wrap it again
 * locally so subsequent unlocks can use the cheaper passphrase path
 * (avoiding a passkey prompt every time the user opens the webapp).
 */
export async function bootstrapFromExistingSeed(passphrase, seed, profileId = activeProfileId()) {
  if (await hasWrappedUmk(profileId)) throw new Error("device already has an identity");
  if (!passphrase || passphrase.length < 8) throw new Error("passphrase must be 8+ chars");
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("seed must be a 32-byte Uint8Array");
  }
  const wrapped = await wrapUmk(passphrase, seed);
  await dbPut(wrappedUmkRecordKey(profileId), wrapped);
}

export async function unlockUmk(passphrase, profileId = activeProfileId()) {
  const blob = await dbGet(wrappedUmkRecordKey(profileId));
  if (!blob) throw new Error("no identity on this device");
  return unwrapUmk(passphrase, blob);
}

export async function resetDevice(profileId = activeProfileId()) {
  await dbDel(wrappedUmkRecordKey(profileId));
  // Also drop any tier-1 PIN: a PIN-wrapped copy of the UMK would otherwise
  // survive a tier-2/tier-3 wipe and defeat the "erases the key" promise.
  // Dynamic import avoids a static keystore↔pinLock cycle; best-effort.
  try {
    const { clearPin } = await import("./lib/pinLock.js");
    await clearPin({ profileId });
  } catch {
    /* pinLock unavailable / no PIN — nothing to clear */
  }
  // Forget any held service-access "secured sessions" (the phone-held secretId
  // handles) — they're tied to this device's identity, so a device reset should
  // drop them too. Best-effort; dynamic import avoids a static cycle.
  try {
    const { clearSecuredSessions } = await import("./lib/securedSessions.js");
    clearSecuredSessions();
  } catch {
    /* securedSessions unavailable — nothing to clear */
  }
}

/** Persist a UMK seed under a SPECIFIC profile's record, scoping the
 *  keystore's active profile to that cloud as a side effect. Used by the
 *  ADD-profile flows (open-account, takeover) so a newly-bound profile's
 *  device key lands under ITS OWN record key — never clobbering another
 *  profile. Unlike {@link bootstrapFromExistingSeed}, this overwrites the
 *  named profile's own row if present (idempotent re-bind), but it can
 *  only ever touch the one profile it's pointed at.
 *
 *  @param {Uint8Array} seed       the 32-byte UMK seed
 *  @param {string} cloudName      the new profile's cloud handle
 *  @param {string} passphrase     local at-rest wrap passphrase (8+ chars)
 *  @returns {Promise<string>}     the profileId the seed was stored under
 */
export async function persistSeedForProfile(seed, cloudName, passphrase) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("seed must be a 32-byte Uint8Array");
  }
  if (!passphrase || passphrase.length < 8) {
    throw new Error("passphrase must be 8+ chars");
  }
  const profileId = setActiveKeystoreProfile(cloudName);
  const wrapped = await wrapUmk(passphrase, seed);
  await dbPut(wrappedUmkRecordKey(profileId), wrapped);
  return profileId;
}

export const _internal = {
  PBKDF2_ITERS,
  pkcs8FromSeed,
  hkdf32,
  wrapUmk,
  unwrapUmk,
  bytesToHex,
  hexToBytes,
  RECORD_KEY,
  DEFAULT_PROFILE_ID,
  wrappedUmkRecordKey,
  profileIdFromCloudName,
  activeProfileId,
  setActiveKeystoreProfile,
  // Test-only: read the in-process override (null when unset).
  getActiveProfileOverride: () => _activeProfileOverride,
};
