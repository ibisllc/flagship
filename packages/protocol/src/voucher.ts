/**
 * The $1 voucher (docs/payments-privacy-and-rails.md §5, docs/anonymous-vouchers.md): one RFC 9474
 * RSABSSA-SHA384-PSS-Randomized blind signature over a random nonce. The buyer's device makes the nonce, blinds it,
 * `.com` signs blind after a rail confirms payment, the device unblinds. At redemption `.com` checks its own
 * signature but can't tell which signing produced it. Shared vectors: packages/protocol/test-vectors/vouchers/.
 *
 *   key       {keyId, nHex, eHex}: nHex = the modulus, big-endian, padded to whole bytes, lowercase; eHex = the
 *             exponent, minimal whole bytes ("010001").
 *   keyId     first 16 hex of SHA-256("flagship/voucher-key/v1|" + nHex + "|" + eHex)
 *   message   "flagship/voucher/v1|" (UTF-8) followed by the 32-byte nonce
 *   prepared  prefix (32 random bytes, RFC 9474 §4.1) followed by the message
 *   voucher   {k: keyId, p: hex prefix, n: hex nonce, s: standard base64 of the PSS signature over `prepared`}
 *   nullifier SHA-256 hex of "flagship/voucher-nullifier/v1|" + k + "|" + n: what `.com` records when it is spent
 *
 * Every voucher is worth one unit (1 USD) and looks the same whatever paid for it.
 */
import { sha256 } from "@noble/hashes/sha256";
import {
  blindPrepare,
  intToBytes,
  modulusBytes,
  rsaBlind,
  rsaBlindSign,
  rsaFinalize,
  rsaPssVerify,
  type RsaPrivateKey,
  type RsaPublicKey,
} from "./blindRsa.js";
import { hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";
import { b64Decode, b64Encode, hexToBytes, isLowerHex } from "./webEnvelope.js";

export const TAG_VOUCHER = "flagship/voucher/v1";
export const TAG_VOUCHER_KEY = "flagship/voucher-key/v1";
export const TAG_VOUCHER_NULLIFIER = "flagship/voucher-nullifier/v1";
/** The smallest modulus `.com` may sign with (RFC 9474 §6). */
export const VOUCHER_MIN_MODULUS_BITS = 2048;

export interface Voucher {
  k: string;
  p: string;
  n: string;
  s: string;
}

export interface VoucherPublicKey {
  keyId: string;
  nHex: string;
  eHex: string;
}

/** A blinded request the device keeps until the signature comes back. */
export interface PendingVoucher {
  k: string;
  p: string;
  n: string;
  /** The blinding inverse, hex. Secret: anyone holding it and the signature could link the two. */
  inv: string;
}

const te = new TextEncoder();
const KEY_ID = /^[0-9a-f]{16}$/;

function bigFromHex(h: string): bigint {
  return h.length === 0 ? 0n : BigInt("0x" + h);
}

function evenHex(x: bigint): string {
  const h = x.toString(16);
  return h.length % 2 ? "0" + h : h;
}

export function voucherKeyFromRsa(pk: RsaPublicKey): VoucherPublicKey {
  const nHex = hex(intToBytes(pk.n, modulusBytes(pk)));
  const eHex = evenHex(pk.e);
  return { keyId: voucherKeyId(nHex, eHex), nHex, eHex };
}

export function voucherKeyId(nHex: string, eHex: string): string {
  return hex(sha256(te.encode(`${TAG_VOUCHER_KEY}|${nHex}|${eHex}`))).slice(0, 16);
}

/** The RSA key of a served key, or null when its id doesn't match its numbers or it is too small. */
export function rsaFromVoucherKey(k: VoucherPublicKey): RsaPublicKey | null {
  if (!KEY_ID.test(k.keyId) || !isLowerHex(k.nHex) || !isLowerHex(k.eHex) || k.eHex.length === 0) return null;
  if (voucherKeyId(k.nHex, k.eHex) !== k.keyId) return null;
  const pk = { n: bigFromHex(k.nHex), e: bigFromHex(k.eHex) };
  if (pk.n.toString(2).length < VOUCHER_MIN_MODULUS_BITS || k.nHex.length !== modulusBytes(pk) * 2) return null;
  if (pk.e < 3n || pk.e % 2n === 0n) return null;
  return pk;
}

export function voucherMessage(nonce: Bytes): Bytes {
  if (nonce.length !== 32) throw new Error(`${TAG_VOUCHER}: nonce must be 32 bytes`);
  const tag = te.encode(`${TAG_VOUCHER}|`);
  const out = new Uint8Array(tag.length + 32);
  out.set(tag);
  out.set(nonce, tag.length);
  return out;
}

export function voucherPrepared(v: Pick<Voucher, "p" | "n">): Bytes {
  return blindPrepare(voucherMessage(hexToBytes(v.n)), hexToBytes(v.p));
}

export function voucherNullifier(v: Pick<Voucher, "k" | "n">): string {
  return hex(sha256(te.encode(`${TAG_VOUCHER_NULLIFIER}|${v.k}|${v.n}`)));
}

/** Strict shape of an untrusted voucher (no signature check). */
export function parseVoucher(v: unknown): Voucher | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== 4 || !["k", "p", "n", "s"].every((k) => keys.includes(k))) return null;
  if (typeof r.k !== "string" || !KEY_ID.test(r.k) || !isLowerHex(r.p, 32) || !isLowerHex(r.n, 32)) return null;
  if (typeof r.s !== "string" || !b64Decode(r.s)) return null;
  return { k: r.k, p: r.p, n: r.n, s: r.s };
}

