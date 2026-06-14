// Tier-1 "Lock with PIN code" — webapp only.
//
// The native apps gate the tier-1 lock behind biometrics (Face ID /
// fingerprint), released by the Secure Enclave / StrongBox. A browser has
// neither, so the webapp's tier-1 lock is a numeric PIN.
//
// THREAT MODEL (important — a PIN is low-entropy):
//   - This defends the CASUAL threat: "someone grabbed my unlocked tab."
//     It is NOT a defence against device theft + forensic disk access —
//     that's tier-2 ("Lock with passkey", which wipes the key) + OS disk
//     encryption. We never claim otherwise.
//   - The wrapped UMK persists in IndexedDB so you can lock/unlock
//     repeatedly. To stop an attacker who copies that blob off disk from
//     brute-forcing the PIN offline, the wrap key is bound to a
//     NON-EXTRACTABLE WebCrypto key (the "device pepper"): a guess can only
//     be checked by computing HMAC under that key, which can't be done off
//     the origin — so brute force must run in-origin, where the 5-try
//     lockout (→ fall back to passphrase) bites. It is a speed bump, not a
//     hardware enclave.
//
// THE PASSPHRASE IS THE REAL KEY. Any unlock through the full passphrase
// (chosen "use passphrase instead", a forgotten PIN, or tripping the
// lockout) CLEARS the PIN — see views/unlock.js. The PIN is pure
// convenience layered on top of the passphrase-wrapped UMK, which is
// untouched.

import { argon2id } from "../vendor/noble-hashes/argon2.js";
import {
  kvGet,
  kvPut,
  kvDel,
  activeProfileId,
  bytesToHex,
  hexToBytes,
} from "../keystore.js";

export const MIN_PIN_LEN = 4;
export const MAX_PIN_LEN = 6;
export const MAX_ATTEMPTS = 5;

// argon2id stretch params (OWASP-minimum class). The pepper is the primary
// defence; this just makes each in-origin guess non-trivial.
const ARGON2 = { m: 19_456, t: 2, p: 1, dkLen: 32 };
const AES_NONCE_BYTES = 12;
const PIN_SALT_BYTES = 16;

// Device-wide non-extractable HMAC key (the pepper source). One per
// browser profile DB; shared by every cloud profile's PIN.
const DEVICE_KEY_RECORD = "pinDeviceKey";
const PEPPER_LABEL = "flagship/pin-pepper/v1";
const WRAP_INFO = "flagship/pin-wrap/v1";

function pinRecordKey(profileId) {
  return `pinWrap.${profileId}`;
}
function pinAttemptsKey(profileId) {
  return `pinAttempts.${profileId}`;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Validate a PIN: numeric, MIN_PIN_LEN..MAX_PIN_LEN digits. */
export function isValidPin(pin) {
  return (
    typeof pin === "string" &&
    /^[0-9]+$/.test(pin) &&
    pin.length >= MIN_PIN_LEN &&
    pin.length <= MAX_PIN_LEN
  );
}

/* ---------- device pepper (non-extractable) ---------- */

async function deviceKeyHandle() {
  let k = await kvGet(DEVICE_KEY_RECORD);
  if (!k) {
    // extractable=false ⇒ the key bytes are never readable by JS, so an
    // attacker with the IndexedDB blob still cannot compute the pepper
    // off-origin.
    k = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    await kvPut(DEVICE_KEY_RECORD, k);
  }
  return k;
}

async function devicePepper() {
  const k = await deviceKeyHandle();
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(PEPPER_LABEL));
  return new Uint8Array(sig);
}

/* ---------- PIN wrap / unwrap (pure given the pepper) ---------- */

async function hkdfSalted(ikm, salt, info) {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function pinWrapKey(pin, salt, pepper) {
  const stretched = argon2id(new TextEncoder().encode(pin), salt, ARGON2);
  // pepper is the HKDF salt: without it (non-extractable) the wrap key is
  // uncomputable, so PIN guesses can't be verified offline.
  const raw = await hkdfSalted(stretched, pepper, WRAP_INFO);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function wrapSeed(pin, seed, pepper) {
  const salt = randomBytes(PIN_SALT_BYTES);
  const nonce = randomBytes(AES_NONCE_BYTES);
  const key = await pinWrapKey(pin, salt, pepper);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, seed));
  return { v: 1, salt: bytesToHex(salt), nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}

async function unwrapSeed(pin, blob, pepper) {
  const key = await pinWrapKey(pin, hexToBytes(blob.salt), pepper);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(blob.nonce) },
    key,
    hexToBytes(blob.ct),
  );
  return new Uint8Array(pt);
}

