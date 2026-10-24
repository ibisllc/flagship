/**
 * The key custodian when the keys live in flagship-keyd (SECURITY-HARDENING-PLAN.md 5.1).
 *
 * Same interface slices as the in-process `KeyCustodian` (`BoxSigner`, `SwkOps`, `GossipOps`),
 * so no caller changes; the difference is that this process never holds the STK seed, the SWK
 * or the CGK. Each operation is one request to keyd over its Unix socket. Code written for a
 * full `Keypair` is given `identityKeypair()`, whose private half is an opaque stand-in that
 * can sign through keyd and nothing else (protocol/opaqueKey.ts).
 */

import {
  opaqueKey,
  opaqueSecret,
  signBootAuthWith,
  signBootSuspension as protocolSignBootSuspension,
  signInstallService as protocolSignInstallService,
  signSecretRequest as protocolSignSecretRequest,
  type BootAuthEnvelope,
  type BootSuspensionOrder,
  type Bytes,
  type EncryptedChunk,
  type InstallServiceRequest,
  type Keypair,
  type SealedBlob,
  type SecretRequest,
  type ServerId,
} from "@flagship/protocol";
import { KeydSyncClient } from "@flagship/keyd";
import type { BoxSigner, GossipOps, SwkOps, BootAuthArgs } from "./keyCustodian.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: unknown): Bytes => Uint8Array.from(Buffer.from(String(s), "hex"));

/** The owner's signature on a sealed SWK/CGK delivery, as the carrier holds it. */
export interface DeliveryProof {
  serverDomain: string;
  issuedAt: number;
  signature: Bytes;
}

function proofArgs(p: DeliveryProof): { serverDomain: string; issuedAt: number; signature: string } {
  return { serverDomain: p.serverDomain, issuedAt: p.issuedAt, signature: hex(p.signature) };
}

/** Where keyd writes the boot ceremony's token (packages/keyd CEREMONY_TOKEN_FILE). */
export const KEYD_CEREMONY_TOKEN_PATH = "/var/lib/flagship-keyd/provision-ceremony.token";

export interface KeydCustodianOptions {
  socketPath: string;
  component?: string;
  timeoutMs?: number;
}

export class KeydCustodian implements BoxSigner, SwkOps, GossipOps {
  readonly #client: KeydSyncClient;
  readonly #pub: Bytes;
  #hasSwk: boolean;
  #hasCgk: boolean;
  readonly #keypair: Keypair;
  #mldsaPubHex: string | null | undefined;

