// Web/TS client mirror of packages/protocol/src/directoryKeyDelivery.ts.
//
// A RESTRICTED device holds only its own account-scoped Ed25519 device key
// (derived from the UMK via deriveAccountDeviceSeedFromSeed), NOT the account
// UMK, so it cannot derive the account-profile / device-directory keys itself.
// The admin seals a permitted directory key to this device's device pubkey and
// publishes an admin-root-signed AccountDirectoryKeyGrant; this module verifies
// that signature + the account/device binding BEFORE unsealing with the local
// device seed, then hands the recovered key to accountMetadata.decryptProfile.
//
// The canonical bytes + `|` order MUST match canonicalAccountDirectoryKeyGrant
// in @flagship/protocol byte-for-byte. Never throws — returns null on any
// defect (fail closed), matching the protocol's openAccountDirectoryKeyGrant.
import { verifyWithEd25519Pub, hexToBytes } from "../keystore.js";

const encoder = new TextEncoder();
const FLAGSHIP_SEAL_TAG = "flagship.seal.v1";
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_ANY = /^[0-9a-f]+$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;

/** Canonical bytes of an AccountDirectoryKeyGrant (mirror of the protocol). */
export function canonicalAccountDirectoryKeyGrant(grant) {
  if (!grant || typeof grant.accountId !== "string" || !grant.accountId || grant.accountId.includes("|")) {
    throw new Error("invalid directory key grant accountId");
  }
  if (!DEVICE_ID.test(grant.recipientDeviceId ?? "")) throw new Error("invalid recipientDeviceId");
  if (grant.keyKind !== "account-profile" && grant.keyKind !== "device-directory") {
    throw new Error("invalid directory key kind");
  }
  if (typeof grant.sealedKeyHex !== "string" || !HEX_ANY.test(grant.sealedKeyHex) || grant.sealedKeyHex.length < 2) {
    throw new Error("sealedKeyHex must be lowercase hex");
  }
  if (!HEX_64.test(grant.signerPubHex ?? "")) throw new Error("signerPubHex must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= grant.issuedAt) {
    throw new Error("directory key grant expiry must follow issuance");
  }
  return encoder.encode([
    "flagship/account-directory-key-grant/v1",
    grant.accountId.toLowerCase(),
    grant.recipientDeviceId,
    grant.keyKind,
    grant.sealedKeyHex,
    grant.issuedAt,
    grant.expiresAt,
    grant.signerPubHex,
  ].join("|"));
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

// DER prefix for an X25519 PKCS#8 PrivateKeyInfo wrapping a 32-byte scalar.
// Some WebCrypto runtimes (e.g. Node) reject a raw X25519 PRIVATE key import
// but accept PKCS#8; browsers accept raw. We try raw first, then fall back.
const X25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
  0x04, 0x22, 0x04, 0x20,
]);

async function importX25519Private(scalar) {
  try {
    return await crypto.subtle.importKey("raw", scalar, "X25519", false, ["deriveBits"]);
  } catch {
    const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + 32);
    pkcs8.set(X25519_PKCS8_PREFIX, 0);
    pkcs8.set(scalar, X25519_PKCS8_PREFIX.length);
    return crypto.subtle.importKey("pkcs8", pkcs8, "X25519", false, ["deriveBits"]);
  }
}

async function hkdfSeal(sharedBits, ephPub) {
  const sharedKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ephPub, info: encoder.encode(FLAGSHIP_SEAL_TAG) },
    sharedKey,
    256,
  ));
}

/**
 * Open a blob sealed FOR this device (sealForEd25519Recipient) with the
 * device's 32-byte Ed25519 SEED. Blob: [ephX25519Pub:32][nonce:12][ct+tag].
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
 * RECIPIENT side. Verify the admin-root signature + the account/device binding
 * (+ expiry if `now` supplied) then unseal the delivered directory key with the
 * local device seed. Returns the 32-byte key, or null on ANY defect. Never
 * throws.
 *
 * @param {object}     grant                 the AccountDirectoryKeyGrant record
 * @param {string}     signatureHex          admin-root Ed25519 signature (hex)
 * @param {Uint8Array} adminRootPub          the account's pinned admin-root pub
 * @param {string}     expectedAccountId     this account id
 * @param {string}     expectedRecipientDeviceId  this device id
 * @param {Uint8Array} recipientDeviceSeed   this device's Ed25519 seed (32 B)
 * @param {number}    [now]                  optional wall clock (ms) for expiry
 * @returns {Promise<Uint8Array|null>}
 */
export async function openAccountDirectoryKeyGrant({
  grant,
  signatureHex,
  adminRootPub,
  expectedAccountId,
  expectedRecipientDeviceId,
  recipientDeviceSeed,
  now,
}) {
  try {
    if (!grant || typeof expectedAccountId !== "string" || typeof expectedRecipientDeviceId !== "string") return null;
    if (grant.accountId?.toLowerCase() !== expectedAccountId.toLowerCase()) return null;
    if (grant.recipientDeviceId !== expectedRecipientDeviceId.toLowerCase()) return null;
    if (typeof now === "number" && (now < grant.issuedAt || now >= grant.expiresAt)) return null;
    let canonical;
    try {
      canonical = canonicalAccountDirectoryKeyGrant(grant);
    } catch {
      return null;
    }
    const ok = await verifyWithEd25519Pub(adminRootPub, hexToBytes(signatureHex), canonical);
    if (!ok) return null;
    const key = await openSealedWithEd25519Seed(hexToBytes(grant.sealedKeyHex), recipientDeviceSeed);
    if (key.length !== 32) return null;
    return key;
  } catch {
    return null;
  }
}
