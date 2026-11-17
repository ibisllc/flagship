/**
 * The org's voucher wallet (docs/plans-and-backup-offer.md §6 and "As built"). An org has no UMK, so the wallet is
 * sealed under the org key ring's `wallet` key (orgKeyRing.ts), which only org admins receive and which every
 * offboarding of an admin rotates. `.com` keeps the ciphertext beside the personal wallets (row `org:<orgId>`) and
 * never learns the balance. Writes need one org admin's approval, so a seat that is not an admin, or `.com`, can't
 * replace it. Shared vectors: packages/protocol/test-vectors/org-plan/ `wallet`, `merge`, `write`.
 *
 *   key      HKDF-SHA256(ikm ring key, salt empty, info "flagship/org-voucher-wallet/v1|<orgId>", 32)
 *   sealed   {version, keyVersion, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce,
 *            aad "flagship/org-voucher-wallet/v1|<orgId>|<keyVersion>|<version>", canonical JSON plaintext);
 *            keyVersion = the `wallet` ring version it is sealed under; version = stored + 1 (compare-and-set)
 *   plain    {v:1, vouchers, spent, settings, overage, pad}: as the personal wallet, with
 *              settings  {seats, autoPay, overageCapUnits, updatedAt}: the seat count the trickle pays for
 *   write    flagship/org-voucher-wallet-write/v1|<orgId>|<version>|<keyVersion>|<blobSha256>|<issuedAt>
 *            blobSha256 = SHA-256 hex of the canonical JSON of the sealed blob; approved by one org admin
 *
 * Vouchers are bearer tokens: an admin who leaves could have copied the unspent ones. After a `wallet` rotation the
 * apps exchange every voucher the old key could read for fresh ones (`POST /api/vouchers/exchange`) before sealing
 * the wallet under the new key.
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";
import { parseVoucher, voucherNullifier, type Voucher } from "./voucher.js";
import { VOUCHER_WALLET_BUCKET, VOUCHER_WALLET_MAX_SPENT } from "./voucherWallet.js";
import { b64Decode, b64Encode, canonicalJson, hexToBytes, isLowerHex } from "./webEnvelope.js";

export const TAG_ORG_VOUCHER_WALLET = "flagship/org-voucher-wallet/v1";
export const TAG_ORG_VOUCHER_WALLET_WRITE = "flagship/org-voucher-wallet-write/v1";
/** A company batch fits in one wallet. */
export const ORG_WALLET_MAX_VOUCHERS = 5000;
export const ORG_WALLET_MAX_BYTES = 4 * 1024 * 1024;

export interface OrgWalletSettings {
  seats: number;
  autoPay: boolean;
  overageCapUnits: number;
  updatedAt: number;
}

export interface OrgVoucherWallet {
  v: 1;
  vouchers: Voucher[];
  spent: string[];
  settings: OrgWalletSettings;
  overage: { period: string; units: number };
}

export interface SealedOrgVoucherWallet {
  version: number;
  keyVersion: number;
  nonce: string;
  ct: string;
}

const te = new TextEncoder();
const PERIOD = /^(\d{4}-(0[1-9]|1[0-2]))?$/;
const ORG_ID = /^[0-9a-f]{32}$/;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r: Record<string, unknown>, keys: string[]) =>
  Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));
const byKn = (a: Voucher, b: Voucher) => (a.k === b.k ? (a.n < b.n ? -1 : a.n > b.n ? 1 : 0) : a.k < b.k ? -1 : 1);

export function emptyOrgVoucherWallet(seats: number, overageCapUnits: number): OrgVoucherWallet {
  return { v: 1, vouchers: [], spent: [], settings: { seats, autoPay: true, overageCapUnits, updatedAt: 0 }, overage: { period: "", units: 0 } };
}

/** Sorted, deduplicated, spent vouchers dropped, lists capped. */
export function normalizeOrgVoucherWallet(w: OrgVoucherWallet): OrgVoucherWallet {
  const spent = [...new Set(w.spent)].sort().slice(-VOUCHER_WALLET_MAX_SPENT);
  const spentSet = new Set(spent);
  const seen = new Set<string>();
  const vouchers: Voucher[] = [];
  for (const x of [...w.vouchers].sort(byKn)) {
    const id = `${x.k}|${x.n}`;
    if (seen.has(id) || spentSet.has(voucherNullifier(x))) continue;
    seen.add(id);
    vouchers.push(x);
  }
  return { v: 1, vouchers: vouchers.slice(0, ORG_WALLET_MAX_VOUCHERS), spent, settings: { ...w.settings }, overage: { ...w.overage } };
}

