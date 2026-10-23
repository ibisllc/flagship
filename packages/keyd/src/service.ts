import { hkdfSync } from "node:crypto";
import {
  decryptChunk,
  deriveBackupManifestKey,
  deriveServiceSecret,
  ed,
  encryptChunk,
  openLlmPayload,
  openGossip,
  openSealedFromEd25519Recipient,
  sealGossip,
  sealLlmPayload,
  SWK_DERIVE_LABELS,
} from "@flagship/protocol";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { BOX_SIGN_PURPOSES, checkSign } from "./policy.js";
import { KEYD_PROTOCOL_VERSION, KeydError, hexArg, noExtraArgs, strArg, toHex, type KeydRequest } from "./wire.js";

export interface KeyStore {
  /** Persist a provisioned secret (0400, owned by the keyd user). */
  save(name: "swk" | "cgk", bytes: Uint8Array): void;
}

export interface KeydServiceInit {
  identitySeed: Uint8Array;
  swk?: Uint8Array | undefined;
  cgk?: Uint8Array | undefined;
  store?: KeyStore;
  signPurposes?: ReadonlySet<string>;
}

/**
 * The operations flagship-keyd answers. Holds the raw STK seed, SWK and CGK in private
 * fields and returns only results: signatures, plaintext of blobs sealed to the box, and
 * purpose-scoped derived subkeys. There is no operation that returns a root key.
 */
export class KeydService {
  readonly #seed: Uint8Array;
  readonly #pub: Uint8Array;
  readonly #pubHex: string;
  #swk: Uint8Array | null;
  #cgk: Uint8Array | null;
  readonly #store: KeyStore | undefined;
  readonly #purposes: ReadonlySet<string>;

  constructor(init: KeydServiceInit) {
    if (init.identitySeed.length !== 32) throw new Error("keyd: identity seed must be 32 bytes");
    this.#seed = init.identitySeed.slice();
    this.#pub = ed.getPublicKey(this.#seed);
    this.#pubHex = toHex(this.#pub);
    this.#swk = init.swk ? init.swk.slice() : null;
    this.#cgk = init.cgk ? init.cgk.slice() : null;
    this.#store = init.store;
    this.#purposes = init.signPurposes ?? BOX_SIGN_PURPOSES;
  }

  get publicKeyHex(): string {
    return this.#pubHex;
  }

  /** Zero the key material (shutdown). */
  destroy(): void {
    this.#seed.fill(0);
    this.#swk?.fill(0);
    this.#cgk?.fill(0);
    this.#swk = null;
    this.#cgk = null;
  }

