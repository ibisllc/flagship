/**
 * The key custodian when the keys live in flagship-keyd (SECURITY-HARDENING-PLAN.md 5.1).
 *
 * Same interface slices as the in-process `KeyCustodian` (`BoxSigner`, `SwkOps`, `GossipOps`),
 * so no caller changes; the difference is that this process never holds the STK seed, the SWK
 * or the CGK. Each operation is one request to keyd over its Unix socket. Code written for a
 * full `Keypair` is given `identityKeypair()`, whose private half is an opaque stand-in that
 * can sign and open sealed blobs through keyd and nothing else (protocol/opaqueKey.ts).
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
        unseal: (b) => this.unsealToBox(b),
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
  unsealToBox(blob: Bytes): Bytes {
    return unhex(this.#client.call("unseal", { blob: hex(blob) }).plain);
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

  // ── Provisioning (once; keyd refuses a different key afterwards) ───────
  provisionSwk(key: Bytes): void {
    this.#client.call("provision.swk", { key: hex(key) });
    this.#hasSwk = true;
  }
  provisionCgk(key: Bytes): void {
    this.#client.call("provision.cgk", { key: hex(key) });
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
