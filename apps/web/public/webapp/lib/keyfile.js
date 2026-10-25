// `.flagshipkey` — passphrase-wrapped, portable backup of the User Master Key.
//
// This is the webapp's PRIMARY backup / recovery / cross-device path: the
// browser has no Keychain or iCloud to lean on, so a downloadable encrypted
// key-file is the iCloud stand-in. The 32-byte UMK seed IS the whole account
// (IRK/BAK/SWK/STK all HKDF-derive from it — keystore.js), so anyone holding
// the file AND the passphrase can fully take over the account. Surfaces MUST
// wrap export in heavy warnings and never auto-sync this file anywhere.
//
// Byte-compatible with packages/protocol/src/keyfile.ts and the iOS keyfile
// implementation. The format, AAD canonical string, argon2id KDF, and
// AES-256-GCM AEAD must stay identical so a file written by any surface
// unwraps on every other surface. There is an interop test
// (apps/web/tests/keyfile.test.ts) that asserts a golden file decrypts here.
//
// Crypto:
//   - KDF: argon2id (vendored @noble/hashes — WebCrypto has no argon2).
//     input = UTF8(passphrase); salt = file kdf.saltHex; m/t/p from file;
//     dkLen = 32.
//   - AEAD: AES-256-GCM via crypto.subtle. WebCrypto appends the 16-byte tag
//     to the ciphertext, which is exactly what ciphertextHex carries.
//   - AAD: a canonical UTF8 header string (see aadBytes) bound into the GCM
//     additionalData, so tampering any header field fails decryption.

import { argon2id } from "../vendor/noble-hashes/argon2.js";
import { bytesToHex, hexToBytes } from "../keystore.js";

import { tr } from "./i18n.js";
export const KEYFILE_MAGIC = "flagship-key";
export const KEYFILE_VERSION = 1;
/** v2 wraps the whole local account: the UMK seed, the admin root seed and the server records
 *  (docs/data-sovereignty.md 4.11). Opened here so a key file a phone exported opens in the
 *  webapp too; the webapp itself still writes v1. */
export const KEYFILE_VERSION_ACCOUNT = 2;

/** Strong interactive default. Recorded in-file so a future version can raise
 *  it and old files still unwrap with their own recorded params. */
export const KEYFILE_ARGON_PARAMS = { m: 65536, t: 3, p: 4 };

/** Floor only — the UI enforces real passphrase strength. */
export const KEYFILE_MIN_PASSPHRASE = 8;

export class KeyfileError extends Error {
  /** @param {string} message @param {"malformed"|"bad-passphrase"|"version"} code */
  constructor(message, code) {
    super(message);
    this.name = "KeyfileError";
    this.code = code;
  }
}

/** Canonical AAD binding the human-meaningful header to the ciphertext. Must
 *  match packages/protocol/src/keyfile.ts aadBytes() byte-for-byte. */
function aadBytes(env) {
  const k = env.kdf;
  const s = [
    "flagship/keyfile/v1",
    String(env.version),
    env.username,
    env.accountId ?? "",
    env.createdAt,
    `${k.algo}|m=${k.m}|t=${k.t}|p=${k.p}`,
    env.aead,
  ].join("|");
  return new TextEncoder().encode(s);
}

function deriveKey(passphrase, salt, p) {
  return argon2id(new TextEncoder().encode(passphrase), salt, {
    m: p.m,
    t: p.t,
    p: p.p,
    dkLen: 32,
  });
}

async function aesGcmEncrypt(keyBytes, nonce, aad, plaintext) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext),
  );
}

async function aesGcmDecrypt(keyBytes, nonce, aad, ciphertext) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, ciphertext),
  );
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Wrap a 32-byte UMK seed into `.flagshipkey` text.
 *
 * @param {Uint8Array} seed                 the 32-byte UMK seed
 * @param {string} passphrase               wrap passphrase (>= KEYFILE_MIN_PASSPHRASE)
 * @param {{username:string, accountId?:string, createdAt?:string}} meta
 * @param {{m:number,t:number,p:number}} [argonParams]  injectable for tests
 * @returns {Promise<string>}               the JSON file text (trailing \n)
 */
