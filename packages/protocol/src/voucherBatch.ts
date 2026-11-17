/**
 * Invoiced voucher batches and voucher files (docs/plans-and-backup-offer.md §6 and "As built"). A company buys at
 * least `business.batchMinUnits` vouchers in one invoiced Stripe Checkout; the buyer's browser makes every blinded
 * request from one random 32-byte batch seed, so the order survives a closed tab and can be finished on another
 * computer from the small batch key file alone (the seed never leaves the buyer's devices: Stripe, `.com` and the
 * invoice see only the count and a commitment). The vouchers then go into an org wallet, or are split into voucher
 * files for staff to spend on their own plans. Shared vectors: packages/protocol/test-vectors/org-plan/ `batch`,
 * `voucherFile`.
 *
 *   request i   okm = HKDF-SHA256(ikm seed, salt empty, info "flagship/voucher-batch/v1|<keyId>|<i>",
 *                                 32 + 32 + 48 + modulusBytes + 16)
 *               nonce = okm[0..32), prefix = okm[32..64), PSS salt = okm[64..112),
 *               r = (big-endian okm[112..) mod (n - 3)) + 2
 *   commit      voucherOrderCommit(keyId, blinded[0..units)) (voucherRails.ts), what the Stripe session carries
 *   key file    {kind: "flagship-voucher-batch", v: 1, k, units, seed, session}
 *   voucher file {kind: "flagship-vouchers", v: 1, vouchers: [...]} (canonical JSON)
 *
 * A voucher file is a bearer secret: whoever holds it can spend it. Nothing in it names the buyer, the org or a seat.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToInt, modulusBytes } from "./blindRsa.js";
import { hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";
import { finalizeVoucher, newVoucherRequest, parseVoucher, rsaFromVoucherKey, voucherNullifier, type PendingVoucher, type Voucher, type VoucherPublicKey } from "./voucher.js";
import { voucherOrderCommit } from "./voucherRails.js";
import { canonicalJson, hexToBytes, isLowerHex } from "./webEnvelope.js";

export const TAG_VOUCHER_BATCH = "flagship/voucher-batch/v1";
export const VOUCHER_BATCH_KIND = "flagship-voucher-batch";
export const VOUCHER_FILE_KIND = "flagship-vouchers";
/** Most vouchers one file holds (a batch's maximum). */
export const VOUCHER_FILE_MAX = 5000;

const te = new TextEncoder();
const KEY_ID = /^[0-9a-f]{16}$/;
const SESSION = /^cs_(live|test)_[A-Za-z0-9]{8,200}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The `i`-th blinded request of a batch: deterministic from the seed. */
export function batchVoucherRequest(key: VoucherPublicKey, seed: Bytes, i: number): { pending: PendingVoucher; blinded: string } {
  const pk = rsaFromVoucherKey(key);
  if (!pk || seed.length !== 32 || !Number.isSafeInteger(i) || i < 0) throw new Error(`${TAG_VOUCHER_BATCH}: bad input`);
  const kLen = modulusBytes(pk);
  const okm = hkdf(sha256, seed, new Uint8Array(0), te.encode(`${TAG_VOUCHER_BATCH}|${key.keyId}|${i}`), 112 + kLen + 16);
  const r = (bytesToInt(okm.subarray(112)) % (pk.n - 3n)) + 2n;
  return newVoucherRequest(key, { nonce: okm.slice(0, 32), prefix: okm.slice(32, 64), salt: okm.slice(64, 112), r });
}

/** Every blinded request of a batch of `units`, in order, and the commitment the Stripe session carries. */
export function batchRequests(key: VoucherPublicKey, seed: Bytes, units: number): { blinded: string[]; commit: string } {
  if (!Number.isSafeInteger(units) || units < 1 || units > VOUCHER_FILE_MAX) throw new Error(`${TAG_VOUCHER_BATCH}: bad units`);
  const blinded: string[] = [];
  for (let i = 0; i < units; i++) blinded.push(batchVoucherRequest(key, seed, i).blinded);
  return { blinded, commit: voucherOrderCommit(key.keyId, blinded) };
}

