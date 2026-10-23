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
} from "@flagship/protocol";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { BOX_SIGN_PURPOSES, SWK_HKDF_LABELS, UNSEAL_PURPOSES, checkSign, isPairingOrder, isServiceId } from "./policy.js";
import { AcmeAccount, type AcmeRequest } from "./acme.js";
import { TlsKeys } from "./tls.js";
import { KEYD_PROTOCOL_VERSION, KeydError, hexArg, noExtraArgs, pemArg, strArg, toHex, type KeydRequest } from "./wire.js";

/** The access-sync key's HKDF info; the daemon's accessSync.ts derives the same key in process. */
const ACCESS_SYNC_KEY_INFO = "flagship/access-sync/key/v1";

const GOSSIP_TAG = "flagship/gossip/v2|";
const ACCESS_SYNC_TAG = "flagship/access-sync/v1|";
const MAX_MAC_BYTES = 64 * 1024;
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
  /** TLS leaf keys; absent means this keyd serves no TLS operations. */
  tls?: TlsKeys;
  /** The ACME account key; needs `tls`. */
  acme?: AcmeAccount;
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
  readonly #tls: TlsKeys | null;
  readonly #acme: AcmeAccount | null;

  constructor(init: KeydServiceInit) {
    if (init.identitySeed.length !== 32) throw new Error("keyd: identity seed must be 32 bytes");
    this.#seed = init.identitySeed.slice();
    this.#pub = ed.getPublicKey(this.#seed);
    this.#pubHex = toHex(this.#pub);
    this.#swk = init.swk ? init.swk.slice() : null;
    this.#cgk = init.cgk ? init.cgk.slice() : null;
    this.#store = init.store;
    this.#purposes = init.signPurposes ?? BOX_SIGN_PURPOSES;
    this.#tls = init.tls ?? null;
    this.#acme = init.acme ?? null;
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
    this.#tls?.destroy();
    this.#acme?.destroy();
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
        // Only for a sealed message the daemon must read, checked by its shape once opened:
        // a sealed key (SWK, CGK, ACME account) never comes back out (provision.* and
        // acme.importGranted open those here and keep them).
        noExtraArgs(a, ["blob", "purpose"]);
        const blob = hexArg(a, "blob", { min: 44, max: 1024 * 1024 });
        const purpose = strArg(a, "purpose", 32);
        if (!UNSEAL_PURPOSES.has(purpose)) throw new KeydError("forbidden", "keyd opens no sealed message of that kind");
        let plain: Uint8Array;
        try {
          plain = openSealedFromEd25519Recipient(blob, this.#seed);
        } catch {
          throw new KeydError("failed", "could not open the blob");
        }
        if (!isPairingOrder(plain)) {
          plain.fill(0);
          throw new KeydError("forbidden", "the sealed message is not a pairing order");
        }
        return { result: { plain: toHex(plain) } };
      }
      case "swk.hkdf": {
        // Only the two fixed, unsalted subkeys the daemon itself needs (peer-backup key, backup
        // manifest key). The chunk, LLM, app-secret and TLS-at-rest subkeys are used through
        // their own operations, so they never leave keyd.
        noExtraArgs(a, ["salt", "info"]);
        const info = strArg(a, "info", 128);
        if (!SWK_HKDF_LABELS.has(info)) throw new KeydError("forbidden", "that derivation label is not allowed");
        const salt = hexArg(a, "salt", { max: 0 });
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
        const serviceId = strArg(a, "serviceId", 200);
        if (!isServiceId(serviceId)) throw new KeydError("bad-request", "serviceId must be <creator>--<slug> or <slug>");
        return { result: { secret: toHex(deriveServiceSecret(this.#swkOrThrow(), serviceId)) } };
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
      case "cgk.mac": {
        noExtraArgs(a, ["msg"]);
        const msg = hexArg(a, "msg", { min: 1, max: 64 * 1024 });
        // Only a gossip announcement's canonical bytes: keyd is not a general HMAC oracle under the CGK.
        if (!new TextDecoder().decode(msg).startsWith("flagship/gossip/v2|")) {
          throw new KeydError("forbidden", "only gossip announcements are MACed");
        }
        return { result: { mac: toHex(hmac(sha256, this.#cgkOrThrow(), msg)) } };
      }
      case "cgk.deriveAccessSyncKey":
        noExtraArgs(a, []);
        return { result: { key: toHex(new Uint8Array(hkdfSync("sha256", this.#cgkOrThrow(), new Uint8Array(0), new TextEncoder().encode(ACCESS_SYNC_KEY_INFO), 32))) } };
      case "cgk.gossipMac":
      case "cgk.accessSyncMac": {
        // A MAC over the box's own two gossip message kinds only, so the CGK is never a general
        // MAC oracle and never leaves keyd.
        const msg = hexArg(a, "msg", { min: 1, max: MAX_MAC_BYTES });
        const gossip = req.op === "cgk.gossipMac";
        const tag = gossip ? GOSSIP_TAG : ACCESS_SYNC_TAG;
        if (!Buffer.from(msg.subarray(0, tag.length)).equals(Buffer.from(tag))) {
          throw new KeydError("forbidden", `the gossip key MACs ${tag.slice(0, -1)} messages only`);
        const key = gossip ? this.#cgkOrThrow() : hkdf(sha256, this.#cgkOrThrow(), new Uint8Array(0), new TextEncoder().encode(ACCESS_SYNC_KEY_INFO), 32);
        return { result: { mac: toHex(hmac(sha256, key, msg)) } };
      case "tls.createKey": {
        noExtraArgs(a, ["names"]);
        if (!Array.isArray(a.names) || a.names.some((n) => typeof n !== "string")) throw new KeydError("bad-request", "names must be a list of strings");
        const r = this.#tlsOrThrow().createKey(a.names as string[]);
        return { result: { handle: r.handle, spki: r.spkiHex } };
      }
      case "tls.csr": {
        noExtraArgs(a, ["handle"]);
        return { result: { csr: toHex(this.#tlsOrThrow().csr(strArg(a, "handle", 32))) } };
      }
      case "tls.install": {
        noExtraArgs(a, ["handle", "chain"]);
        const chain = pemArg(a, "chain");
        const r = this.#tlsOrThrow().install(strArg(a, "handle", 32), chain);
        return { result: { notBefore: r.notBefore, notAfter: r.notAfter, names: r.names } };
      }
      case "tls.activate": {
        noExtraArgs(a, ["handle"]);
        this.#tlsOrThrow().activate(strArg(a, "handle", 32));
        return { result: { active: true } };
      }
      case "tls.active": {
        noExtraArgs(a, []);
        return { result: { active: this.#tlsOrThrow().active() } };
      }
      case "tls.sign": {
        noExtraArgs(a, ["handle", "digest"]);
        const digest = hexArg(a, "digest", { min: 32, max: 48 });
        return { result: { sig: toHex(this.#tlsOrThrow().sign(strArg(a, "handle", 32), digest)) } };
      }
      case "tls.list":
        noExtraArgs(a, []);
        return { result: { keys: this.#tlsOrThrow().list(), allowedNames: this.#tlsOrThrow().names() } };
      case "tls.remove": {
        noExtraArgs(a, ["handle"]);
        this.#tlsOrThrow().remove(strArg(a, "handle", 32));
        return { result: { removed: true } };
      }
      case "acme.create": {
        noExtraArgs(a, []);
        this.#acmeOrThrow().create();
        return { result: { jwk: this.#acmeOrThrow().jwk() } };
      }
      case "acme.importGranted": {
        // The owner sealed the account key to this box's identity; keyd opens it and keeps it.
        noExtraArgs(a, ["blob"]);
        const blob = hexArg(a, "blob", { min: 44, max: 64 * 1024 });
        let pem: string;
        try {
          pem = new TextDecoder().decode(openSealedFromEd25519Recipient(blob, this.#seed));
        } catch {
          throw new KeydError("failed", "could not open the granted account key");
        }
        this.#acmeOrThrow().importPem(pem);
        return { result: { jwk: this.#acmeOrThrow().jwk() } };
      }
      case "acme.jwk": {
        noExtraArgs(a, []);
        const acct = this.#acmeOrThrow();
        return { result: { present: acct.present, ...(acct.present ? { jwk: acct.jwk(), thumbprint: acct.thumbprint() } : {}) } };
      }
      case "acme.sign": {
        noExtraArgs(a, ["kind", "url", "nonce", "kid", "contact", "names", "handle", "certificate", "reason"]);
        const kind = strArg(a, "kind", 24);
        const base = { url: strArg(a, "url", 512), nonce: strArg(a, "nonce", 128) };
        const kid = () => strArg(a, "kid", 512);
        let req: AcmeRequest;
        switch (kind) {
          case "newAccount": req = { kind, ...base, contact: strArg(a, "contact", 256) }; break;
          case "newOrder":
            if (!Array.isArray(a.names) || a.names.some((n) => typeof n !== "string")) throw new KeydError("bad-request", "names must be a list of strings");
            req = { kind, ...base, kid: kid(), names: a.names as string[] };
            break;
          case "postAsGet": req = { kind, ...base, kid: kid() }; break;
          case "challenge": req = { kind, ...base, kid: kid() }; break;
          case "finalize": req = { kind, ...base, kid: kid(), handle: strArg(a, "handle", 32) }; break;
          case "revoke": req = { kind, ...base, kid: kid(), certificateDer: hexArg(a, "certificate", { min: 64, max: 16 * 1024 }), reason: typeof a.reason === "number" ? a.reason : 0 }; break;
          default: throw new KeydError("bad-request", "unknown ACME request kind");
        }
        return { result: this.#acmeOrThrow().sign(req) };
      }
      case "provision.swk":
      case "provision.cgk": {
        // `sealed` is the owner's delivery sealed to this box: keyd opens it and keeps the key,
        // so it never passes through the daemon. `key` is for a key the daemon already holds
        // (an install-blob or legacy file being moved in).
        noExtraArgs(a, ["key", "sealed"]);
        const which = req.op === "provision.swk" ? "swk" : "cgk";
        if ((a.key === undefined) === (a.sealed === undefined)) throw new KeydError("bad-request", "give key or sealed");
        let key: Uint8Array;
        if (a.sealed !== undefined) {
          const sealed = hexArg(a, "sealed", { min: 44, max: 1024 });
          try {
            key = openSealedFromEd25519Recipient(sealed, this.#seed);
          } catch {
            throw new KeydError("failed", "could not open the sealed key");
          }
          if (key.length !== 32) {
            key.fill(0);
            throw new KeydError("failed", "the sealed key is not 32 bytes");
          }
        } else {
          key = hexArg(a, "key", { exact: 32 });
        }
        const current = which === "swk" ? this.#swk : this.#cgk;
        // A key is provisioned once. Replacing one is a restore or replacement workflow (a new
        // keyd state, made offline by root), never a request over the socket.
        if (current) {
          const same = Buffer.from(current).equals(Buffer.from(key));
          key.fill(0);
          if (same) return { result: { stored: false, already: true } };
          throw new KeydError("forbidden", `${which} is already provisioned`);
        }
        this.#store?.save(which, key);
        if (which === "swk") this.#swk = key.slice();
        else this.#cgk = key.slice();
        key.fill(0);
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

  #acmeOrThrow(): AcmeAccount {
    if (!this.#acme) throw new KeydError("not-provisioned", "this keyd serves no ACME account");
    return this.#acme;
  }

  #tlsOrThrow(): TlsKeys {
    if (!this.#tls) throw new KeydError("not-provisioned", "this keyd serves no TLS keys");
    return this.#tls;
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
