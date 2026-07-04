/**
 * KeyCustodian — the daemon's single custody chokepoint for its in-process
 * secret key material.
 *
 * The box holds three raw secrets in daemon memory: the box IDENTITY private
 * seed (STK — 32-byte Ed25519 seed; signs everything the box asserts + opens
 * everything sealed TO the box), the SWK (Server Workload Key — the symmetric
 * root the service/build/backup/TLS-at-rest subkeys derive from), and the CGK
 * (Cloud Gossip Key — the per-cloud symmetric key the leadership gossip is
 * sealed under). Historically each was passed around as raw `Bytes` /
 * `Keypair`, so the reference graph for "who can touch the box's private key"
 * sprawled across the internet-facing proxy, the tunnel client, every SWK-
 * sealed store, and the gossip loop.
 *
 * This module INVERTS that: it OWNS the raw bytes privately and exposes ONLY
 * operations — there is deliberately NO `getSwk()` / `getIdentityPriv()` /
 * `getCgk()`. Every place that used to hold a key now holds a narrow interface
 * slice (`BoxSigner` / `SwkOps` / `GossipOps`) and calls an operation. The raw
 * seeds live in exactly one closure.
 *
 * HONEST BOUNDARY: this is an in-PROCESS custodian. It buys three concrete
 * things —
 *   1. one audited chokepoint for all private-key use (grep for the raw
 *      primitives now yields a single file);
 *   2. a shrunk reference graph — the internet-facing `serviceProxy` /
 *      `tunnelClient` no longer close over a `Keypair`, only a `sign(msg)`;
 *   3. a clean seam for a FUTURE out-of-process split (a signer daemon / TPM /
 *      enclave): every caller already speaks "operations", so the
 *      implementation can move behind an IPC boundary without touching them.
 * It does NOT protect against same-process memory disclosure: a bug that can
 * read arbitrary daemon heap can still recover the seeds. The seam is what
 * makes closing that gap later a localized change rather than a rewrite.
 */

import {
  ed,
  deriveServiceSecret as protocolDeriveServiceSecret,
  deriveBackupManifestKey as protocolDeriveBackupManifestKey,
  encryptChunk,
  decryptChunk,
  sealLlmPayload,
  openLlmPayload,
  sealGossip as protocolSealGossip,
  openGossip as protocolOpenGossip,
  signSecretRequest as protocolSignSecretRequest,
  signInstallService as protocolSignInstallService,
  openSealedFromEd25519Recipient,
  type Bytes,
  type Keypair,
  type ServerId,
  type SealedBlob,
  type EncryptedChunk,
  type SecretRequest,
  type InstallServiceRequest,
} from "@flagship/protocol";
import { deriveTlsKey as protocolDeriveTlsKey } from "./acme.js";

/**
 * Box-identity (STK) operations. Holds the 32-byte Ed25519 seed; NEVER
 * returns it. This is the slice the internet-facing proxy + tunnel client
 * receive — they can sign and read the pubkey, nothing else.
 */
export interface BoxSigner {
  /** The box identity PUBLIC key (safe to publish). */
  boxPublicKey(): Bytes;
  /** Ed25519-sign arbitrary canonical bytes with the box identity seed. */
  signAsBox(msg: Bytes): Bytes;
  /** Open a blob sealed TO the box identity (X25519 via the birational map). */
  unsealToBox(blob: Bytes): Bytes;
  /** Sign a phone/`.com` SecretRequest as the box (canonical-bytes wrapper). */
  signSecretRequest(req: SecretRequest): Bytes;
  /**
   * Sign an InstallServiceRequest as the box. A BOX-ORIGINATED build-modes
   * deploy signs with the box identity (the owner IRK private half is phone-
   * held); ServicePlatform accepts the box identity as an additive host signer.
   */
  signInstallService(req: InstallServiceRequest): Bytes;
}

/**
 * SWK-derived symmetric operations. Holds the raw SWK; exposes only seal/open
 * and purpose-scoped subkey derivations. `deriveTlsKey` / `deriveServiceSecret`
 * / `deriveBackupManifestKey` return a DERIVED subkey (not the SWK): a store
 * that needs its own AEAD key gets exactly that key and the SWK never leaves.
 */
export interface SwkOps {
  /** Seal plaintext under the SWK LLM subkey (nonce+ciphertext). */
  sealWithSwk(pt: Bytes): SealedBlob;
  /** Open a `sealWithSwk` blob. Throws (GCM) on a wrong key / tamper. */
  openWithSwk(blob: SealedBlob): Bytes;
  /** Content-addressed chunk encryption under the SWK chunk subkey. */
  encryptChunkWithSwk(pt: Bytes): EncryptedChunk;
  /** Decrypt an `encryptChunkWithSwk` chunk. */
  decryptChunkWithSwk(chunk: EncryptedChunk): Bytes;
  /** Per-service secret (privacy-preserving stable-id root). */
  deriveServiceSecret(serviceId: string): Bytes;
  /** TLS-private-key-at-rest subkey for this server. */
  deriveTlsKey(serverId: ServerId): Bytes;
  /** Peer-backup manifest sealing subkey. */
  deriveBackupManifestKey(): Bytes;
}