/** Unblind the signatures for requests `from` .. `from + sigs.length - 1`; throws when one doesn't verify. */
export function finalizeBatchVouchers(key: VoucherPublicKey, seed: Bytes, from: number, sigs: readonly string[]): Voucher[] {
  return sigs.map((s, j) => finalizeVoucher(key, batchVoucherRequest(key, seed, from + j).pending, s));
}

export interface VoucherBatchKey {
  kind: typeof VOUCHER_BATCH_KIND;
  v: 1;
  k: string;
  units: number;
  /** The batch seed, hex. Secret: whoever holds it can finish the batch. */
  seed: string;
  /** The Stripe Checkout session, once it exists ("" before). */
  session: string;
}

export function voucherBatchKeyText(b: Omit<VoucherBatchKey, "kind" | "v">): string {
  const parsed = parseVoucherBatchKey({ kind: VOUCHER_BATCH_KIND, v: 1, ...b });
  if (!parsed) throw new Error(`${TAG_VOUCHER_BATCH}: bad batch key`);
  return canonicalJson(parsed);
}

export function parseVoucherBatchKey(v: unknown): VoucherBatchKey | null {
  let o = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isObj(o) || Object.keys(o).length !== 6 || o.kind !== VOUCHER_BATCH_KIND || o.v !== 1) return null;
  if (typeof o.k !== "string" || !KEY_ID.test(o.k) || !isLowerHex(o.seed, 32)) return null;
  if (typeof o.units !== "number" || !Number.isSafeInteger(o.units) || o.units < 1 || o.units > VOUCHER_FILE_MAX) return null;
  if (typeof o.session !== "string" || (o.session !== "" && !SESSION.test(o.session))) return null;
  return { kind: VOUCHER_BATCH_KIND, v: 1, k: o.k, units: o.units, seed: o.seed, session: o.session };
}

export const batchSeedBytes = (b: VoucherBatchKey): Bytes => hexToBytes(b.seed);

// ── voucher files ──────────────────────────────────────────────────────────

/** A voucher file's text: the vouchers sorted, canonical JSON. */
export function voucherFileText(vouchers: readonly Voucher[]): string {
  if (vouchers.length === 0 || vouchers.length > VOUCHER_FILE_MAX) throw new Error("voucher file: 1 to 5000 vouchers");
  const seen = new Set<string>();
  const out: Voucher[] = [];
  for (const v of vouchers) {
    const p = parseVoucher(v);
    if (!p) throw new Error("voucher file: malformed voucher");
    const id = voucherNullifier(p);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  out.sort((a, b) => (a.k === b.k ? (a.n < b.n ? -1 : 1) : a.k < b.k ? -1 : 1));
  return canonicalJson({ kind: VOUCHER_FILE_KIND, v: 1, vouchers: out });
}

/** The vouchers of an untrusted voucher file (shape only: the redeem call checks each signature), or null. */
export function parseVoucherFile(text: unknown): Voucher[] | null {
  let o: unknown = text;
  if (typeof text === "string") {
    if (text.length > VOUCHER_FILE_MAX * 600) return null;
    try {
      o = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!isObj(o) || Object.keys(o).length !== 3 || o.kind !== VOUCHER_FILE_KIND || o.v !== 1 || !Array.isArray(o.vouchers)) return null;
  if (o.vouchers.length === 0 || o.vouchers.length > VOUCHER_FILE_MAX) return null;
  const out: Voucher[] = [];
  for (const x of o.vouchers) {
    const p = parseVoucher(x);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** Split vouchers into files of `perFile` (the staff perk: one file per person). The last file holds the rest. */
export function splitVoucherFiles(vouchers: readonly Voucher[], perFile: number): string[] {
  if (!Number.isSafeInteger(perFile) || perFile < 1) throw new Error("voucher file: bad size");
  const out: string[] = [];
  for (let i = 0; i < vouchers.length; i += perFile) out.push(voucherFileText(vouchers.slice(i, i + perFile)));
  return out;
}

/** A short id for a file (the first 8 hex of the SHA-256 of its text), shown so two people can tell files apart. */
export function voucherFileId(text: string): string {
  return hex(sha256(te.encode(text))).slice(0, 8);
}
