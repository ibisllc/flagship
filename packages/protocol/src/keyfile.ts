import { argon2id } from "@noble/hashes/argon2";
import { gcm } from "@noble/ciphers/aes";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { Bytes, UserMasterKey } from "./types.js";

/**
 * `.flagshipkey` — a passphrase-wrapped, portable backup of the User Master Key.
 *
 * The UMK seed (32 bytes) is the ENTIRE account: IRK/BAK/SWK/STK all HKDF-derive
 * from it (keys.ts). This file is therefore the keys to the kingdom — anyone with
 * the file AND the passphrase can fully control the account and every server. It
 * is the cloud-independent recovery + cross-device + webapp-backup path (the
 * iCloud stand-in for surfaces with no Keychain). Surfaces MUST wrap export in
 * heavy warnings and never auto-sync this file anywhere.
 *
 * Format: JSON, binary fields hex. A self-describing header is bound into the
 * AES-256-GCM AAD, so tampering any header field (username, version, kdf params)
 * fails decryption. The argon2id-derived key (params recorded in-file so they
 * can be raised later without breaking old files) wraps the 32-byte seed.
 */

export const KEYFILE_MAGIC = "flagship-key";
export const KEYFILE_VERSION = 1;
/**
 * Version 2 (docs/data-sovereignty.md) wraps the whole local account, not just
 * the UMK: the UMK seed, the ADMIN ROOT seed (random, not derived from the
 * UMK, so a UMK alone can never rebuild it) and the cached server records
 * the rescue flow starts from. Everything the owner's phone needs to save its
 * servers' data with no help from `.com`, on a fresh install.
 */
export const KEYFILE_VERSION_ACCOUNT = 2;

export interface ArgonParams {
  /** memory in KiB */ m: number;
  /** iterations */ t: number;
  /** parallelism */ p: number;
}

/**
 * Strong interactive default. Recorded in the file so a future version can raise
 * it and old files still unwrap with their own recorded params. Injectable for
 * tests (real argon2id at this size is ~0.5–1s).
 */
export const KEYFILE_ARGON_PARAMS: ArgonParams = { m: 65536, t: 3, p: 4 };

/** Floor only — surfaces enforce real passphrase strength in the UI. */
export const KEYFILE_MIN_PASSPHRASE = 8;

export interface KeyfileMeta {
  username: string;
  accountId?: string;
  /** ISO-8601 */ createdAt: string;
}

interface KeyfileEnvelope extends KeyfileMeta {
  magic: string;
  version: number;
  kdf: { algo: "argon2id"; m: number; t: number; p: number; saltHex: string };
  aead: "aes-256-gcm";
  nonceHex: string;
  ciphertextHex: string;
}

export class KeyfileError extends Error {
  constructor(
    message: string,
    readonly code: "malformed" | "bad-passphrase" | "version",
  ) {
    super(message);
    this.name = "KeyfileError";
  }
}

