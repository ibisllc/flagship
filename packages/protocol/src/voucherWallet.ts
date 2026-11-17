/**
 * The voucher wallet (docs/payments-privacy-and-rails.md §5.11, owner decision 2026-11-17: "vouchers need no server
 * to spend: the phones hold and spend them"). The account's admin devices hold the vouchers and sync them end to end
 * encrypted the way call hours are synced (voiciCallSettings.ts): one sealed blob per account at `.com`, which stores
 * ciphertext and never learns the balance. Shared vectors: packages/protocol/test-vectors/vouchers/ `wallet`,
 * `merge`, `trickle`, `overage`.
 *
 *   key      HKDF-SHA256(ikm UMK seed, salt empty, info "flagship/voucher-wallet/v1", 32)
 *   sealed   {version, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce, aad "flagship/voucher-wallet/v1|
 *            <version>", canonical JSON plaintext); version = stored + 1 (compare-and-set at `.com`). The name is not
 *            in the aad, so an account rename (which moves the row) keeps the wallet readable.
 *   plain    {v:1, vouchers, spent, settings, overage, pad}
 *              vouchers  unspent vouchers, sorted by k then n
 *              spent     nullifiers this account has spent (sorted, at most 2048), so a device that comes back
 *                        online can't resurrect a spent voucher
 *              settings  {plan null|"pro"|"pro-max", autoPay, overageCapUnits, delayStart, startAt, updatedAt}
 *              overage   {period "YYYY-MM" or "", units} spent on overage blocks this month
 *              pad       "0" repeated so the plaintext is exactly 4 KiB × 2^i: the blob's size says little about the
 *                        balance
 *   merge    a version conflict merges: vouchers and spent are unions (spent wins), settings by the newer
 *            updatedAt, overage by the later period then the larger count
 *
 * The trickle (owner, 2026-11-17: "a trickle of spending"): instead of one monthly payment, a device spends one
 * voucher at a time at random moments while the plan is less than `highWaterDays` ahead, and at once when it is less
 * than `lowWaterDays` ahead. `.com` keeps a lapsed plan for `graceHours` and continues it from the old end, so a phone
 * that was off for a day never loses the plan.
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import { isPaidPlan, planUnitMs, type PaidPlan, type PaymentsConfig } from "./paymentsConfig.js";
import type { Bytes, UserMasterKey } from "./types.js";
import { parseVoucher, voucherNullifier, type Voucher } from "./voucher.js";
import { b64Decode, b64Encode, canonicalJson, canonicalJsonBytes, hexToBytes, isLowerHex } from "./webEnvelope.js";

export const TAG_VOUCHER_WALLET = "flagship/voucher-wallet/v1";
export const VOUCHER_WALLET_MAX_VOUCHERS = 500;
export const VOUCHER_WALLET_MAX_SPENT = 2048;
export const VOUCHER_WALLET_BUCKET = 4096;
export const VOUCHER_WALLET_MAX_BYTES = 512 * 1024;

export interface VoucherWalletSettings {
  plan: PaidPlan | null;
  autoPay: boolean;
  overageCapUnits: number;
  delayStart: boolean;
  startAt: number;
  updatedAt: number;
}

export interface VoucherWallet {
  v: 1;
  vouchers: Voucher[];
  spent: string[];
  settings: VoucherWalletSettings;
  overage: { period: string; units: number };
}

const te = new TextEncoder();
const PERIOD = /^(\d{4}-(0[1-9]|1[0-2]))?$/;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r: Record<string, unknown>, keys: string[]) =>
  Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));

export function emptyVoucherWallet(overageCapUnits: number): VoucherWallet {
  return {
    v: 1,
    vouchers: [],
    spent: [],
    settings: { plan: null, autoPay: true, overageCapUnits, delayStart: false, startAt: 0, updatedAt: 0 },
    overage: { period: "", units: 0 },
  };
}

const byKn = (a: Voucher, b: Voucher) => (a.k === b.k ? (a.n < b.n ? -1 : a.n > b.n ? 1 : 0) : a.k < b.k ? -1 : 1);

function parseSettings(v: unknown): VoucherWalletSettings | null {
  if (!isObj(v) || !exactKeys(v, ["plan", "autoPay", "overageCapUnits", "delayStart", "startAt", "updatedAt"])) return null;
  if (!(v.plan === null || isPaidPlan(v.plan)) || typeof v.autoPay !== "boolean" || typeof v.delayStart !== "boolean") return null;
  if (!isTime(v.overageCapUnits) || v.overageCapUnits > 10_000 || !isTime(v.startAt) || !isTime(v.updatedAt)) return null;
  return { plan: v.plan, autoPay: v.autoPay, overageCapUnits: v.overageCapUnits, delayStart: v.delayStart, startAt: v.startAt, updatedAt: v.updatedAt };
}

/** Strict shape of a wallet plaintext (`pad` allowed and dropped). */
export function parseVoucherWallet(v: unknown): VoucherWallet | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v).filter((k) => k !== "pad");
  if (keys.length !== 5 || !["v", "vouchers", "spent", "settings", "overage"].every((k) => keys.includes(k)) || v.v !== 1) return null;
  if ("pad" in v && (typeof v.pad !== "string" || !/^0*$/.test(v.pad))) return null;
  if (!Array.isArray(v.vouchers) || v.vouchers.length > VOUCHER_WALLET_MAX_VOUCHERS) return null;
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
  return normalizeVoucherWallet({ v: 1, vouchers, spent: v.spent as string[], settings, overage: { period: v.overage.period, units: v.overage.units } });
}