function parseSettings(v: unknown): OrgWalletSettings | null {
  if (!isObj(v) || !exactKeys(v, ["seats", "autoPay", "overageCapUnits", "updatedAt"])) return null;
  if (!isTime(v.seats) || v.seats < 1 || v.seats > 1_000_000 || typeof v.autoPay !== "boolean") return null;
  if (!isTime(v.overageCapUnits) || v.overageCapUnits > 1_000_000 || !isTime(v.updatedAt)) return null;
  return { seats: v.seats, autoPay: v.autoPay, overageCapUnits: v.overageCapUnits, updatedAt: v.updatedAt };
}

/** Strict shape of an org wallet plaintext (`pad` allowed and dropped). */
export function parseOrgVoucherWallet(v: unknown): OrgVoucherWallet | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v).filter((k) => k !== "pad");
  if (keys.length !== 5 || !["v", "vouchers", "spent", "settings", "overage"].every((k) => keys.includes(k)) || v.v !== 1) return null;
  if ("pad" in v && (typeof v.pad !== "string" || !/^0*$/.test(v.pad))) return null;
  if (!Array.isArray(v.vouchers) || v.vouchers.length > ORG_WALLET_MAX_VOUCHERS) return null;
  if (!Array.isArray(v.spent) || v.spent.length > VOUCHER_WALLET_MAX_SPENT || !v.spent.every((s) => isLowerHex(s, 32))) return null;
  const vouchers: Voucher[] = [];
  for (const x of v.vouchers) {
    const p = parseVoucher(x);
    if (!p) return null;
    vouchers.push(p);
  }
  const settings = parseSettings(v.settings);
  if (!settings || !isObj(v.overage) || !exactKeys(v.overage, ["period", "units"])) return null;
  if (typeof v.overage.period !== "string" || !PERIOD.test(v.overage.period) || !isTime(v.overage.units)) return null;
  return normalizeOrgVoucherWallet({ v: 1, vouchers, spent: v.spent as string[], settings, overage: { period: v.overage.period, units: v.overage.units } });
}

/** A version conflict: both sides' vouchers and spends, the newer settings, the later overage count. */
export function mergeOrgVoucherWallets(local: OrgVoucherWallet, remote: OrgVoucherWallet): OrgVoucherWallet {
  const settings = remote.settings.updatedAt > local.settings.updatedAt ? remote.settings : local.settings;
  const overage =
    local.overage.period === remote.overage.period
      ? { period: local.overage.period, units: Math.max(local.overage.units, remote.overage.units) }
      : local.overage.period > remote.overage.period
        ? local.overage
        : remote.overage;
  return normalizeOrgVoucherWallet({ v: 1, vouchers: [...local.vouchers, ...remote.vouchers], spent: [...local.spent, ...remote.spent], settings, overage });
}

export function addOrgVouchers(w: OrgVoucherWallet, vouchers: Voucher[]): OrgVoucherWallet {
  return normalizeOrgVoucherWallet({ ...w, vouchers: [...w.vouchers, ...vouchers] });
}

export function markOrgVouchersSpent(w: OrgVoucherWallet, nullifiers: string[]): OrgVoucherWallet {
  return normalizeOrgVoucherWallet({ ...w, spent: [...w.spent, ...nullifiers] });
}

/** The canonical plaintext, padded to its bucket (4 KiB × 2^i). */
export function orgVoucherWalletPlaintext(w: OrgVoucherWallet): string {
  const n = normalizeOrgVoucherWallet(w);
  const bare = canonicalJson({ ...n, pad: "" });
  let bucket = VOUCHER_WALLET_BUCKET;
  while (bucket < bare.length) bucket *= 2;
  if (bucket > ORG_WALLET_MAX_BYTES) throw new Error(`${TAG_ORG_VOUCHER_WALLET}: too large`);
  return canonicalJson({ ...n, pad: "0".repeat(bucket - bare.length) });
}

