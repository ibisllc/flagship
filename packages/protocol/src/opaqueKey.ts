/**
 * Opaque private keys (SECURITY-HARDENING-PLAN.md 5.1, flagship-keyd).
 *
 * A key that lives in another process still has to travel through code written for
 * `Keypair { privateKey: Uint8Array }`. An opaque key is a stand-in for that
 * `privateKey`: it is accepted by the two primitives that legitimately use a private key
 * (`ed.sign` / `ed.getPublicKey` in edSync.ts, and `openSealedFromEd25519Recipient`),
 * which forward the request to whatever holds the real key. Any other use throws, so a
 * path that tries to read the bytes (hex-encode them, hash them, derive from them) fails
 * loudly instead of quietly working on a zeroed buffer.
 */

import type { Bytes } from "./types.js";

export interface OpaqueKeyOps {
  /** The public key this stand-in stands for. */
  publicKey: Bytes;
  /** Ed25519-sign `msg` where the key lives. */
  sign(msg: Bytes): Bytes;
  /** Open a blob sealed to the key's Ed25519 identity (X25519 birational map). */
  unseal?(blob: Bytes): Bytes;
}

const REGISTRY = new WeakMap<object, OpaqueKeyOps>();

const ALLOWED_READS = new Set<PropertyKey>(["length", Symbol.toStringTag, "constructor", "byteLength"]);

/** A 32-byte-shaped stand-in for a private key that never leaves its holder. */
export function opaqueKey(ops: OpaqueKeyOps): Bytes {
  const shell = new Uint8Array(32);
  const proxy = new Proxy(shell, {
    get(target, prop) {
      if (ALLOWED_READS.has(prop)) return Reflect.get(target, prop);
      throw new Error("this private key is held by flagship-keyd; it can sign and open sealed blobs, nothing else");
    },
    set() {
      throw new Error("this private key is held by flagship-keyd");
    },
    has(target, prop) {
      if (ALLOWED_READS.has(prop)) return Reflect.has(target, prop);
      throw new Error("this private key is held by flagship-keyd; it can sign and open sealed blobs, nothing else");
    },
    ownKeys() {
      return [];
    },
    getOwnPropertyDescriptor() {
      return undefined;
    },
  });
  REGISTRY.set(proxy, ops);
  return proxy;
}

export function opaqueOps(key: unknown): OpaqueKeyOps | undefined {
  return typeof key === "object" && key !== null ? REGISTRY.get(key) : undefined;
}

export function isOpaqueKey(key: unknown): boolean {
  return opaqueOps(key) !== undefined;
}

// ── Opaque workload secrets (the SWK) ──────────────────────────────────────
// Everything the box does with its workload key is an HKDF derivation of a purpose-specific
// subkey. An opaque secret stands in for the 32-byte SWK and answers exactly that: derive
// (salt, info) -> 32 bytes, where `info` must be one of the labels in SWK_DERIVE_LABELS.
// Any other use of the bytes throws.

/** The only labels a workload-key derivation may use. keyd enforces the same list. */
export const SWK_DERIVE_LABELS: ReadonlySet<string> = new Set([
  "flagship.chunk.v1",
  "flagship.llm.v1",
  "flagship.tls.v1",
  "flagship.pb-manifest.v1",
  "flagship/peer-backup-key/v1",
  "flagship.app-secret.v1",
]);

export interface OpaqueSecretOps {
  /** HKDF-SHA256(secret, salt, info) -> 32 bytes, computed where the secret lives. */
  derive(salt: Bytes, info: string): Bytes;
}

const SECRETS = new WeakMap<object, OpaqueSecretOps>();

export function opaqueSecret(ops: OpaqueSecretOps): Bytes {
  const shell = new Uint8Array(32);
  const refuse = (): never => {
    throw new Error("this secret is held by flagship-keyd; it can derive purpose-labelled subkeys, nothing else");
  };
  const proxy = new Proxy(shell, {
    get(target, prop) {
      if (ALLOWED_READS.has(prop)) return Reflect.get(target, prop);
      return refuse();
    },
    set: refuse,
    has(target, prop) {
      if (ALLOWED_READS.has(prop)) return Reflect.has(target, prop);
      return refuse();
    },
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
  SECRETS.set(proxy, ops);
  return proxy;
}

export function opaqueSecretOps(secret: unknown): OpaqueSecretOps | undefined {
  return typeof secret === "object" && secret !== null ? SECRETS.get(secret) : undefined;
}
