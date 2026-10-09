// Prepaid Pro vouchers (#9).
//
// A voucher is a BEARER instrument: bought anonymously (cash/Monero → a code),
// redeemed by whoever holds it against a username of their choice. Redemption
// is the automated front-end onto grantTier (#8) — it consumes the code
// atomically (single-use), then grants its tier for its days.
//
// We persist only the SHA-256 of the NORMALIZED code (uppercase, alphanumerics
// only — so a user can type it with/without dashes, any case), never the code
// itself. Codes are high-entropy (100 bits) so the redeem endpoint can't be
// brute-forced.

import type { TierName, VoucherKind, VoucherStorage } from "@flagship/storage";
export { DIBS_CLAIM_PRICE_USD } from "./nameDibs.js";
import { grantTier, GRANTABLE_TIERS, MAX_GRANT_DAYS, type TierGrantDeps, type TierGrantResult } from "./tierGrant.js";

const USERNAME_RE = /^[a-z0-9]{3,30}$/;
// 32 unambiguous chars (no 0/O/1/I) — 5 bits each.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface VoucherDeps extends TierGrantDeps {
  vouchers: VoucherStorage;
}

function nowMs(deps: { now?: () => number }): number {
  return deps.now ? deps.now() : Date.now();
}

/** Normalize a code for hashing: uppercase, alphanumerics only (drops the
 *  presentational dashes/spaces). Both issue + redeem hash this form. */
export function normalizeVoucherCode(code: string): string {
  return String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh high-entropy code, grouped for readability: FLAG-XXXXX-XXXXX-XXXXX-XXXXX. */
export function mintVoucherCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => ALPHABET[b % 32]);
  const groups = [chars.slice(0, 5), chars.slice(5, 10), chars.slice(10, 15), chars.slice(15, 20)];
  return "FLAG-" + groups.map((g) => g.join("")).join("-");
}

/** USD price of each single-use name entitlement (owner decision 2026-10-09). */
export const NAME_CHANGE_PRICE_USD = 10;

export interface IssueVoucherArgs {
  /** Defaults to "tier". A "name-change" / "dibs-claim" voucher carries no tier. */
  kind?: VoucherKind;
  tier?: TierName;
  durationDays?: number;
  /** Optional explicit code (e.g. a pre-printed card). Defaults to a mint. */
  code?: string;
}

/** Issue a voucher (admin). Returns the plaintext code ONCE — we only store its
 *  hash, so it can never be recovered after this call. */
export async function issueVoucher(
  deps: Pick<VoucherDeps, "vouchers" | "now">,
  args: IssueVoucherArgs,
): Promise<{ code: string; kind: VoucherKind; tier: TierName; durationDays: number }> {
  const kind = args.kind ?? "tier";
  if (kind === "name-change" || kind === "dibs-claim") {
    const code = args.code && normalizeVoucherCode(args.code).length >= 12 ? args.code : mintVoucherCode();
    const codeHash = await sha256Hex(normalizeVoucherCode(code));
    const r = await deps.vouchers.create({ codeHash, kind, tier: "free", durationDays: 0, createdAt: nowMs(deps) });
    if (!r.ok) throw new Error(r.reason);
    return { code, kind, tier: "free", durationDays: 0 };
  }
  if (kind !== "tier") throw new Error("kind must be tier | name-change | dibs-claim");
  if (args.tier === undefined || args.tier === "free" || !GRANTABLE_TIERS.includes(args.tier)) {
    throw new Error("voucher tier must be a paid tier (hobby | maker)");
  }
  const days = Math.floor(Number(args.durationDays));
  if (!Number.isFinite(days) || days <= 0 || days > MAX_GRANT_DAYS) {
    throw new Error(`durationDays must be an integer 1..${MAX_GRANT_DAYS}`);
  }
  const code = args.code && normalizeVoucherCode(args.code).length >= 12 ? args.code : mintVoucherCode();
  const codeHash = await sha256Hex(normalizeVoucherCode(code));
  const r = await deps.vouchers.create({ codeHash, kind: "tier", tier: args.tier, durationDays: days, createdAt: nowMs(deps) });
  if (!r.ok) throw new Error(r.reason);
  return { code, kind: "tier", tier: args.tier, durationDays: days };
}

export type NameVoucherKind = Extract<VoucherKind, "name-change" | "dibs-claim">;

/**
 * Consume a single-use name entitlement for `username`. Atomic: of two racing
 * requests with one code, exactly one wins. Returns the code hash on success
 * (the handle `releaseNameVoucher` needs if the rename it paid for fails), or
 * the refusal.
 */
