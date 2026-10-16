/**
 * RSA blind signatures, RFC 9474 RSABSSA-SHA384-PSS-Randomized.
 *
 * The signer signs a value it can't see; the client unblinds the signature
 * into an ordinary RSASSA-PSS (SHA-384, 48-byte salt) signature on its own
 * message. Anyone with the public key verifies it with a standard PSS verify,
 * and the signer can't tell which signing produced which signature.
 *
 * Used for peer-backup space tokens (docs/peer-backup.md §5.4). Pure BigInt:
 * the same code runs on the box, in the Worker and in tests.
 */
import { sha384 } from "@noble/hashes/sha512";
import type { Bytes } from "./types.js";

export interface RsaPublicKey {
  n: bigint;
  e: bigint;
}

export interface RsaPrivateKey extends RsaPublicKey {
  d: bigint;
  p: bigint;
  q: bigint;
  dp: bigint;
  dq: bigint;
  qi: bigint;
}

const H_LEN = 48;
const S_LEN = 48;
const PREFIX_LEN = 32;

function b64uToBigInt(s: string): bigint {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  let hexStr = "";
  for (let i = 0; i < bin.length; i++) hexStr += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return hexStr.length === 0 ? 0n : BigInt("0x" + hexStr);
}

function bigIntToB64u(x: bigint): string {
  let h = x.toString(16);
  if (h.length % 2) h = "0" + h;
  let bin = "";
  for (let i = 0; i < h.length; i += 2) bin += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A private key from its JWK (the Worker secret's form). */
export function rsaPrivateKeyFromJwk(jwk: Record<string, unknown>): RsaPrivateKey {
  const need = ["n", "e", "d", "p", "q", "dp", "dq", "qi"] as const;
  for (const k of need) if (typeof jwk[k] !== "string") throw new Error(`RSA JWK is missing ${k}`);
  const g = (k: (typeof need)[number]) => b64uToBigInt(jwk[k] as string);
  return { n: g("n"), e: g("e"), d: g("d"), p: g("p"), q: g("q"), dp: g("dp"), dq: g("dq"), qi: g("qi") };
}

export function rsaPublicKeyFromJwk(jwk: Record<string, unknown>): RsaPublicKey {
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error("RSA JWK is missing n or e");
  return { n: b64uToBigInt(jwk.n), e: b64uToBigInt(jwk.e) };
}

export function rsaPublicKeyToJwk(pk: RsaPublicKey): { kty: "RSA"; n: string; e: string } {
  return { kty: "RSA", n: bigIntToB64u(pk.n), e: bigIntToB64u(pk.e) };
}

export function modulusBytes(pk: RsaPublicKey): number {
  return Math.ceil(bitLength(pk.n) / 8);
}

function bitLength(x: bigint): number {
  return x.toString(2).length;
}

export function bytesToInt(b: Bytes): bigint {
  let h = "";
  for (const x of b) h += x.toString(16).padStart(2, "0");
  return h.length === 0 ? 0n : BigInt("0x" + h);
}

export function intToBytes(x: bigint, len: number): Bytes {
  let h = x.toString(16);
  if (h.length > len * 2) throw new Error("integer too large");
  h = h.padStart(len * 2, "0");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n;
  let b = ((base % m) + m) % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function modInv(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("not invertible");
  return ((oldS % m) + m) % m;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function mgf1(seed: Bytes, len: number): Bytes {
  const out = new Uint8Array(len);
  let off = 0;
  for (let c = 0; off < len; c++) {
    const ctr = new Uint8Array([(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]);
    const h = sha384(concat(seed, ctr));
    out.set(h.subarray(0, Math.min(h.length, len - off)), off);
    off += h.length;
  }
  return out;
}

function emsaPssEncode(msg: Bytes, emBits: number, salt: Bytes): Bytes {
  const emLen = Math.ceil(emBits / 8);
  const mHash = sha384(msg);
  if (emLen < H_LEN + S_LEN + 2) throw new Error("modulus too small");
  const h = sha384(concat(new Uint8Array(8), mHash, salt));
  const db = new Uint8Array(emLen - H_LEN - 1);
  db[emLen - S_LEN - H_LEN - 2] = 0x01;
  db.set(salt, emLen - S_LEN - H_LEN - 1);
  const mask = mgf1(h, db.length);
  for (let i = 0; i < db.length; i++) db[i] = db[i]! ^ mask[i]!;
  db[0] = db[0]! & (0xff >>> (8 * emLen - emBits));
  return concat(db, h, new Uint8Array([0xbc]));
}

function emsaPssVerify(msg: Bytes, em: Bytes, emBits: number): boolean {
  const emLen = Math.ceil(emBits / 8);
  if (em.length !== emLen || emLen < H_LEN + S_LEN + 2 || em[emLen - 1] !== 0xbc) return false;
  const maskedDb = em.subarray(0, emLen - H_LEN - 1);
  const h = em.subarray(emLen - H_LEN - 1, emLen - 1);
  const topMask = 0xff >>> (8 * emLen - emBits);
  if ((maskedDb[0]! & ~topMask & 0xff) !== 0) return false;
  const mask = mgf1(h, maskedDb.length);
  const db = new Uint8Array(maskedDb.length);
  for (let i = 0; i < db.length; i++) db[i] = maskedDb[i]! ^ mask[i]!;
  db[0] = db[0]! & topMask;
  const psLen = emLen - H_LEN - S_LEN - 2;
  for (let i = 0; i < psLen; i++) if (db[i] !== 0) return false;
  if (db[psLen] !== 0x01) return false;
  const salt = db.subarray(db.length - S_LEN);
  const h2 = sha384(concat(new Uint8Array(8), sha384(msg), salt));
  if (h2.length !== h.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h2[i]! ^ h[i]!;
  return diff === 0;
}

function randomBytes(n: number): Bytes {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** RFC 9474 §4.1 Prepare (randomized): 32 random bytes in front of the message. */
export function blindPrepare(msg: Bytes, prefix: Bytes = randomBytes(PREFIX_LEN)): Bytes {
  if (prefix.length !== PREFIX_LEN) throw new Error("prefix must be 32 bytes");
  return concat(prefix, msg);
}

export interface BlindingState {
  blindedMsg: Bytes;
  inv: bigint;
}

/** RFC 9474 §4.2 Blind. `salt` and `r` are for test vectors only. */
export function rsaBlind(
  pk: RsaPublicKey,
  preparedMsg: Bytes,
  opts: { salt?: Bytes; r?: bigint } = {},
): BlindingState {
  const kLen = modulusBytes(pk);
  const salt = opts.salt ?? randomBytes(S_LEN);
  const em = emsaPssEncode(preparedMsg, bitLength(pk.n) - 1, salt);
  const m = bytesToInt(em);
  if (gcd(m, pk.n) !== 1n) throw new Error("invalid input");
  let r = opts.r;
  if (r === undefined) {
    do {
      r = bytesToInt(randomBytes(kLen)) % pk.n;
    } while (r < 2n || gcd(r, pk.n) !== 1n);
  }
  const inv = modInv(r, pk.n);
  const z = (m * modPow(r, pk.e, pk.n)) % pk.n;
  return { blindedMsg: intToBytes(z, kLen), inv };
}

/** RFC 9474 §4.3 BlindSign, with CRT and the result checked before it is returned. */
export function rsaBlindSign(sk: RsaPrivateKey, blindedMsg: Bytes): Bytes {
  const kLen = modulusBytes(sk);
  if (blindedMsg.length !== kLen) throw new Error("blinded message has the wrong length");
  const m = bytesToInt(blindedMsg);
  if (m >= sk.n) throw new Error("blinded message out of range");
  const s1 = modPow(m, sk.dp, sk.p);
  const s2 = modPow(m, sk.dq, sk.q);
  const h = (sk.qi * (((s1 - s2) % sk.p) + sk.p)) % sk.p;
  const s = s2 + h * sk.q;
  if (modPow(s, sk.e, sk.n) !== m) throw new Error("signing failure");
  return intToBytes(s, kLen);
}

/** RFC 9474 §4.4 Finalize: unblind and verify. */
export function rsaFinalize(pk: RsaPublicKey, preparedMsg: Bytes, blindSig: Bytes, inv: bigint): Bytes {
  const kLen = modulusBytes(pk);
  if (blindSig.length !== kLen) throw new Error("blind signature has the wrong length");
  const s = (bytesToInt(blindSig) * inv) % pk.n;
  const sig = intToBytes(s, kLen);
  if (!rsaPssVerify(pk, preparedMsg, sig)) throw new Error("the signer's blind signature doesn't verify");
  return sig;
}

/** RSASSA-PSS-VERIFY (SHA-384, MGF1-SHA-384, 48-byte salt). */
export function rsaPssVerify(pk: RsaPublicKey, msg: Bytes, sig: Bytes): boolean {
  const kLen = modulusBytes(pk);
  if (sig.length !== kLen) return false;
  const s = bytesToInt(sig);
  if (s >= pk.n) return false;
  const m = modPow(s, pk.e, pk.n);
  const emBits = bitLength(pk.n) - 1;
  const emLen = Math.ceil(emBits / 8);
  let em: Bytes;
  try {
    em = intToBytes(m, emLen);
  } catch {
    return false;
  }
  return emsaPssVerify(msg, em, emBits);
}