export async function wrapUmkToKeyfile(seed, passphrase, meta, argonParams = KEYFILE_ARGON_PARAMS) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new KeyfileError(tr("UMK seed must be 32 bytes"), "malformed");
  }
  if (typeof passphrase !== "string" || passphrase.length < KEYFILE_MIN_PASSPHRASE) {
    throw new KeyfileError(`passphrase too short (min ${KEYFILE_MIN_PASSPHRASE})`, "malformed");
  }
  if (!meta || typeof meta.username !== "string" || !meta.username) {
    throw new KeyfileError("username required", "malformed");
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const createdAt = meta.createdAt ?? new Date().toISOString();
  const kdf = {
    algo: "argon2id",
    m: argonParams.m,
    t: argonParams.t,
    p: argonParams.p,
    saltHex: bytesToHex(salt),
  };
  const header = {
    version: KEYFILE_VERSION,
    username: meta.username,
    ...(meta.accountId !== undefined ? { accountId: meta.accountId } : {}),
    createdAt,
    kdf,
    aead: "aes-256-gcm",
  };
  const key = deriveKey(passphrase, salt, argonParams);
  const ct = await aesGcmEncrypt(key, nonce, aadBytes(header), seed);
  const env = {
    magic: KEYFILE_MAGIC,
    ...header,
    nonceHex: bytesToHex(nonce),
    ciphertextHex: bytesToHex(ct),
  };
  return `${JSON.stringify(env, null, 2)}\n`;
}

/**
 * Parse + decrypt a `.flagshipkey` file. Throws KeyfileError on any failure:
 *   - "malformed" : not a flagship key file / bad shape
 *   - "version"   : unsupported file version
 *   - "bad-passphrase" : wrong passphrase or tampered/corrupted file
 *
 * @param {string} fileText
 * @param {string} passphrase
 * @returns {Promise<{ seed: Uint8Array, meta: {username:string, accountId?:string, createdAt:string} }>}
 */
export async function unwrapUmkFromKeyfile(fileText, passphrase) {
  let env;
  try {
    env = JSON.parse(fileText);
  } catch {
    throw new KeyfileError("not valid JSON", "malformed");
  }
  if (!env || typeof env !== "object" || env.magic !== KEYFILE_MAGIC) {
    throw new KeyfileError("not a flagship key file", "malformed");
  }
  if (env.version === KEYFILE_VERSION_ACCOUNT) {
    const a = await unwrapAccountFromKeyfile(fileText, passphrase);
    return { seed: a.seed, meta: a.meta };
  }
  if (env.version !== KEYFILE_VERSION) {
    throw new KeyfileError(`unsupported version ${env.version}`, "version");
  }
  if (!env.kdf || env.kdf.algo !== "argon2id" || env.aead !== "aes-256-gcm") {
    throw new KeyfileError("unsupported kdf/aead", "malformed");
  }
  if (
    typeof env.kdf.saltHex !== "string" ||
    typeof env.nonceHex !== "string" ||
    typeof env.ciphertextHex !== "string" ||
    typeof env.username !== "string" ||
    typeof env.createdAt !== "string"
  ) {
    throw new KeyfileError("missing required fields", "malformed");
  }
  const salt = hexToBytes(env.kdf.saltHex);
  const nonce = hexToBytes(env.nonceHex);
  const ct = hexToBytes(env.ciphertextHex);
  const key = deriveKey(passphrase, salt, env.kdf);
  let seed;
  try {
    seed = await aesGcmDecrypt(key, nonce, aadBytes(env), ct);
  } catch {
    throw new KeyfileError("wrong passphrase or corrupted/tampered file", "bad-passphrase");
  }
  if (seed.length !== 32) {
    throw new KeyfileError("decrypted seed is not 32 bytes", "malformed");
  }
  return {
    seed,
    meta: {
      username: env.username,
      ...(env.accountId !== undefined ? { accountId: env.accountId } : {}),
      createdAt: env.createdAt,
    },
  };
}

