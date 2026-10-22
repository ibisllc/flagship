// Oblivious HTTP (RFC 9458) with Binary HTTP (RFC 9292), for the few calls a
// box behind an outbound proxy makes before its daemon (and the proxy
// connector) exists: setup POSTs to `.com` and the boot-unlock request
// (docs/outbound-proxy.md §OHTTP). A third-party relay sees the box's address
// but only ciphertext; `.com`'s gateway sees the request but only the relay's
// address.
//
// One suite only: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM
// (RFC 9180 ids 0x0020 / 0x0001 / 0x0001), the suite of RFC 9458's example.
// Pure JS (noble), so the same code runs in the Worker, the daemon and Node
// scripts.

import { x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import type { Bytes } from "./types.js";

export const OHTTP_REQUEST_MEDIA_TYPE = "message/ohttp-req";
export const OHTTP_RESPONSE_MEDIA_TYPE = "message/ohttp-res";
export const OHTTP_KEYS_MEDIA_TYPE = "application/ohttp-keys";

export const KEM_X25519_HKDF_SHA256 = 0x0020;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;

const NK = 16;
const NN = 12;
const NH = 32;
const NENC = 32;

const te = new TextEncoder();

function concat(...parts: Bytes[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u16(n: number): Uint8Array {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

// ---------------------------------------------------------------- HPKE (RFC 9180, base mode)

const KEM_SUITE = concat(te.encode("KEM"), u16(KEM_X25519_HKDF_SHA256));
const HPKE_SUITE = concat(te.encode("HPKE"), u16(KEM_X25519_HKDF_SHA256), u16(KDF_HKDF_SHA256), u16(AEAD_AES_128_GCM));
const HPKE_V1 = te.encode("HPKE-v1");

function labeledExtract(suite: Bytes, salt: Bytes, label: string, ikm: Bytes): Uint8Array {
  return hkdfExtract(sha256, concat(HPKE_V1, suite, te.encode(label), ikm), salt);
}

function labeledExpand(suite: Bytes, prk: Bytes, label: string, info: Bytes, len: number): Uint8Array {
  return hkdfExpand(sha256, prk, concat(u16(len), HPKE_V1, suite, te.encode(label), info), len);
}

function kemSharedSecret(dh: Bytes, enc: Bytes, pkR: Bytes): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, eaePrk, "shared_secret", concat(enc, pkR), 32);
}

interface HpkeContext {
  key: Uint8Array;
  baseNonce: Uint8Array;
  exporterSecret: Uint8Array;
}

function keySchedule(sharedSecret: Bytes, info: Bytes): HpkeContext {
  const empty = new Uint8Array(0);
  const pskIdHash = labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty);
  const infoHash = labeledExtract(HPKE_SUITE, empty, "info_hash", info);
  const ctx = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", empty);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", ctx, NK),
    baseNonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, NN),
    exporterSecret: labeledExpand(HPKE_SUITE, secret, "exp", ctx, NH),
  };
}

function hpkeExport(ctx: HpkeContext, exporterContext: Bytes, len: number): Uint8Array {
  return labeledExpand(HPKE_SUITE, ctx.exporterSecret, "sec", exporterContext, len);
}

// ---------------------------------------------------------------- key configuration (RFC 9458 §3)

export interface OhttpKeyConfig {
  keyId: number;
  /** X25519 public key, 32 bytes. */
  publicKey: Uint8Array;
}

export interface OhttpGatewayKey extends OhttpKeyConfig {
  /** X25519 private key, 32 bytes. */
  privateKey: Uint8Array;
}

/** A gateway key from a 32-byte X25519 private key. */
export function ohttpGatewayKey(keyId: number, privateKey: Bytes): OhttpGatewayKey {
  if (!Number.isInteger(keyId) || keyId < 0 || keyId > 255) throw new Error("keyId must be 0..255");
  if (privateKey.length !== 32) throw new Error("privateKey must be 32 bytes");
  return { keyId, privateKey: Uint8Array.from(privateKey), publicKey: x25519.getPublicKey(privateKey) };
}

/** One key configuration: key id, KEM, public key, and the one suite we support. */
export function encodeOhttpKeyConfig(c: OhttpKeyConfig): Uint8Array {
  return concat(
    Uint8Array.of(c.keyId),
    u16(KEM_X25519_HKDF_SHA256),
    c.publicKey,
    u16(4),
    u16(KDF_HKDF_SHA256),
    u16(AEAD_AES_128_GCM),
  );
}

/** `application/ohttp-keys` (RFC 9540): each configuration prefixed with its 2-byte length. */
export function encodeOhttpKeys(configs: readonly OhttpKeyConfig[]): Uint8Array {
  return concat(
    ...configs.map((c) => {
      const one = encodeOhttpKeyConfig(c);
      return concat(u16(one.length), one);
    }),
  );
}

