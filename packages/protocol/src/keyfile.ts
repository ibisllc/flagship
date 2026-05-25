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
