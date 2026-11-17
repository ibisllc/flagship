/**
 * The rails that sell vouchers (docs/payments-privacy-and-rails.md §11): the store product ids, the commitment a
 * web order carries to Stripe, and the hash `.com` keeps of a used payment. Nothing here names an account.
 *
 *   product id   "com.flagshipserver.app.vouchers.<units>", the same on the App Store and Google Play
 *   order commit SHA-256 hex of "flagship/voucher-order/v1|" + keyId + "|" + blinded.join("|")
 *   payment hash SHA-256 hex of "flagship/voucher-payment/v1|" + rail + "|" + the rail's payment id
 */
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";

export const TAG_VOUCHER_ORDER = "flagship/voucher-order/v1";
export const TAG_VOUCHER_PAYMENT = "flagship/voucher-payment/v1";
export const VOUCHER_PRODUCT_PREFIX = "com.flagshipserver.app.vouchers.";

export type VoucherRail = "stripe" | "apple" | "google";
export const VOUCHER_RAILS: readonly VoucherRail[] = ["stripe", "apple", "google"];

const te = new TextEncoder();

export function voucherPackProductId(units: number): string {
  return `${VOUCHER_PRODUCT_PREFIX}${units}`;
}

/** The units of a pack product, or null when the id isn't one of `packs`. */
export function voucherPackUnits(productId: unknown, packs: readonly number[]): number | null {
  if (typeof productId !== "string" || !productId.startsWith(VOUCHER_PRODUCT_PREFIX)) return null;
  const rest = productId.slice(VOUCHER_PRODUCT_PREFIX.length);
  if (!/^[1-9][0-9]{0,4}$/.test(rest)) return null;
  const n = Number(rest);
  return packs.includes(n) ? n : null;
}

/** What a web order commits to before payment: the key and the exact blinded requests, in order. */
export function voucherOrderCommit(keyId: string, blinded: readonly string[]): string {
  return hex(sha256(te.encode(`${TAG_VOUCHER_ORDER}|${keyId}|${blinded.join("|")}`)));
}

/** The only thing `.com` keeps about a payment: this hash (never the id itself). */
export function voucherPaymentHash(rail: VoucherRail, paymentId: string): string {
  return hex(sha256(te.encode(`${TAG_VOUCHER_PAYMENT}|${rail}|${paymentId}`)));
}

/** SHA-256 hex of the blinded set, to tell a retry (same set) from a second claim (another set). */
export function voucherBlindedSetHash(keyId: string, blinded: readonly string[]): string {
  return voucherOrderCommit(keyId, blinded);
}
