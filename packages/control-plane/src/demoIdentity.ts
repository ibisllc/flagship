import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { deriveAccountId, deriveIRK, ed, type Keypair } from "@flagship/protocol";
import { bytesToHex } from "./hex.js";

const USER_SALT = "flagship-demo-irk-v1";
const DEVICE_SALT = "flagship-demo-device-irk-v1";

function deriveIkm(kek: Uint8Array, username: string): Uint8Array {
  const suffix = new TextEncoder().encode(`:${username.toLowerCase()}`);
  const input = new Uint8Array(kek.length + suffix.length);
  input.set(kek);
  input.set(suffix, kek.length);
  return sha256(input);
}

function deriveSeed(
  kek: Uint8Array,
  username: string,
  salt: string,
  info: string,
): Uint8Array {
  return hkdf(
    sha256,
    deriveIkm(kek, username),
    new TextEncoder().encode(salt),
    new TextEncoder().encode(info),
    32,
  );
}

function keypair(seed: Uint8Array): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

export function deriveDemoUmk(kek: Uint8Array, username: string): Uint8Array {
  return deriveSeed(kek, username, USER_SALT, "account-umk");
}

export function deriveDemoUserIrk(kek: Uint8Array, username: string): Keypair {
  return deriveIRK({ seed: deriveDemoUmk(kek, username) });
}

export function deriveDemoUserAid(kek: Uint8Array, username: string): Keypair {
  return deriveAccountId({ seed: deriveDemoUmk(kek, username) });
}

export function deriveDemoAdminRoot(kek: Uint8Array, username: string): Keypair {
  return keypair(deriveSeed(kek, username, USER_SALT, "admin-root"));
}

export function deriveDemoPrimaryDeviceKey(kek: Uint8Array, username: string): Keypair {
  return keypair(deriveSeed(kek, username, DEVICE_SALT, "primary-device"));
}

export function deriveDemoPrimaryDeviceId(kek: Uint8Array, username: string): string {
  const publicKey = deriveDemoPrimaryDeviceKey(kek, username).publicKey;
  const prefix = new TextEncoder().encode(
    `flagship/demo-primary-device-id/v1|${username.toLowerCase()}|`,
  );
  const input = new Uint8Array(prefix.length + publicKey.length);
  input.set(prefix);
  input.set(publicKey, prefix.length);
  return bytesToHex(sha256(input).slice(0, 16));
}

export function deriveDemoDelegatedKey(kek: Uint8Array, username: string): Keypair {
  return keypair(deriveSeed(kek, username, USER_SALT, "delegated"));
}

export function deriveDemoRckKey(kek: Uint8Array, username: string): Keypair {
  return keypair(deriveSeed(kek, username, USER_SALT, "rck"));
}