const HEX32 = /^[0-9a-f]{64}$/;

function parseServers(v) {
  if (!Array.isArray(v) || v.length > 64) throw new KeyfileError("malformed server list", "malformed");
  return v.map((x) => {
    if (typeof x?.domain !== "string" || x.domain.length === 0 || x.domain.length > 253 || /[|\s]/.test(x.domain)) {
      throw new KeyfileError("malformed server record", "malformed");
    }
    if (x.stk !== undefined && (typeof x.stk !== "string" || !HEX32.test(x.stk))) throw new KeyfileError("malformed server key", "malformed");
    const lan = Array.isArray(x.lan) ? x.lan.filter((a) => typeof a === "string" && a.length <= 64).slice(0, 8) : [];
    return { domain: x.domain.toLowerCase(), ...(lan.length > 0 ? { lan } : {}), ...(typeof x.stk === "string" ? { stk: x.stk } : {}) };
  });
}

/**
 * Open a v1 or v2 `.flagshipkey`. A v1 file yields the UMK seed and no admin root or servers.
 *
 * @returns {Promise<{ seed: Uint8Array, adminRootSeed?: Uint8Array, servers: Array<{domain:string, lan?:string[], stk?:string}>, meta: {username:string, accountId?:string, createdAt:string} }>}
 */
export async function unwrapAccountFromKeyfile(fileText, passphrase) {
  let env;
  try {
    env = JSON.parse(fileText);
  } catch {
    throw new KeyfileError("not valid JSON", "malformed");
  }
  if (!env || typeof env !== "object" || env.magic !== KEYFILE_MAGIC) throw new KeyfileError("not a flagship key file", "malformed");
  if (env.version === KEYFILE_VERSION) {
    const { seed, meta } = await unwrapUmkFromKeyfile(fileText, passphrase);
    return { seed, servers: [], meta };
  }
  if (env.version !== KEYFILE_VERSION_ACCOUNT) throw new KeyfileError(`unsupported version ${env.version}`, "version");
  if (!env.kdf || env.kdf.algo !== "argon2id" || env.aead !== "aes-256-gcm") throw new KeyfileError("unsupported kdf/aead", "malformed");
  if (typeof env.kdf.saltHex !== "string" || typeof env.nonceHex !== "string" || typeof env.ciphertextHex !== "string" || typeof env.username !== "string" || typeof env.createdAt !== "string") {
    throw new KeyfileError("missing required fields", "malformed");
  }
  let plain;
  try {
    plain = await aesGcmDecrypt(deriveKey(passphrase, hexToBytes(env.kdf.saltHex), env.kdf), hexToBytes(env.nonceHex), aadBytes(env), hexToBytes(env.ciphertextHex));
  } catch {
    throw new KeyfileError("wrong passphrase or corrupted/tampered file", "bad-passphrase");
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new KeyfileError("the account inside is damaged", "malformed");
  }
  const key = (v) => {
    if (typeof v !== "string" || !HEX32.test(v)) throw new KeyfileError("a key inside is not 32 bytes", "malformed");
    return hexToBytes(v);
  };
  const seed = key(body?.umkSeedHex);
  const adminRootSeed = body?.adminRootSeedHex === undefined ? undefined : key(body.adminRootSeedHex);
  return {
    seed,
    ...(adminRootSeed ? { adminRootSeed } : {}),
    servers: parseServers(body?.servers ?? []),
    meta: { username: env.username, ...(env.accountId !== undefined ? { accountId: env.accountId } : {}), createdAt: env.createdAt },
  };
}