/** Canonical AAD binding the human-meaningful header to the ciphertext. */
function aadBytes(env: {
  version: number;
  username: string;
  accountId?: string;
  createdAt: string;
  kdf: { algo: string; m: number; t: number; p: number };
  aead: string;
}): Bytes {
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

function deriveKey(passphrase: string, salt: Bytes, p: ArgonParams): Bytes {
  return argon2id(new TextEncoder().encode(passphrase), salt, {
    m: p.m,
    t: p.t,
    p: p.p,
    dkLen: 32,
  });
}

/**
 * Wrap a UMK into `.flagshipkey` text. `argonParams` is injectable for tests;
 * production callers should omit it (defaults to the strong profile).
 */
export function wrapUmkToKeyfile(
  umk: UserMasterKey,
  passphrase: string,
  meta: KeyfileMeta,
  argonParams: ArgonParams = KEYFILE_ARGON_PARAMS,
): string {
  if (umk.seed.length !== 32) {
    throw new KeyfileError("UMK seed must be 32 bytes", "malformed");
  }
  if (passphrase.length < KEYFILE_MIN_PASSPHRASE) {
    throw new KeyfileError(
      `passphrase too short (min ${KEYFILE_MIN_PASSPHRASE})`,
      "malformed",
    );
  }
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const kdf = {
    algo: "argon2id" as const,
    m: argonParams.m,
    t: argonParams.t,
    p: argonParams.p,
    saltHex: bytesToHex(salt),
  };
  const header = {
    version: KEYFILE_VERSION,
    username: meta.username,
    ...(meta.accountId !== undefined ? { accountId: meta.accountId } : {}),
    createdAt: meta.createdAt,
    kdf,
    aead: "aes-256-gcm" as const,
  };
  const key = deriveKey(passphrase, salt, argonParams);
  const ct = gcm(key, nonce, aadBytes(header)).encrypt(umk.seed);
  const env: KeyfileEnvelope = {
    magic: KEYFILE_MAGIC,
    ...header,
    nonceHex: bytesToHex(nonce),
    ciphertextHex: bytesToHex(ct),
  };
  return `${JSON.stringify(env, null, 2)}\n`;
}

/** Parse + decrypt a `.flagshipkey` file. Throws KeyfileError on any failure. */
export function unwrapUmkFromKeyfile(
  fileText: string,
  passphrase: string,
): { umk: UserMasterKey; meta: KeyfileMeta } {
  let env: KeyfileEnvelope;
  try {
    env = JSON.parse(fileText) as KeyfileEnvelope;
  } catch {
    throw new KeyfileError("not valid JSON", "malformed");
  }
  if (!env || typeof env !== "object" || env.magic !== KEYFILE_MAGIC) {
    throw new KeyfileError("not a flagship key file", "malformed");
  }
  if (env.version === KEYFILE_VERSION_ACCOUNT) {
    const a = unwrapAccountFromKeyfile(fileText, passphrase);
    return { umk: a.umk, meta: a.meta };
  }
  if (env.version !== KEYFILE_VERSION) {
    throw new KeyfileError(`unsupported version ${env.version}`, "version");
  }
  if (!env.kdf || env.kdf.algo !== "argon2id" || env.aead !== "aes-256-gcm") {
    throw new KeyfileError("unsupported kdf/aead", "malformed");
  }
  const salt = hexToBytes(env.kdf.saltHex);
  const nonce = hexToBytes(env.nonceHex);
  const ct = hexToBytes(env.ciphertextHex);
  const key = deriveKey(passphrase, salt, env.kdf);
  let seed: Bytes;
  try {
    seed = gcm(key, nonce, aadBytes(env)).decrypt(ct);
  } catch {
    throw new KeyfileError("wrong passphrase or corrupted/tampered file", "bad-passphrase");
  }
  if (seed.length !== 32) {
    throw new KeyfileError("decrypted seed is not 32 bytes", "malformed");
  }
  return {
    umk: { seed },
    meta: {
      username: env.username,
      ...(env.accountId !== undefined ? { accountId: env.accountId } : {}),
      createdAt: env.createdAt,
    },
  };
}

/** What the rescue flow needs to know about one server with `.com` gone (docs/data-sovereignty.md). */
export interface KeyfileServer {
  /** The server's FQDN: the one thing nothing else can reconstruct. */
  domain: string;
  /** Where it was last seen on a local network (`10.0.0.5:443`), newest first. A hint, never trusted. */
  lan?: string[];
}

/** The whole local account as a v2 keyfile carries it. */
export interface KeyfileAccount {
  umk: UserMasterKey;
  /** The 32-byte admin root seed, when this device holds it. */
  adminRootSeed?: Bytes;
  servers: KeyfileServer[];
}

const MAX_KEYFILE_SERVERS = 64;

function parseServers(v: unknown): KeyfileServer[] {
  if (!Array.isArray(v) || v.length > MAX_KEYFILE_SERVERS) throw new KeyfileError("malformed server list", "malformed");
  return v.map((x) => {
    const r = x as { domain?: unknown; lan?: unknown };
    if (typeof r?.domain !== "string" || r.domain.length === 0 || r.domain.length > 253 || /[|\s]/.test(r.domain)) {
      throw new KeyfileError("malformed server record", "malformed");
    }
    const lan = Array.isArray(r.lan) ? r.lan.filter((a): a is string => typeof a === "string" && a.length <= 64).slice(0, 8) : undefined;
    return { domain: r.domain.toLowerCase(), ...(lan && lan.length > 0 ? { lan } : {}) };
  });
}

/** Wrap the whole local account into a v2 `.flagshipkey`. */
export function wrapAccountToKeyfile(
  account: KeyfileAccount,
  passphrase: string,
  meta: KeyfileMeta,
  argonParams: ArgonParams = KEYFILE_ARGON_PARAMS,
): string {
  if (account.umk.seed.length !== 32) throw new KeyfileError("UMK seed must be 32 bytes", "malformed");
  if (account.adminRootSeed && account.adminRootSeed.length !== 32) throw new KeyfileError("admin root seed must be 32 bytes", "malformed");
  if (passphrase.length < KEYFILE_MIN_PASSPHRASE) throw new KeyfileError(`passphrase too short (min ${KEYFILE_MIN_PASSPHRASE})`, "malformed");
  const servers = parseServers(account.servers);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const kdf = { algo: "argon2id" as const, m: argonParams.m, t: argonParams.t, p: argonParams.p, saltHex: bytesToHex(salt) };
  const header = {
    version: KEYFILE_VERSION_ACCOUNT,
    username: meta.username,
    ...(meta.accountId !== undefined ? { accountId: meta.accountId } : {}),
    createdAt: meta.createdAt,
    kdf,
    aead: "aes-256-gcm" as const,
  };
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      umkSeedHex: bytesToHex(account.umk.seed),
      ...(account.adminRootSeed ? { adminRootSeedHex: bytesToHex(account.adminRootSeed) } : {}),
      servers,
    }),
  );
  const ct = gcm(deriveKey(passphrase, salt, argonParams), nonce, aadBytes(header)).encrypt(plaintext);
  const env: KeyfileEnvelope = { magic: KEYFILE_MAGIC, ...header, nonceHex: bytesToHex(nonce), ciphertextHex: bytesToHex(ct) };
  return `${JSON.stringify(env, null, 2)}\n`;
}