/** Parse one key configuration; null unless it offers our KEM and suite. */
export function parseOhttpKeyConfig(b: Bytes): OhttpKeyConfig | null {
  if (b.length < 1 + 2 + NENC + 2) return null;
  const kem = (b[1]! << 8) | b[2]!;
  if (kem !== KEM_X25519_HKDF_SHA256) return null;
  const publicKey = Uint8Array.from(b.subarray(3, 3 + NENC));
  let o = 3 + NENC;
  const len = (b[o]! << 8) | b[o + 1]!;
  o += 2;
  if (len % 4 !== 0 || o + len !== b.length) return null;
  for (let i = o; i < o + len; i += 4) {
    const kdf = (b[i]! << 8) | b[i + 1]!;
    const aead = (b[i + 2]! << 8) | b[i + 3]!;
    if (kdf === KDF_HKDF_SHA256 && aead === AEAD_AES_128_GCM) return { keyId: b[0]!, publicKey };
  }
  return null;
}

/** Parse `application/ohttp-keys`; returns the configurations we can use. */
export function parseOhttpKeys(b: Bytes): OhttpKeyConfig[] {
  const out: OhttpKeyConfig[] = [];
  let o = 0;
  while (o + 2 <= b.length) {
    const len = (b[o]! << 8) | b[o + 1]!;
    o += 2;
    if (o + len > b.length) break;
    const c = parseOhttpKeyConfig(b.subarray(o, o + len));
    if (c) out.push(c);
    o += len;
  }
  return out;
}

// ---------------------------------------------------------------- encapsulation (RFC 9458 §4)

const REQUEST_LABEL = te.encode("message/bhttp request");
const RESPONSE_LABEL = te.encode("message/bhttp response");
const SECRET_LEN = Math.max(NN, NK);

function header(keyId: number): Uint8Array {
  return concat(Uint8Array.of(keyId), u16(KEM_X25519_HKDF_SHA256), u16(KDF_HKDF_SHA256), u16(AEAD_AES_128_GCM));
}

/** What a side keeps to seal or open the response. */
export interface OhttpResponseContext {
  enc: Uint8Array;
  secret: Uint8Array;
}

/** Client: encrypt `request` (Binary HTTP) for the gateway. `ephemeralPrivateKey` is a test seam. */
export function encapsulateOhttpRequest(
  config: OhttpKeyConfig,
  request: Bytes,
  ephemeralPrivateKey?: Bytes,
): { encapsulated: Uint8Array; context: OhttpResponseContext } {
  const skE = ephemeralPrivateKey ? Uint8Array.from(ephemeralPrivateKey) : x25519.utils.randomSecretKey();
  const enc = x25519.getPublicKey(skE);
  const dh = x25519.getSharedSecret(skE, config.publicKey);
  const hdr = header(config.keyId);
  const ctx = keySchedule(kemSharedSecret(dh, enc, config.publicKey), concat(REQUEST_LABEL, Uint8Array.of(0), hdr));
  const ct = gcm(ctx.key, ctx.baseNonce).encrypt(request);
  return {
    encapsulated: concat(hdr, enc, ct),
    context: { enc, secret: hpkeExport(ctx, RESPONSE_LABEL, SECRET_LEN) },
  };
}

export class OhttpError extends Error {
  constructor(
    readonly code: "key" | "format" | "decrypt",
    message: string,
  ) {
    super(message);
    this.name = "OhttpError";
  }
}

/** Gateway: decrypt an Encapsulated Request with whichever key its id names. */
export function decapsulateOhttpRequest(
  keys: readonly OhttpGatewayKey[],
  encapsulated: Bytes,
): { request: Uint8Array; context: OhttpResponseContext } {
  if (encapsulated.length < 7 + NENC + 16) throw new OhttpError("format", "encapsulated request too short");
  const keyId = encapsulated[0]!;
  const kem = (encapsulated[1]! << 8) | encapsulated[2]!;
  const kdf = (encapsulated[3]! << 8) | encapsulated[4]!;
  const aead = (encapsulated[5]! << 8) | encapsulated[6]!;
  const key = keys.find((k) => k.keyId === keyId);
  if (!key || kem !== KEM_X25519_HKDF_SHA256 || kdf !== KDF_HKDF_SHA256 || aead !== AEAD_AES_128_GCM) {
    throw new OhttpError("key", "unknown key or suite");
  }
  const hdr = encapsulated.subarray(0, 7);
  const enc = Uint8Array.from(encapsulated.subarray(7, 7 + NENC));
  const ct = encapsulated.subarray(7 + NENC);
  let ctx: HpkeContext;
  let request: Uint8Array;
  try {
    const dh = x25519.getSharedSecret(key.privateKey, enc);
    ctx = keySchedule(kemSharedSecret(dh, enc, key.publicKey), concat(REQUEST_LABEL, Uint8Array.of(0), hdr));
    request = gcm(ctx.key, ctx.baseNonce).decrypt(ct);
  } catch {
    throw new OhttpError("decrypt", "could not decrypt the request");
  }
  return { request, context: { enc, secret: hpkeExport(ctx, RESPONSE_LABEL, SECRET_LEN) } };
}