/** Sorted, deduplicated, spent vouchers dropped, lists capped. */
export function normalizeVoucherWallet(w: VoucherWallet): VoucherWallet {
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
  return { v: 1, vouchers: vouchers.slice(0, VOUCHER_WALLET_MAX_VOUCHERS), spent, settings: { ...w.settings }, overage: { ...w.overage } };
}

/** A version conflict: both sides' vouchers and spends, the newer settings, the later overage count. */
export function mergeVoucherWallets(local: VoucherWallet, remote: VoucherWallet): VoucherWallet {
  const settings = remote.settings.updatedAt > local.settings.updatedAt ? remote.settings : local.settings;
  const overage =
    local.overage.period === remote.overage.period
      ? { period: local.overage.period, units: Math.max(local.overage.units, remote.overage.units) }
      : local.overage.period > remote.overage.period
        ? local.overage
        : remote.overage;
  return normalizeVoucherWallet({
    v: 1,
    vouchers: [...local.vouchers, ...remote.vouchers],
    spent: [...local.spent, ...remote.spent],
    settings,
    overage,
  });
}

/** Take `n` vouchers out (the first in sort order, which is random). */
export function takeVouchers(w: VoucherWallet, n: number): Voucher[] {
  return normalizeVoucherWallet(w).vouchers.slice(0, Math.max(0, n));
}

/** The wallet with these vouchers recorded as spent. */
export function markVouchersSpent(w: VoucherWallet, nullifiers: string[]): VoucherWallet {
  return normalizeVoucherWallet({ ...w, spent: [...w.spent, ...nullifiers] });
}

export function addVouchers(w: VoucherWallet, vouchers: Voucher[]): VoucherWallet {
  return normalizeVoucherWallet({ ...w, vouchers: [...w.vouchers, ...vouchers] });
}

/** The canonical plaintext, padded to its bucket. */
export function voucherWalletPlaintext(w: VoucherWallet): string {
  const n = normalizeVoucherWallet(w);
  const bare = canonicalJson({ ...n, pad: "" });
  let bucket = VOUCHER_WALLET_BUCKET;
  while (bucket < bare.length) bucket *= 2;
  if (bucket > VOUCHER_WALLET_MAX_BYTES) throw new Error(`${TAG_VOUCHER_WALLET}: too large`);
  return canonicalJson({ ...n, pad: "0".repeat(bucket - bare.length) });
}

export function deriveVoucherWalletKey(umk: UserMasterKey): Bytes {
  return hkdf(sha256, umk.seed, new Uint8Array(0), te.encode(TAG_VOUCHER_WALLET), 32);
}

export interface SealedVoucherWallet {
  version: number;
  nonce: string;
  ct: string;
}

export function sealVoucherWallet(
  key: Bytes,
  version: number,
  w: VoucherWallet,
  nonce: Bytes = crypto.getRandomValues(new Uint8Array(12)),
): SealedVoucherWallet {
  if (!isTime(version) || version < 1 || nonce.length !== 12) throw new Error(`${TAG_VOUCHER_WALLET}: bad input`);
  const pt = te.encode(voucherWalletPlaintext(w));
  const ct = gcm(key, nonce, te.encode(`${TAG_VOUCHER_WALLET}|${version}`)).encrypt(pt);
  return { version, nonce: hex(nonce), ct: b64Encode(ct) };
}