/** Unwrap a v2 `.flagshipkey`. A v1 file yields the UMK and no admin root or servers. */
export function unwrapAccountFromKeyfile(fileText: string, passphrase: string): { account: KeyfileAccount; umk: UserMasterKey; meta: KeyfileMeta } {
  let env: KeyfileEnvelope;
  try {
    env = JSON.parse(fileText) as KeyfileEnvelope;
  } catch {
    throw new KeyfileError("not valid JSON", "malformed");
  }
  if (!env || typeof env !== "object" || env.magic !== KEYFILE_MAGIC) throw new KeyfileError("not a flagship key file", "malformed");
  if (env.version === KEYFILE_VERSION) {
    const { umk, meta } = unwrapUmkFromKeyfile(fileText, passphrase);
    return { account: { umk, servers: [] }, umk, meta };
  }
  if (env.version !== KEYFILE_VERSION_ACCOUNT) throw new KeyfileError(`unsupported version ${env.version}`, "version");
  if (!env.kdf || env.kdf.algo !== "argon2id" || env.aead !== "aes-256-gcm") throw new KeyfileError("unsupported kdf/aead", "malformed");
  let plain: Bytes;
  try {
    plain = gcm(deriveKey(passphrase, hexToBytes(env.kdf.saltHex), env.kdf), hexToBytes(env.nonceHex), aadBytes(env)).decrypt(hexToBytes(env.ciphertextHex));
  } catch {
    throw new KeyfileError("wrong passphrase or corrupted/tampered file", "bad-passphrase");
  }
  let body: { umkSeedHex?: unknown; adminRootSeedHex?: unknown; servers?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(plain)) as typeof body;
  } catch {
    throw new KeyfileError("the account inside is damaged", "malformed");
  }
  const hex32 = (v: unknown): Bytes => {
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new KeyfileError("a key inside is not 32 bytes", "malformed");
    return hexToBytes(v);
  };
  const umk = { seed: hex32(body.umkSeedHex) };
  const adminRootSeed = body.adminRootSeedHex === undefined ? undefined : hex32(body.adminRootSeedHex);
  const meta: KeyfileMeta = { username: env.username, ...(env.accountId !== undefined ? { accountId: env.accountId } : {}), createdAt: env.createdAt };
  return { account: { umk, ...(adminRootSeed ? { adminRootSeed } : {}), servers: parseServers(body.servers ?? []) }, umk, meta };
}
