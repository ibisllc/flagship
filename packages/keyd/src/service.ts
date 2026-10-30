import { hkdfSync } from "node:crypto";
import {
  checkMasterEvidence,
  decryptChunk,
  deriveBackupManifestKey,
  deriveServiceMemberStableId,
  deriveServiceSecret,
  ed,
  encryptChunk,
  hybridSign,
  hybridSigKeygen,
  openLlmPayload,
  openGossip,
  openSealedFromEd25519Recipient,
  sealGossip,
  sealLlmPayload,
  validatePurposeTag,
} from "@flagship/protocol";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { BOX_SIGN_PURPOSES, SWK_HKDF_LABELS, UNSEAL_PURPOSES, checkSign, isPairingOrder, isServiceId } from "./policy.js";
import { AcmeAccount, type AcmeRequest } from "./acme.js";
import { accountZoneOf, namesFor } from "./migrate.js";
import { renameSync, writeFileSync } from "node:fs";
import { TlsKeys, isEcdheParams, tls12ServerSignedMessage, tls13ServerSignedMessage } from "./tls.js";
import { KEYD_PROTOCOL_VERSION, KeydError, hexArg, noExtraArgs, pemArg, strArg, toHex, type KeydRequest } from "./wire.js";

const GOSSIP_TAG = "flagship/gossip/v2|";
const ACCESS_SYNC_TAG = "flagship/access-sync/v1|";
const ACCESS_SYNC_KEY_INFO = "flagship/access-sync/key/v1";
const MAX_MAC_BYTES = 64 * 1024;

export interface KeyStore {
  /** Persist a provisioned secret (0400, owned by the keyd user). */
  save(name: "swk" | "cgk" | "identity-mldsa", bytes: Uint8Array): void;
}

export interface KeydServiceInit {
  identitySeed: Uint8Array;
  /** The STK's ML-DSA-65 seed (`identity-mldsa.key`); absent means no hybrid signing. */
  pqSeed?: Uint8Array | undefined;
  swk?: Uint8Array | undefined;
  cgk?: Uint8Array | undefined;
  store?: KeyStore;
  signPurposes?: ReadonlySet<string>;
  /** TLS leaf keys; absent means this keyd serves no TLS operations. */
  tls?: TlsKeys;
  /** The ACME account key; needs `tls`. */
  acme?: AcmeAccount;
  /**
   * The authority a sealed SWK/CGK delivery must be signed by: the owner's account key (IRK) and
   * this box's name, pinned in keyd's state by root at the boot ceremony (`owner.json`, written by
   * `migrate`). Absent: no sealed delivery is accepted.
   */
  owner?: { irkPubHex: string; serverFqdn: string; adminRootPubHex?: string | null } | null;
  /**
   * The boot ceremony's one-time token (root wrote it beside keyd's state at this start) and
   * until when it lets a raw key in. Absent: no raw key is accepted over the socket.
   */
  ceremony?: { token: Uint8Array; notAfter: number } | null;
  /** Where the box's `policy.json` lives, so an owner-signed move to another name can be kept. */
  policyPath?: string;
  now?: () => number;
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
  readonly #pqSeed: Uint8Array | null;
  readonly #mldsaPubHex: string | null;
  #swk: Uint8Array | null;
  #cgk: Uint8Array | null;
  readonly #store: KeyStore | undefined;
  readonly #purposes: ReadonlySet<string>;
  readonly #tls: TlsKeys | null;
  readonly #acme: AcmeAccount | null;
  #owner: { irkPub: Uint8Array; serverFqdn: string; adminRootPubHex: string | null } | null;
  readonly #policyPath: string | null;
  #ceremony: { token: Uint8Array; notAfter: number } | null;
  readonly #now: () => number;