export function openVoucherWallet(key: Bytes, blob: unknown): VoucherWallet | null {
  if (!isObj(blob) || !exactKeys(blob, ["version", "nonce", "ct"]) || !isTime(blob.version) || !isLowerHex(blob.nonce, 12)) return null;
  const ct = b64Decode(blob.ct);
  if (!ct || ct.length > VOUCHER_WALLET_MAX_BYTES + 16) return null;
  try {
    const pt = gcm(key, hexToBytes(blob.nonce), te.encode(`${TAG_VOUCHER_WALLET}|${blob.version}`)).decrypt(ct);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt);
    const v = JSON.parse(text);
    return canonicalJson(v) === text ? parseVoucherWallet(v) : null;
  } catch {
    return null;
  }
}

// ── spending rules ─────────────────────────────────────────────────────────

/**
 * How far ahead `plan` is paid, in `plan`'s time. Lapsed past the grace: 0 (a spend starts from now). Inside the
 * grace: negative (a spend continues from the old end). Paid on the other plan: that plan's time converted at the
 * ratio of their unit lengths, which is what `.com` does on a switch.
 */
export function planAheadMs(
  cfg: PaymentsConfig,
  plan: PaidPlan,
  paid: { plan: PaidPlan | null; paidUntil: number },
  now: number,
): number {
  if (!paid.plan || paid.paidUntil <= 0) return 0;
  const graceMs = cfg.graceHours * 3_600_000;
  if (paid.paidUntil + graceMs < now) return 0;
  const ahead = paid.paidUntil - now;
  if (paid.plan === plan || ahead <= 0) return paid.plan === plan ? ahead : 0;
  return Math.floor((ahead * planUnitMs(cfg, plan)) / planUnitMs(cfg, paid.plan));
}

export interface TrickleInput {
  now: number;
  /** autoPay is on and a plan is chosen. */
  enabled: boolean;
  balance: number;
  /** planAheadMs for the chosen plan. */
  aheadMs: number;
  /** A delayed first activation: nothing is spent before it. */
  startAt: number;
  /** When the next unhurried spend is due (0: none scheduled). Device-local. */
  nextSpendAt: number;
  unitMs: number;
  lowWaterMs: number;
  highWaterMs: number;
  maxPerRequest: number;
}

/**
 * One tick of the trickle: how many vouchers to spend now and when the next unhurried spend is due. `rand` is a
 * uniform number in [0, 1) (crypto-random in the apps; fixed in the vectors).
 */
export function trickleStep(t: TrickleInput, rand: number): { spend: number; nextSpendAt: number } {
  if (!t.enabled || t.balance <= 0) return { spend: 0, nextSpendAt: 0 };
  if (t.now < t.startAt) return { spend: 0, nextSpendAt: t.nextSpendAt };
  const later = t.now + Math.floor(rand * t.unitMs);
  if (t.aheadMs < t.lowWaterMs) {
    const need = Math.ceil((t.lowWaterMs - t.aheadMs) / t.unitMs);
    return { spend: Math.max(1, Math.min(t.balance, need, t.maxPerRequest)), nextSpendAt: later };
  }
  if (t.aheadMs >= t.highWaterMs) return { spend: 0, nextSpendAt: 0 };
  if (t.nextSpendAt === 0) return { spend: 0, nextSpendAt: later };
  if (t.now >= t.nextSpendAt) return { spend: 1, nextSpendAt: later };
  return { spend: 0, nextSpendAt: t.nextSpendAt };
}

export interface OverageInput {
  /** The account is on a paid plan (Free is slowed, never topped up). */
  paid: boolean;
  /** Egress bytes left this month, top-ups included. */
  remainingBytes: number;
  buyBelowBytes: number;
  capUnits: number;
  /** Units already spent on overage this month. */
  spentUnits: number;
  blockUnits: number;
  balance: number;
}

/** Whether to buy one overage block now: paid, nearly out, under the owner's cap, and the wallet can pay. */
export function overageStep(o: OverageInput): boolean {
  return o.paid && o.remainingBytes < o.buyBelowBytes && o.spentUnits + o.blockUnits <= o.capUnits && o.balance >= o.blockUnits;
}

/** "YYYY-MM" (UTC) of `now`: the overage month, the same as the egress meter's period. */
export function overagePeriod(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Whole months of `plan` a balance buys (what the apps show as "about N months"). */
export function monthsOfPlan(cfg: PaymentsConfig, plan: PaidPlan, balance: number): number {
  return Math.floor(balance / cfg.plans[plan].unitsPerMonth);
}