function responseAead(context: OhttpResponseContext, responseNonce: Bytes) {
  const prk = hkdfExtract(sha256, context.secret, concat(context.enc, responseNonce));
  return gcm(hkdfExpand(sha256, prk, te.encode("key"), NK), hkdfExpand(sha256, prk, te.encode("nonce"), NN));
}

/** Gateway: encrypt `response` (Binary HTTP). `responseNonce` is a test seam. */
export function encapsulateOhttpResponse(context: OhttpResponseContext, response: Bytes, responseNonce?: Bytes): Uint8Array {
  const nonce = responseNonce ? Uint8Array.from(responseNonce) : randomBytes(SECRET_LEN);
  return concat(nonce, responseAead(context, nonce).encrypt(response));
}

/** Client: decrypt an Encapsulated Response. */
export function decapsulateOhttpResponse(context: OhttpResponseContext, encapsulated: Bytes): Uint8Array {
  if (encapsulated.length < SECRET_LEN + 16) throw new OhttpError("format", "encapsulated response too short");
  try {
    return responseAead(context, encapsulated.subarray(0, SECRET_LEN)).decrypt(encapsulated.subarray(SECRET_LEN));
  } catch {
    throw new OhttpError("decrypt", "could not decrypt the response");
  }
}

// ---------------------------------------------------------------- Binary HTTP, known-length (RFC 9292)

export interface BhttpRequest {
  method: string;
  scheme: string;
  authority: string;
  path: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export interface BhttpResponse {
  status: number;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

function varint(n: number): Uint8Array {
  if (n < 0x40) return Uint8Array.of(n);
  if (n < 0x4000) return Uint8Array.of(0x40 | (n >> 8), n & 0xff);
  if (n < 0x40000000) return Uint8Array.of(0x80 | (n >>> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  throw new Error("value too large");
}

class Reader {
  o = 0;
  constructor(readonly b: Bytes) {}
  done(): boolean {
    return this.o >= this.b.length;
  }
  varint(): number {
    const first = this.b[this.o];
    if (first === undefined) throw new OhttpError("format", "truncated message");
    const len = 1 << (first >> 6);
    if (this.o + len > this.b.length) throw new OhttpError("format", "truncated message");
    if (len === 8) throw new OhttpError("format", "value too large");
    let v = first & 0x3f;
    for (let i = 1; i < len; i++) v = v * 256 + this.b[this.o + i]!;
    this.o += len;
    return v;
  }
  bytes(): Uint8Array {
    const n = this.varint();
    if (this.o + n > this.b.length) throw new OhttpError("format", "truncated message");
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return Uint8Array.from(out);
  }
  text(): string {
    return new TextDecoder().decode(this.bytes());
  }
  /** A field section; an absent (truncated) one is empty. */
  fields(): Array<[string, string]> {
    if (this.done()) return [];
    const section = new Reader(this.bytes());
    const out: Array<[string, string]> = [];
    while (!section.done()) out.push([section.text(), section.text()]);
    return out;
  }
}

function lp(b: Bytes): Uint8Array {
  return concat(varint(b.length), b);
}

function fieldSection(headers: Array<[string, string]>): Uint8Array {
  return lp(concat(...headers.map(([n, v]) => concat(lp(te.encode(n.toLowerCase())), lp(te.encode(v))))));
}

export function encodeBhttpRequest(r: BhttpRequest): Uint8Array {
  return concat(
    varint(0),
    lp(te.encode(r.method)),
    lp(te.encode(r.scheme)),
    lp(te.encode(r.authority)),
    lp(te.encode(r.path)),
    fieldSection(r.headers),
    lp(r.body),
    varint(0),
  );
}

export function decodeBhttpRequest(b: Bytes): BhttpRequest {
  const r = new Reader(b);
  if (r.varint() !== 0) throw new OhttpError("format", "not a known-length request");
  const method = r.text();
  const scheme = r.text();
  const authority = r.text();
  const path = r.text();
  const headers = r.fields();
  const body = r.done() ? new Uint8Array(0) : r.bytes();
  return { method, scheme, authority, path, headers, body };
}

export function encodeBhttpResponse(r: BhttpResponse): Uint8Array {
  return concat(varint(1), varint(r.status), fieldSection(r.headers), lp(r.body), varint(0));
}

export function decodeBhttpResponse(b: Bytes): BhttpResponse {
  const r = new Reader(b);
  if (r.varint() !== 1) throw new OhttpError("format", "not a known-length response");
  let status = r.varint();
  while (status >= 100 && status < 200) {
    r.fields();
    status = r.varint();
  }
  const headers = r.fields();
  const body = r.done() ? new Uint8Array(0) : r.bytes();
  return { status, headers, body };
}