export async function consumeNameVoucher(
  deps: Pick<VoucherDeps, "vouchers" | "now">,
  args: { code: string; kind: NameVoucherKind; username: string },
): Promise<{ ok: true; codeHash: string } | { ok: false; reason: string }> {
  const codeHash = await sha256Hex(normalizeVoucherCode(args.code));
  const v = await deps.vouchers.get(codeHash);
  if (!v) return { ok: false, reason: "invalid voucher code" };
  if ((v.kind ?? "tier") !== args.kind) {
    return {
      ok: false,
      reason: args.kind === "dibs-claim"
        ? "this name is held for its .com holder — it needs a dibs claim voucher"
        : "this voucher isn't a name-change voucher",
    };
  }
  if (v.redeemedAt !== undefined) return { ok: false, reason: "voucher already redeemed" };
  const won = await deps.vouchers.redeem(codeHash, args.username.toLowerCase(), nowMs(deps));
  return won ? { ok: true, codeHash } : { ok: false, reason: "voucher already redeemed" };
}

/** Put a consumed name entitlement back (the rename it paid for failed). */
export async function releaseNameVoucher(
  deps: Pick<VoucherDeps, "vouchers">,
  args: { codeHash: string; username: string },
): Promise<void> {
  await deps.vouchers.release(args.codeHash, args.username.toLowerCase());
}

export interface RedeemVoucherArgs {
  code: string;
  username: string;
}

/** Redeem a voucher: validate, atomically consume (single-use), then grant.
 *  The username is pre-validated BEFORE consuming so a bad username can't burn
 *  a valid code. */
export async function redeemVoucher(deps: VoucherDeps, args: RedeemVoucherArgs): Promise<TierGrantResult> {
  const username = String(args.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new Error("invalid username (3–30 lowercase letters/digits)");
  const codeHash = await sha256Hex(normalizeVoucherCode(args.code));
  const v = await deps.vouchers.get(codeHash);
  if (!v) throw new Error("invalid voucher code");
  // A name entitlement is consumed by the name change, never as a tier — and
  // checking BEFORE the redeem means trying it here doesn't burn it.
  if ((v.kind ?? "tier") !== "tier") throw new Error("this voucher is for a name change — use it in Settings → Change your name");
  if (v.redeemedAt !== undefined) throw new Error("voucher already redeemed");
  // Atomic consume — only the winner of a race proceeds to grant.
  const won = await deps.vouchers.redeem(codeHash, username, nowMs(deps));
  if (!won) throw new Error("voucher already redeemed");
  return grantTier(deps, { username, tier: v.tier, durationDays: v.durationDays });
}

export interface VoucherHttpResult {
  status: number;
  body: unknown;
}

/** `POST /api/voucher/redeem` — PUBLIC. Body `{ code, username }`. The code is
 *  the bearer secret; no other auth. */
export async function handleRedeemVoucher(deps: VoucherDeps, body: unknown): Promise<VoucherHttpResult> {
  const b = (body ?? {}) as { code?: unknown; username?: unknown };
  if (typeof b.code !== "string" || typeof b.username !== "string") {
    return { status: 400, body: { error: "code and username are required" } };
  }
  try {
    const res = await redeemVoucher(deps, { code: b.code, username: b.username });
    return { status: 200, body: { ok: true, ...res } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}

/** `POST /api/admin/voucher/issue` — ADMIN. Body `{ tier, durationDays, code? }`.
 *  Returns the plaintext code ONCE. */
export async function handleIssueVoucher(deps: VoucherDeps, body: unknown): Promise<VoucherHttpResult> {
  const b = (body ?? {}) as { kind?: unknown; tier?: unknown; durationDays?: unknown; code?: unknown };
  const kind = typeof b.kind === "string" ? (b.kind as VoucherKind) : "tier";
  if (kind === "tier" && (typeof b.tier !== "string" || typeof b.durationDays !== "number")) {
    return { status: 400, body: { error: "tier and durationDays are required" } };
  }
  try {
    const res = await issueVoucher(deps, {
      kind,
      ...(typeof b.tier === "string" ? { tier: b.tier as TierName } : {}),
      ...(typeof b.durationDays === "number" ? { durationDays: b.durationDays } : {}),
      code: typeof b.code === "string" ? b.code : undefined,
    });
    return { status: 200, body: { ok: true, ...res } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}