  constructor(opts: KeydCustodianOptions) {
    this.#client = new KeydSyncClient({
      socketPath: opts.socketPath,
      component: opts.component ?? "daemon",
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const hello = this.#client.connect();
    this.#pub = unhex(hello.publicKey);
    this.#hasSwk = hello.hasSwk;
    this.#hasCgk = hello.hasCgk;
    this.#keypair = {
      publicKey: this.#pub,
      privateKey: opaqueKey({
        publicKey: this.#pub,
        sign: (m) => this.signAsBox(m),
      }),
    };
  }

  /**
   * The workload key as a stand-in for code that takes `swk: Bytes`. It derives labelled
   * subkeys through keyd (`hkdfFromSwk` in the protocol) and refuses every other use.
   */
  swkHandle(): Bytes {
    return opaqueSecret({
      derive: (salt, info) => unhex(this.#client.call("swk.hkdf", { salt: hex(salt), info }).key),
    });
  }

  /** The box identity as a `Keypair` whose private half stays in keyd. */
  identityKeypair(): Keypair {
    return this.#keypair;
  }

  close(): void {
    this.#client.close();
  }

  // ── BoxSigner ─────────────────────────────────────────────────────────
  boxPublicKey(): Bytes {
    return this.#pub;
  }
  signAsBox(msg: Bytes): Bytes {
    return unhex(this.#client.call("sign", { msg: hex(msg) }).sig);
  }
  /**
   * The STK's ML-DSA-65 public key (hex), or null when this keyd holds none (an older keyd, or
   * one without `identity-mldsa.key`). Asked once.
   */
  pqPublicKeyHex(): string | null {
    if (this.#mldsaPubHex === undefined) {
      try {
        const r = this.#client.call("pq.status", {});
        this.#mldsaPubHex = typeof r.mldsaPublicKey === "string" ? r.mldsaPublicKey : null;
      } catch {
        this.#mldsaPubHex = null;
      }
    }
    return this.#mldsaPubHex;
  }
  /** A `master` assertion: keyd signs it only after checking the owner's evidence itself. */
  signMasterIdentity(msg: Bytes, ev: { appId: string; identityPubHex: string; statement: string; signatureHex: string }): Bytes {
    return unhex(this.#client.call("sign.identity", { msg: hex(msg), ...ev }).sig);
  }

  /** Hybrid-sign (STK AND its ML-DSA key) under the same purpose list as `signAsBox`. */
  signHybridAsBox(msg: Bytes): Bytes {
    return unhex(this.#client.call("sign.hybrid", { msg: hex(msg) }).sig);
  }
  /**
   * keyd returns no general plaintext of what is sealed to the box: sealed keys go in with
   * `provisionSwkSealed` / `provisionCgkSealed`, pairing orders come out of `unsealPairingOrder`.
   */
  unsealToBox(_blob: Bytes): Bytes {
    throw new Error("flagship-keyd opens sealed keys itself; it returns only pairing orders");
  }
  unsealPairingOrder(blob: Bytes): Bytes {
    return unhex(this.#client.call("unseal", { blob: hex(blob), purpose: "pairing-order" }).plain);
  }
  signSecretRequest(req: SecretRequest): Bytes {
    return protocolSignSecretRequest(req, this.#keypair);
  }
  signBootAuthHeader(args: BootAuthArgs): string {
    if (args.role !== "box") throw new Error("the box key signs boot requests as the box only");
    return signBootAuthWith(args as Omit<BootAuthEnvelope, "signatureHex">, (m) => this.signAsBox(m));
  }
  signBootSuspension(order: BootSuspensionOrder): Bytes {
    return protocolSignBootSuspension(order, this.#keypair.privateKey);
  }
  signInstallService(req: InstallServiceRequest): Bytes {
    return protocolSignInstallService(req, this.#keypair);
  }

  // ── SwkOps ────────────────────────────────────────────────────────────
  get hasSwk(): boolean {
    return this.#hasSwk;
  }
  sealWithSwk(pt: Bytes): SealedBlob {
    const r = this.#client.call("swk.seal", { pt: hex(pt) });
    return { ciphertext: unhex(r.ciphertext), nonce: unhex(r.nonce) };
  }
  openWithSwk(blob: SealedBlob): Bytes {
    return unhex(this.#client.call("swk.open", { ciphertext: hex(blob.ciphertext), nonce: hex(blob.nonce) }).pt);
  }
  encryptChunkWithSwk(pt: Bytes): EncryptedChunk {
    const r = this.#client.call("swk.encryptChunk", { pt: hex(pt) });
    return { ciphertext: unhex(r.ciphertext), nonce: unhex(r.nonce), contentHash: unhex(r.contentHash) };
  }
  decryptChunkWithSwk(chunk: EncryptedChunk): Bytes {
    return unhex(
      this.#client.call("swk.decryptChunk", { ciphertext: hex(chunk.ciphertext), nonce: hex(chunk.nonce), contentHash: hex(chunk.contentHash) }).pt,
    );
  }
  deriveServiceSecret(serviceId: string): Bytes {
    return unhex(this.#client.call("swk.deriveServiceSecret", { serviceId }).secret);
  }
  deriveTlsKey(serverId: ServerId): Bytes {
    return unhex(this.#client.call("swk.deriveTlsKey", { serverId }).key);
  }
  deriveBackupManifestKey(): Bytes {
    return unhex(this.#client.call("swk.deriveBackupManifestKey").key);
  }

  // ── GossipOps ─────────────────────────────────────────────────────────
  get hasCgk(): boolean {
    return this.#hasCgk;
  }
  sealGossip(pt: Bytes): Bytes {
    return unhex(this.#client.call("cgk.seal", { pt: hex(pt) }).blob);
  }
  openGossip(blob: Bytes): Bytes {
    return unhex(this.#client.call("cgk.open", { blob: hex(blob) }).pt);
  }
  deriveAppCopyEnvKey(info: Bytes): Bytes {
    return unhex(this.#client.call("cgk.deriveAppCopyEnvKey", { info: hex(info) }).key);
  }
  gossipMac(canonical: Bytes): string {
    return String(this.#client.call("cgk.gossipMac", { msg: hex(canonical) }).mac);
  }
  accessSyncMac(canonical: Bytes): string {
    return String(this.#client.call("cgk.accessSyncMac", { msg: hex(canonical) }).mac);
  }

  // ── Provisioning (once; keyd refuses a different key afterwards) ───────
  /**
   * Move in a key this box already held (install blob, legacy file). keyd lets it in only with
   * the boot ceremony's one-time token, which keyd wrote beside its state at this start for root
   * to read (`ceremonyToken`); without it keyd refuses and the key stays where it was.
   */
  provisionSwk(key: Bytes, ceremonyToken: string): void {
    this.#client.call("provision.swk", { key: hex(key), ceremony: ceremonyToken });
    this.#hasSwk = true;
  }
  provisionCgk(key: Bytes, ceremonyToken: string): void {
    this.#client.call("provision.cgk", { key: hex(key), ceremony: ceremonyToken });
    this.#hasCgk = true;
  }
  /** Hand keyd the owner's sealed delivery and its signature; keyd checks both, opens it and keeps the key. */
  provisionSwkSealed(sealed: Bytes, proof: DeliveryProof): void {
    this.#client.call("provision.swk", { sealed: hex(sealed), ...proofArgs(proof) });
    this.#hasSwk = true;
  }
  provisionCgkSealed(sealed: Bytes, proof: DeliveryProof): void {
    this.#client.call("provision.cgk", { sealed: hex(sealed), ...proofArgs(proof) });
    this.#hasCgk = true;
  }

  // ── Narrowing accessors ───────────────────────────────────────────────
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