/**
 * CGK-derived cloud-gossip operations. Holds the raw CGK; exposes only the
 * content-blind seal/open the gossip fan-out rides on.
 */
export interface GossipOps {
  sealGossip(pt: Bytes): Bytes;
  openGossip(blob: Bytes): Bytes;
}

export interface KeyCustodianInit {
  /** The box identity Ed25519 seed (32-byte private key). Required. */
  identityPriv: Bytes;
  /** The Server Workload Key, when the box is provisioned. Optional. */
  swk?: Bytes | undefined;
  /** The Cloud Gossip Key, when gossip is provisioned. Optional. */
  cgk?: Bytes | undefined;
}

/**
 * The one object that holds the box's raw private key bytes. Construct it
 * once at boot from the loaded key material and thread the interface slices
 * (`asBoxSigner()` / `asSwkOps()` / `asGossipOps()`) everywhere the raw keys
 * used to go.
 */
export class KeyCustodian implements BoxSigner, SwkOps, GossipOps {
  readonly #identity: Keypair;
  readonly #swk: Bytes | null;
  readonly #cgk: Bytes | null;

  constructor(init: KeyCustodianInit) {
    if (init.identityPriv.length !== 32) {
      throw new Error("KeyCustodian: identity seed must be 32 bytes");
    }
    // Copy so a later mutation of the caller's buffer can't retroactively
    // change what the custodian signs with.
    const seed = init.identityPriv.slice();
    this.#identity = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
    this.#swk = init.swk ? init.swk.slice() : null;
    this.#cgk = init.cgk ? init.cgk.slice() : null;
  }

  // ── BoxSigner ─────────────────────────────────────────────────────────
  boxPublicKey(): Bytes {
    return this.#identity.publicKey;
  }
  signAsBox(msg: Bytes): Bytes {
    return ed.sign(msg, this.#identity.privateKey);
  }
  unsealToBox(blob: Bytes): Bytes {
    return openSealedFromEd25519Recipient(blob, this.#identity.privateKey);
  }
  signSecretRequest(req: SecretRequest): Bytes {
    return protocolSignSecretRequest(req, this.#identity);
  }
  signInstallService(req: InstallServiceRequest): Bytes {
    return protocolSignInstallService(req, this.#identity);
  }

  // ── SwkOps ────────────────────────────────────────────────────────────
  get hasSwk(): boolean {
    return this.#swk !== null;
  }
  #swkOrThrow(): Bytes {
    if (!this.#swk) throw new Error("KeyCustodian: no SWK provisioned (SwkOps unavailable)");
    return this.#swk;
  }
  sealWithSwk(pt: Bytes): SealedBlob {
    return sealLlmPayload(pt, this.#swkOrThrow());
  }
  openWithSwk(blob: SealedBlob): Bytes {
    return openLlmPayload(blob, this.#swkOrThrow());
  }
  encryptChunkWithSwk(pt: Bytes): EncryptedChunk {
    return encryptChunk(pt, this.#swkOrThrow());
  }
  decryptChunkWithSwk(chunk: EncryptedChunk): Bytes {
    return decryptChunk(chunk, this.#swkOrThrow());
  }
  deriveServiceSecret(serviceId: string): Bytes {
    return protocolDeriveServiceSecret(this.#swkOrThrow(), serviceId);
  }
  deriveTlsKey(serverId: ServerId): Bytes {
    return protocolDeriveTlsKey(this.#swkOrThrow(), serverId);
  }
  deriveBackupManifestKey(): Bytes {
    return protocolDeriveBackupManifestKey(this.#swkOrThrow());
  }

  // ── GossipOps ─────────────────────────────────────────────────────────
  get hasCgk(): boolean {
    return this.#cgk !== null;
  }
  #cgkOrThrow(): Bytes {
    if (!this.#cgk) throw new Error("KeyCustodian: no CGK provisioned (GossipOps unavailable)");
    return this.#cgk;
  }
  sealGossip(pt: Bytes): Bytes {
    return protocolSealGossip(pt, this.#cgkOrThrow());
  }
  openGossip(blob: Bytes): Bytes {
    return protocolOpenGossip(blob, this.#cgkOrThrow());
  }

  // ── Narrowing accessors (structural slices for the reference graph) ────
  asBoxSigner(): BoxSigner {
    return this;
  }
  asSwkOps(): SwkOps {
    return this;
  }
  asGossipOps(): GossipOps {
    return this;
  }
}