function random(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Make one voucher request under `key`: a fresh nonce and prefix, blinded. Send `blinded` to the issuer; keep
 * `pending` until the blind signature comes back. `opts` is for test vectors only.
 */
export function newVoucherRequest(
  key: VoucherPublicKey,
  opts: { nonce?: Bytes; prefix?: Bytes; salt?: Bytes; r?: bigint } = {},
): { pending: PendingVoucher; blinded: string } {
  const pk = rsaFromVoucherKey(key);
  if (!pk) throw new Error(`${TAG_VOUCHER}: bad key`);
  const nonce = opts.nonce ?? random(32);
  const prefix = opts.prefix ?? random(32);
  const prepared = blindPrepare(voucherMessage(nonce), prefix);
  const st = rsaBlind(pk, prepared, { ...(opts.salt ? { salt: opts.salt } : {}), ...(opts.r !== undefined ? { r: opts.r } : {}) });
  return { pending: { k: key.keyId, p: hex(prefix), n: hex(nonce), inv: evenHex(st.inv) }, blinded: b64Encode(st.blindedMsg) };
}

/** Unblind the issuer's answer into a voucher; throws when the signature doesn't verify. */
export function finalizeVoucher(key: VoucherPublicKey, pending: PendingVoucher, blindSig: string): Voucher {
  const pk = rsaFromVoucherKey(key);
  if (!pk || pending.k !== key.keyId) throw new Error(`${TAG_VOUCHER}: bad key`);
  const bs = b64Decode(blindSig);
  if (!bs) throw new Error(`${TAG_VOUCHER}: bad blind signature`);
  const sig = rsaFinalize(pk, voucherPrepared(pending), bs, bigFromHex(pending.inv));
  return { k: pending.k, p: pending.p, n: pending.n, s: b64Encode(sig) };
}

export function verifyVoucher(key: VoucherPublicKey, v: Voucher): boolean {
  const pk = rsaFromVoucherKey(key);
  if (!pk || v.k !== key.keyId) return false;
  const sig = b64Decode(v.s);
  if (!sig || !isLowerHex(v.p, 32) || !isLowerHex(v.n, 32)) return false;
  return rsaPssVerify(pk, voucherPrepared(v), sig);
}

/** The issuer's side: sign one blinded request (standard base64 in and out). */
export function signBlindedVoucher(sk: RsaPrivateKey, blinded: string): string {
  const b = b64Decode(blinded);
  if (!b) throw new Error(`${TAG_VOUCHER}: bad blinded message`);
  return b64Encode(rsaBlindSign(sk, b));
}