  /** Which operations a connection may use before it has said hello: none. */
  handle(req: KeydRequest): { result: Record<string, unknown>; purpose?: string } {
    const a = req.args;
    switch (req.op) {
      case "hello": {
        noExtraArgs(a, ["v", "component"]);
        if (a.v !== KEYD_PROTOCOL_VERSION) throw new KeydError("unsupported-version", "keyd speaks protocol 1 only");
        strArg(a, "component", 64);
        return { result: { v: KEYD_PROTOCOL_VERSION, publicKey: this.#pubHex, hasSwk: this.#swk !== null, hasCgk: this.#cgk !== null } };
      }
      case "status":
        noExtraArgs(a, []);
        return { result: { publicKey: this.#pubHex, hasSwk: this.#swk !== null, hasCgk: this.#cgk !== null } };
      case "sign": {
        noExtraArgs(a, ["msg"]);
        const msg = hexArg(a, "msg", { min: 1 });
        const purpose = checkSign(msg, this.#pubHex, this.#purposes);
        return { result: { sig: toHex(ed.sign(msg, this.#seed)) }, purpose };
      }
      case "unseal": {
        noExtraArgs(a, ["blob"]);
        const blob = hexArg(a, "blob", { min: 44, max: 1024 * 1024 });
        try {
          return { result: { plain: toHex(openSealedFromEd25519Recipient(blob, this.#seed)) } };
        } catch {
          throw new KeydError("failed", "could not open the blob");
        }
      }
      case "swk.hkdf": {
        // The one derivation primitive the box's workload-key consumers use. The label must be
        // one the box actually derives; anything else is refused, so a compromised daemon cannot
        // ask keyd for a subkey of its own choosing.
        noExtraArgs(a, ["salt", "info"]);
        const info = strArg(a, "info", 128);
        if (!SWK_DERIVE_LABELS.has(info)) throw new KeydError("forbidden", "that derivation label is not allowed");
        const salt = hexArg(a, "salt", { max: 512 });
        return { result: { key: toHex(hkdf(sha256, this.#swkOrThrow(), salt, new TextEncoder().encode(info), 32)) } };
      }
      case "swk.seal": {
        const b = sealLlmPayload(this.#req(a, "pt"), this.#swkOrThrow());
        return { result: { ciphertext: toHex(b.ciphertext), nonce: toHex(b.nonce) } };
      }
      case "swk.open": {
        noExtraArgs(a, ["ciphertext", "nonce"]);
        const blob = { ciphertext: hexArg(a, "ciphertext", { min: 16, max: 3 * 1024 * 1024 }), nonce: hexArg(a, "nonce", { exact: 12 }) };
        return { result: { pt: toHex(this.#guard(() => openLlmPayload(blob, this.#swkOrThrow()))) } };
      }
      case "swk.encryptChunk": {
        const c = encryptChunk(this.#req(a, "pt"), this.#swkOrThrow());
        return { result: { ciphertext: toHex(c.ciphertext), nonce: toHex(c.nonce), contentHash: toHex(c.contentHash) } };
      }
      case "swk.decryptChunk": {
        noExtraArgs(a, ["ciphertext", "nonce", "contentHash"]);
        const chunk = {
          ciphertext: hexArg(a, "ciphertext", { min: 16, max: 3 * 1024 * 1024 }),
          nonce: hexArg(a, "nonce", { exact: 12 }),
          contentHash: hexArg(a, "contentHash", { exact: 32 }),
        };
        return { result: { pt: toHex(this.#guard(() => decryptChunk(chunk, this.#swkOrThrow()))) } };
      }
      case "swk.deriveServiceSecret": {
        noExtraArgs(a, ["serviceId"]);
        return { result: { secret: toHex(deriveServiceSecret(this.#swkOrThrow(), strArg(a, "serviceId", 200))) } };
      }
      case "swk.deriveTlsKey": {
        noExtraArgs(a, ["serverId"]);
        const id = strArg(a, "serverId", 253);
        return { result: { key: toHex(hkdf(sha256, this.#swkOrThrow(), new TextEncoder().encode(id), new TextEncoder().encode("flagship.tls.v1"), 32)) } };
      }
      case "swk.deriveBackupManifestKey":
        noExtraArgs(a, []);
        return { result: { key: toHex(deriveBackupManifestKey(this.#swkOrThrow())) } };
      case "cgk.seal":
        return { result: { blob: toHex(sealGossip(this.#req(a, "pt"), this.#cgkOrThrow())) } };
      case "cgk.open":
        return { result: { pt: toHex(this.#guard(() => openGossip(this.#req(a, "blob"), this.#cgkOrThrow()))) } };
      case "cgk.deriveAppCopyEnvKey": {
        noExtraArgs(a, ["info"]);
        const info = hexArg(a, "info", { min: 1, max: 512 });
        if (!new TextDecoder().decode(info).startsWith("flagship/app-copy-env/v1|")) {
          throw new KeydError("forbidden", "app-copy env key info must be purpose-tagged");
        }
        return { result: { key: toHex(new Uint8Array(hkdfSync("sha256", this.#cgkOrThrow(), new Uint8Array(0), info, 32))) } };
      }
      case "provision.swk":
      case "provision.cgk": {
        noExtraArgs(a, ["key"]);
        const which = req.op === "provision.swk" ? "swk" : "cgk";
        const current = which === "swk" ? this.#swk : this.#cgk;
        const key = hexArg(a, "key", { exact: 32 });
        // A key is provisioned once. Replacing one is a restore or replacement workflow
        // (a new keyd state), never a request over the socket.
        if (current) {
          if (Buffer.from(current).equals(Buffer.from(key))) return { result: { stored: false, already: true } };
          throw new KeydError("forbidden", `${which} is already provisioned`);
        }
        this.#store?.save(which, key);
        if (which === "swk") this.#swk = key.slice();
        else this.#cgk = key.slice();
        return { result: { stored: true } };
      }
      default:
        throw new KeydError("unknown-op", "unknown operation");
    }
  }

  #req(a: Record<string, unknown>, name: string): Uint8Array {
    noExtraArgs(a, [name]);
    return hexArg(a, name, { min: 0, max: 3 * 1024 * 1024 });
  }

  #guard<T>(f: () => T): T {
    try {
      return f();
    } catch (e) {
      if (e instanceof KeydError) throw e;
      throw new KeydError("failed", "authentication failed");
    }
  }

  #swkOrThrow(): Uint8Array {
    if (!this.#swk) throw new KeydError("not-provisioned", "no SWK provisioned");
    return this.#swk;
  }
  #cgkOrThrow(): Uint8Array {
    if (!this.#cgk) throw new KeydError("not-provisioned", "no CGK provisioned");
    return this.#cgk;
  }
}