/** The wallet key from the org key ring's `wallet` key. */
export function deriveOrgWalletKey(ringKey: Bytes, orgId: string): Bytes {
  if (ringKey.length !== 32 || !ORG_ID.test(orgId)) throw new Error(`${TAG_ORG_VOUCHER_WALLET}: bad input`);
  return hkdf(sha256, ringKey, new Uint8Array(0), te.encode(`${TAG_ORG_VOUCHER_WALLET}|${orgId}`), 32);
}

const aad = (orgId: string, keyVersion: number, version: number) => te.encode(`${TAG_ORG_VOUCHER_WALLET}|${orgId}|${keyVersion}|${version}`);

export function sealOrgVoucherWallet(
  key: Bytes,
  orgId: string,
  keyVersion: number,
  version: number,
  w: OrgVoucherWallet,
  nonce: Bytes = crypto.getRandomValues(new Uint8Array(12)),
): SealedOrgVoucherWallet {
  if (!isTime(version) || version < 1 || !isTime(keyVersion) || keyVersion < 1 || nonce.length !== 12 || !ORG_ID.test(orgId)) {
    throw new Error(`${TAG_ORG_VOUCHER_WALLET}: bad input`);
  }
  const ct = gcm(key, nonce, aad(orgId, keyVersion, version)).encrypt(te.encode(orgVoucherWalletPlaintext(w)));
  return { version, keyVersion, nonce: hex(nonce), ct: b64Encode(ct) };
}

/** Strict shape of a sealed blob (no decryption). */
export function parseSealedOrgVoucherWallet(blob: unknown): SealedOrgVoucherWallet | null {
  if (!isObj(blob) || !exactKeys(blob, ["version", "keyVersion", "nonce", "ct"])) return null;
  if (!isTime(blob.version) || blob.version < 1 || !isTime(blob.keyVersion) || blob.keyVersion < 1 || !isLowerHex(blob.nonce, 12)) return null;
  if (typeof blob.ct !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob.ct) || blob.ct.length % 4 !== 0) return null;
  if (blob.ct.length > ((ORG_WALLET_MAX_BYTES + 16) * 4) / 3 + 4) return null;
  return { version: blob.version, keyVersion: blob.keyVersion, nonce: blob.nonce, ct: blob.ct };
}

export function openOrgVoucherWallet(key: Bytes, orgId: string, blob: unknown): OrgVoucherWallet | null {
  const s = parseSealedOrgVoucherWallet(blob);
  if (!s) return null;
  const ct = b64Decode(s.ct);
  if (!ct) return null;
  try {
    const pt = gcm(key, hexToBytes(s.nonce), aad(orgId, s.keyVersion, s.version)).decrypt(ct);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt);
    const v = JSON.parse(text);
    return canonicalJson(v) === text ? parseOrgVoucherWallet(v) : null;
  } catch {
    return null;
  }
}

export interface OrgWalletWrite {
  orgId: string;
  version: number;
  keyVersion: number;
  blobSha256: string;
  issuedAt: number;
}

export function orgWalletBlobSha256(blob: SealedOrgVoucherWallet): string {
  return hex(sha256(te.encode(canonicalJson({ ct: blob.ct, keyVersion: blob.keyVersion, nonce: blob.nonce, version: blob.version }))));
}

/** The order an org admin approves to store `blob` (the approval wraps it: orgAuthority `flagship/org-approval/v1`). */
export function canonicalOrgWalletWrite(w: OrgWalletWrite): Bytes {
  if (!ORG_ID.test(w.orgId) || !isTime(w.version) || w.version < 1 || !isTime(w.keyVersion) || w.keyVersion < 1) {
    throw new Error(`${TAG_ORG_VOUCHER_WALLET_WRITE}: bad input`);
  }
  if (!isLowerHex(w.blobSha256, 32) || !isTime(w.issuedAt)) throw new Error(`${TAG_ORG_VOUCHER_WALLET_WRITE}: bad input`);
  return te.encode([TAG_ORG_VOUCHER_WALLET_WRITE, w.orgId, String(w.version), String(w.keyVersion), w.blobSha256, String(w.issuedAt)].join("|"));
}

export function orgWalletWriteFor(orgId: string, blob: SealedOrgVoucherWallet, issuedAt: number): OrgWalletWrite {
  return { orgId, version: blob.version, keyVersion: blob.keyVersion, blobSha256: orgWalletBlobSha256(blob), issuedAt };
}