  constructor(init: KeydServiceInit) {
    if (init.identitySeed.length !== 32) throw new Error("keyd: identity seed must be 32 bytes");
    this.#seed = init.identitySeed.slice();
    this.#pub = ed.getPublicKey(this.#seed);
    this.#pubHex = toHex(this.#pub);
    if (init.pqSeed !== undefined && init.pqSeed.length !== 32) throw new Error("keyd: ML-DSA seed must be 32 bytes");
    this.#pqSeed = init.pqSeed ? init.pqSeed.slice() : null;
    this.#mldsaPubHex = this.#pqSeed ? toHex(hybridSigKeygen(this.#seed, this.#pqSeed).publicKey.subarray(32)) : null;
    this.#swk = init.swk ? init.swk.slice() : null;
    this.#cgk = init.cgk ? init.cgk.slice() : null;
    this.#store = init.store;
    this.#purposes = init.signPurposes ?? BOX_SIGN_PURPOSES;
    this.#tls = init.tls ?? null;
    this.#acme = init.acme ?? null;
    this.#owner =
      init.owner && /^[0-9a-f]{64}$/.test(init.owner.irkPubHex) && init.owner.serverFqdn
        ? {
            irkPub: Uint8Array.from(Buffer.from(init.owner.irkPubHex, "hex")),
            serverFqdn: init.owner.serverFqdn.toLowerCase(),
            adminRootPubHex: init.owner.adminRootPubHex && /^[0-9a-f]{64}$/.test(init.owner.adminRootPubHex) ? init.owner.adminRootPubHex : null,
          }
        : null;
    this.#ceremony = init.ceremony && init.ceremony.token.length === 32 ? { token: init.ceremony.token.slice(), notAfter: init.ceremony.notAfter } : null;
    this.#policyPath = init.policyPath ?? null;
    this.#now = init.now ?? Date.now;
  }

  get publicKeyHex(): string {
    return this.#pubHex;
  }

