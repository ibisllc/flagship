// Flagship webapp keystore.
//
// Generates a UMK on first run, wraps it with PBKDF2(passphrase) → AES-GCM,
// stores the wrapped blob in IndexedDB. Exposes deriveIRK/BAK that mirror
// the canonical-bytes shapes the rest of Flagship uses (Ed25519 via the
// browser's WebCrypto subtle interface).
//
// IMPORTANT: this is software-only key storage. The Secure Enclave / StrongBox
// path is reserved for the native iOS / Android apps.

const DB_NAME = "flagship-webapp";
const DB_STORE = "keystore";
const RECORD_KEY = "wrappedUmk";

// PBKDF2 parameters. iters is intentionally high — this is a one-off
// per session and we want to make a brute-force on the IndexedDB blob expensive.
const PBKDF2_ITERS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const AES_NONCE_BYTES = 12;

/* ---------- IndexedDB helpers ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(DB_STORE);
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

export async function deriveIrkFromSeed(umkSeed) {
  return irkFromInfoSeed(umkSeed, irkInfo(1));
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

export async function hasWrappedUmk() {
  return !!(await dbGet(RECORD_KEY));
}

export async function bootstrapNewIdentity(passphrase) {
  if (await hasWrappedUmk()) throw new Error("device already has an identity");
  if (!passphrase || passphrase.length < 8) throw new Error("passphrase must be 8+ chars");
  const seed = randomBytes(32);
  const wrapped = await wrapUmk(passphrase, seed);
  await dbPut(RECORD_KEY, wrapped);
  return seed;
}

/**
 * Persist a recovered UMK seed under a fresh local passphrase. Used by
 * the cloud-recovery flow on a new browser: the WebAuthn-PRF unwrap
 * gives us back the original 32-byte seed, and we wrap it again
 * locally so subsequent unlocks can use the cheaper passphrase path
 * (avoiding a passkey prompt every time the user opens the webapp).
 */
export async function bootstrapFromExistingSeed(passphrase, seed) {
  if (await hasWrappedUmk()) throw new Error("device already has an identity");
  if (!passphrase || passphrase.length < 8) throw new Error("passphrase must be 8+ chars");
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("seed must be a 32-byte Uint8Array");
  }
  const wrapped = await wrapUmk(passphrase, seed);
  await dbPut(RECORD_KEY, wrapped);
}

export async function unlockUmk(passphrase) {
  const blob = await dbGet(RECORD_KEY);
  if (!blob) throw new Error("no identity on this device");
  return unwrapUmk(passphrase, blob);
}

export async function resetDevice() {
  await dbDel(RECORD_KEY);
}

export const _internal = {
  PBKDF2_ITERS,
  pkcs8FromSeed,
  hkdf32,
  wrapUmk,
  unwrapUmk,
  bytesToHex,
  hexToBytes,
};