/* ---------- dependency seam (production defaults; tests inject) ---------- */

function resolveDeps(deps = {}) {
  return {
    kv: deps.kv ?? { get: kvGet, put: kvPut, del: kvDel },
    pepper: deps.pepper ?? devicePepper,
    profileId: deps.profileId ?? activeProfileId(),
  };
}

async function pepperBytes(d) {
  return typeof d.pepper === "function" ? await d.pepper() : d.pepper;
}

/* ---------- public API ---------- */

/** Is a PIN currently set for the active (or given) profile? */
export async function hasPin(deps) {
  const d = resolveDeps(deps);
  return !!(await d.kv.get(pinRecordKey(d.profileId)));
}

/** Wrap `seed` (the 32-byte UMK) under `pin` + device pepper and persist
 *  it. Resets the attempt counter. Caller must already be unlocked. */
export async function setPin(pin, seed, deps) {
  if (!isValidPin(pin)) throw new Error(`PIN must be ${MIN_PIN_LEN}–${MAX_PIN_LEN} digits`);
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("seed must be a 32-byte Uint8Array");
  }
  const d = resolveDeps(deps);
  const blob = await wrapSeed(pin, seed, await pepperBytes(d));
  await d.kv.put(pinRecordKey(d.profileId), blob);
  await d.kv.del(pinAttemptsKey(d.profileId));
}

/** Check a PIN without unlocking or touching the lockout counter. Used by
 *  the Change-PIN flow to require the current PIN first. */
export async function verifyPin(pin, deps) {
  const d = resolveDeps(deps);
  const blob = await d.kv.get(pinRecordKey(d.profileId));
  if (!blob) return false;
  try {
    await unwrapSeed(pin, blob, await pepperBytes(d));
    return true;
  } catch {
    return false;
  }
}

/** Remaining PIN attempts before the lockout wipes the PIN. */
export async function remainingAttempts(deps) {
  const d = resolveDeps(deps);
  const n = (await d.kv.get(pinAttemptsKey(d.profileId))) ?? 0;
  return Math.max(0, MAX_ATTEMPTS - n);
}

/** Unlock with a PIN. Returns the 32-byte seed on success (and resets the
 *  counter). On a wrong PIN, increments the counter and throws:
 *    - `{ remaining: N }` while tries remain, or
 *    - `{ lockedOut: true }` once exhausted — at which point the PIN is
 *      WIPED and the user must fall back to the passphrase. */
export async function unlockWithPin(pin, deps) {
  const d = resolveDeps(deps);
  const blob = await d.kv.get(pinRecordKey(d.profileId));
  if (!blob) throw { noPin: true };
  let seed;
  try {
    seed = await unwrapSeed(pin, blob, await pepperBytes(d));
  } catch {
    const n = ((await d.kv.get(pinAttemptsKey(d.profileId))) ?? 0) + 1;
    if (n >= MAX_ATTEMPTS) {
      await clearPin(deps);
      throw { lockedOut: true };
    }
    await d.kv.put(pinAttemptsKey(d.profileId), n);
    throw { remaining: MAX_ATTEMPTS - n };
  }
  await d.kv.del(pinAttemptsKey(d.profileId));
  return seed;
}

/** Remove the PIN (and its counter) for the active (or given) profile. The
 *  device pepper key is intentionally KEPT — it's reused if a new PIN is
 *  set. Called on every passphrase unlock (the reset rule) and on lockout. */
export async function clearPin(deps) {
  const d = resolveDeps(deps);
  await d.kv.del(pinRecordKey(d.profileId));
  await d.kv.del(pinAttemptsKey(d.profileId));
}

export const _internal = { wrapSeed, unwrapSeed, devicePepper, ARGON2 };