  /** Zero the key material (shutdown). */
  destroy(): void {
    this.#seed.fill(0);
    this.#pqSeed?.fill(0);
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
      case "sign.identity": {
        // A `master` identity assertion (identityAssertion.ts checkMasterEvidence): signed only with
        // the owner's evidence for that very sign-in key, checked here against owner.json and the
        // SWK, never on the daemon's word.
        noExtraArgs(a, ["msg", "appId", "identityPubHex", "statement", "signatureHex", "signInPubHex"]);
        const msg = hexArg(a, "msg", { min: 1, max: 4096 });
        const purpose = checkSign(msg, this.#pubHex, this.#purposes, { masterEvidence: true });
        if (!this.#owner) throw new KeydError("forbidden", "no owner key is pinned for this box");
        const swk = this.#swkOrThrow();
        const ev = {
          appId: strArg(a, "appId", 128),
          identityPubHex: strArg(a, "identityPubHex", 64),
          statement: strArg(a, "statement", 4096),
          signatureHex: strArg(a, "signatureHex", 128),
          ...(a.signInPubHex !== undefined ? { signInPubHex: strArg(a, "signInPubHex", 64) } : {}),
        };
        if (!isServiceId(ev.appId)) throw new KeydError("bad-request", "appId must be <creator>--<slug> or <slug>");
        const refused = checkMasterEvidence(
          new TextDecoder().decode(msg),
          ev,
          { irkPubHex: toHex(this.#owner.irkPub), adminRootPubHex: this.#owner.adminRootPubHex },
          this.#now(),
          (app, pub) => deriveServiceMemberStableId(deriveServiceSecret(swk, app), pub),
          (sig, m, pub) => {
            try {
              return ed.verify(Buffer.from(sig, "hex"), m, Buffer.from(pub, "hex"));
            } catch {
              return false;
            }
          },
        );
        if (refused) throw new KeydError("forbidden", `master needs the owner's evidence for this key (${refused})`);
        return { result: { sig: toHex(ed.sign(msg, this.#seed)) }, purpose };
      }
      case "pq.status":
        noExtraArgs(a, []);
        return { result: { publicKey: this.#pubHex, mldsaPublicKey: this.#mldsaPubHexOrThrow() } };
      case "sign.hybrid": {
        // The same purpose list as `sign`, signed with the STK AND its ML-DSA-65 key
        // (flagship/hybrid-sig/ed25519-mldsa65/v1, purpose = the message's own tag).
        noExtraArgs(a, ["msg"]);
        const msg = hexArg(a, "msg", { min: 1 });
        const mldsaPubHex = this.#mldsaPubHexOrThrow();
        const purpose = checkSign(msg, this.#pubHex, this.#purposes, { mldsaPubHex });
        if (!validatePurposeTag(purpose)) throw new KeydError("forbidden", "that purpose has no hybrid form");
        const sk = new Uint8Array(64);
        sk.set(this.#seed, 0);
        sk.set(this.#pqSeed!, 32);
        try {
          return { result: { sig: toHex(hybridSign(sk, purpose, msg)) }, purpose };
        } finally {
          sk.fill(0);
        }
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
      case "cgk.gossipMac":
      case "cgk.accessSyncMac": {
        // A MAC over the box's own two gossip message kinds only, so the CGK is never a general
        // MAC oracle and never leaves keyd.
        noExtraArgs(a, ["msg"]);
        const msg = hexArg(a, "msg", { min: 1, max: MAX_MAC_BYTES });
        const gossip = req.op === "cgk.gossipMac";
        const tag = gossip ? GOSSIP_TAG : ACCESS_SYNC_TAG;
        if (!Buffer.from(msg.subarray(0, tag.length)).equals(Buffer.from(tag))) {
          throw new KeydError("forbidden", `the gossip key MACs ${tag.slice(0, -1)} messages only`);
        }
        const key = gossip ? this.#cgkOrThrow() : hkdf(sha256, this.#cgkOrThrow(), new Uint8Array(0), new TextEncoder().encode(ACCESS_SYNC_KEY_INFO), 32);
        return { result: { mac: toHex(hmac(sha256, key, msg)) } };
      }
      case "policy.rename": {
        // The owner moves this box to another name in the same account (Migrate: the replacement takes the retired
        // server's name). keyd takes the new name only from the owner's own signed root entitlement for THIS key, never
        // on the daemon's word, and only inside the account zone the box already sits in.
        noExtraArgs(a, ["username", "podCanonical", "issuedAt", "signatureHex"]);
        if (!this.#owner) throw new KeydError("forbidden", "no owner key is pinned for this box");
        const username = strArg(a, "username", 64);
        const canonical = strArg(a, "podCanonical", 253).toLowerCase();
        if (typeof a.issuedAt !== "number" || !Number.isSafeInteger(a.issuedAt) || a.issuedAt < 0) throw new KeydError("bad-request", "issuedAt must be a non-negative integer");
        const sig = strArg(a, "signatureHex", 128);
        if (!/^[0-9a-f]{128}$/.test(sig)) throw new KeydError("bad-request", "signatureHex must be 128 hex characters");
        const zone = accountZoneOf(canonical);
        if (zone === null || zone !== accountZoneOf(this.#owner.serverFqdn)) throw new KeydError("forbidden", "a box moves only within its own account");
        const statement = new TextEncoder().encode(["flagship/root-entitlement/v1", username, this.#pubHex, canonical, a.issuedAt].join("|"));
        const signer = this.#owner.adminRootPubHex ?? toHex(this.#owner.irkPub);
        let ok = false;
        try {
          ok = ed.verify(Buffer.from(sig, "hex"), statement, Buffer.from(signer, "hex"));
        } catch {
          ok = false;
        }
        if (!ok) throw new KeydError("forbidden", "the owner did not sign this move for this box");
        if (canonical !== this.#owner.serverFqdn) {
          if (this.#policyPath) {
            writeFileSync(`${this.#policyPath}.tmp`, JSON.stringify({ serverFqdn: canonical }), { mode: 0o400 });
            renameSync(`${this.#policyPath}.tmp`, this.#policyPath);
          }
          this.#owner = { ...this.#owner, serverFqdn: canonical };
          this.#tls?.setAllowedNames(new Set(namesFor(canonical)));
        }
        return { result: { serverFqdn: canonical } };
      }
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
        // keyd builds the signed input itself from the TLS fields, so the certificate key signs
        // TLS 1.3 CertificateVerify and TLS 1.2 ServerKeyExchange inputs and nothing else.
        const handle = strArg(a, "handle", 32);
        const version = strArg(a, "tls", 8);
        let message: Uint8Array;
        if (version === "1.3") {
          noExtraArgs(a, ["handle", "tls", "transcriptHash"]);
          const th = hexArg(a, "transcriptHash", { min: 32, max: 48 });
          if (th.length !== 32 && th.length !== 48) throw new KeydError("bad-request", "transcriptHash must be 32 or 48 bytes");
          message = tls13ServerSignedMessage(th);
        } else if (version === "1.2") {
          noExtraArgs(a, ["handle", "tls", "clientRandom", "serverRandom", "params"]);
          const cr = hexArg(a, "clientRandom", { exact: 32 });
          const sr = hexArg(a, "serverRandom", { exact: 32 });
          const params = hexArg(a, "params", { min: 4, max: 4 + 133 });
          if (!isEcdheParams(params)) throw new KeydError("bad-request", "params must be named-curve ECDHE parameters");
          message = tls12ServerSignedMessage(cr, sr, params);
        } else {
          throw new KeydError("bad-request", "tls must be 1.3 or 1.2");
        }
        return { result: { sig: toHex(this.#tlsOrThrow().signHandshake(handle, message)) } };
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
        // A key slot is filled only on proof of authority, never by whoever writes first:
        // `sealed` is the owner's delivery sealed to this box, with the owner's signature over
        // `flagship/<swk|cgk>-delivery/v1|<server>|<sealed>|<issuedAt>` under the owner key root
        // pinned at the boot ceremony; keyd checks it, opens it and keeps the key, so it never
        // passes through the daemon. `key` is a key the box already held (an install blob or a
        // legacy file), let in only with the boot ceremony's one-time token while it is valid.
        noExtraArgs(a, ["key", "sealed", "serverDomain", "issuedAt", "signature", "ceremony"]);
        const which = req.op === "provision.swk" ? "swk" : "cgk";
        if ((a.key === undefined) === (a.sealed === undefined)) throw new KeydError("bad-request", "give key or sealed");
        let key: Uint8Array;
        if (a.sealed !== undefined) {
          const sealed = hexArg(a, "sealed", { min: 44, max: 1024 });
          const domain = strArg(a, "serverDomain", 253);
          if (typeof a.issuedAt !== "number" || !Number.isSafeInteger(a.issuedAt) || a.issuedAt < 0) {
            throw new KeydError("bad-request", "issuedAt must be a non-negative integer");
          }
          const signature = hexArg(a, "signature", { exact: 64 });
          if (!this.#owner) throw new KeydError("forbidden", "no owner key is pinned for this box");
          const signed = new TextEncoder().encode(`flagship/${which}-delivery/v1|${domain}|${toHex(sealed)}|${a.issuedAt}`);
          let ok = false;
          try {
            ok = domain.toLowerCase() === this.#owner.serverFqdn && ed.verify(signature, signed, this.#owner.irkPub);
          } catch {
            ok = false;
          }
          if (!ok) throw new KeydError("forbidden", "the owner did not sign this delivery for this box");
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
          if (a.serverDomain !== undefined || a.issuedAt !== undefined || a.signature !== undefined) {
            throw new KeydError("bad-request", "a raw key carries only the ceremony token");
          }
          key = hexArg(a, "key", { exact: 32 });
          const token = hexArg(a, "ceremony", { exact: 32 });
          const c = this.#ceremony;
          if (!c || this.#now() > c.notAfter || !Buffer.from(c.token).equals(Buffer.from(token))) {
            key.fill(0);
            throw new KeydError("forbidden", "a raw key is let in only during the boot ceremony");
          }
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
        // The ceremony token lets each empty slot in once; with both filled it is spent.
        if (this.#swk && this.#cgk && this.#ceremony) {
          this.#ceremony.token.fill(0);
          this.#ceremony = null;
        }
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

  #mldsaPubHexOrThrow(): string {
    if (!this.#mldsaPubHex) throw new KeydError("not-provisioned", "no ML-DSA key provisioned");
    return this.#mldsaPubHex;
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
