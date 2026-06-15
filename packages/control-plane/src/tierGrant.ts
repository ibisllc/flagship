// Admin tier-grant — the entitlement-WRITE primitive (task #8).
//
// Metering READS a user's tier to size their public-bandwidth quota; this is
// the write side: a validated, admin-authed way to set a username's tier +
// expiry once a payment lands — the manual cash/Monero flow the `/pro` page
// promises ("we flip your account to Pro by hand"). The voucher (#9) and Stripe
// (#11) paths are automated front-ends onto this SAME operation, so `grantTier`
// is the single place a tier ever changes.
//
// "Pro" maps to the paid tiers in TierStorage ("hobby" = 250 GB; "maker" =
// 1 TB). Granting Pro = grant tier "hobby" for N days.

import type { TierName, TierStorage, TierSubscriptionRecord } from "@flagship/storage";

/** Tiers an operator may grant. "free" is allowed (refund / downgrade). */
export const GRANTABLE_TIERS: readonly TierName[] = ["free", "hobby", "maker"];

const USERNAME_RE = /^[a-z0-9]{3,30}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Sanity ceiling so a fat-fingered duration can't grant a century. */
export const MAX_GRANT_DAYS = 366 * 5;

export interface TierGrantDeps {
  tiers: TierStorage;
  now?: () => number;
}

export interface TierGrantArgs {
  username: string;
  tier: TierName;
  /** Days of access from now. Ignored (may be 0) when tier is "free", or when
   *  `absolutePeriodEnd` is given. */
  durationDays: number;
  /** Set the paid period to this exact epoch-ms instead of computing it from
   *  `durationDays`. Stripe (#11) passes its authoritative subscription period
   *  end here so renewals track Stripe rather than stacking fixed windows the
   *  way prepaid vouchers/cash do. Ignored for "free". */
  absolutePeriodEnd?: number;
  /** Persisted alongside the record so the Stripe webhook can correlate a later
   *  event (renewal / cancellation) back to the account. Cleared on "free". */
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

export interface TierGrantResult {
  username: string;
  tier: TierName;
  /** Epoch-ms the paid period ends; undefined for "free". */
  currentPeriodEnd?: number;
  updatedAt: number;
}

function nowMs(deps: TierGrantDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/**
 * Set (grant / extend / downgrade) a user's tier. Pure validation + a single
 * `tiers.put`. Re-granting the SAME paid tier while it's still active EXTENDS
 * the period — re-paying mid-cycle adds time instead of truncating it. Granting
 * "free" clears the paid period (refund/downgrade). Throws on invalid input so
 * a bad operator request never writes a garbage row.
 */
export async function grantTier(deps: TierGrantDeps, args: TierGrantArgs): Promise<TierGrantResult> {
  const username = String(args.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new Error("invalid username (3–30 lowercase letters/digits)");
  }
  if (!GRANTABLE_TIERS.includes(args.tier)) {
    throw new Error(`invalid tier: ${String(args.tier)}`);
  }
  const now = nowMs(deps);

  let currentPeriodEnd: number | undefined;
  if (args.tier !== "free") {
    if (args.absolutePeriodEnd !== undefined) {
      const end = Math.floor(Number(args.absolutePeriodEnd));
      if (!Number.isFinite(end) || end <= now || end > now + MAX_GRANT_DAYS * DAY_MS) {
        throw new Error(`absolutePeriodEnd must be a future epoch-ms within ${MAX_GRANT_DAYS} days`);
      }
      currentPeriodEnd = end;
    } else {
      const days = Math.floor(Number(args.durationDays));
      if (!Number.isFinite(days) || days <= 0 || days > MAX_GRANT_DAYS) {
        throw new Error(`durationDays must be an integer 1..${MAX_GRANT_DAYS}`);
      }
      const existing = await deps.tiers.get(username);
      const stillActiveSameTier =
        existing?.tier === args.tier &&
        existing.currentPeriodEnd !== undefined &&
        existing.currentPeriodEnd > now;
      const base = stillActiveSameTier ? existing!.currentPeriodEnd! : now;
      currentPeriodEnd = base + days * DAY_MS;
    }
  }

  const rec: TierSubscriptionRecord = { username, tier: args.tier, currentPeriodEnd, updatedAt: now };
  // Keep the Stripe linkage on paid grants (drop it on a downgrade to free).
  if (args.tier !== "free") {
    if (args.stripeCustomerId) rec.stripeCustomerId = args.stripeCustomerId;
    if (args.stripeSubscriptionId) rec.stripeSubscriptionId = args.stripeSubscriptionId;
  }
  await deps.tiers.put(rec);
  return { username, tier: args.tier, currentPeriodEnd, updatedAt: now };
}

export interface TierGrantHttpResult {
  status: number;
  body: unknown;
}

/**
 * `POST /api/admin/tier-grant` body handler. The admin-secret check happens at
 * the route (authorizeAdmin); this validates + grants. Body:
 * `{ username, tier, durationDays }`.
 */
export async function handleAdminTierGrant(deps: TierGrantDeps, body: unknown): Promise<TierGrantHttpResult> {
  const b = (body ?? {}) as { username?: unknown; tier?: unknown; durationDays?: unknown };
  if (typeof b.username !== "string" || typeof b.tier !== "string") {
    return { status: 400, body: { error: "username and tier are required" } };
  }
  const durationDays = typeof b.durationDays === "number" ? b.durationDays : 0;
  try {
    const res = await grantTier(deps, {
      username: b.username,
      tier: b.tier as TierName,
      durationDays,
    });
    return { status: 200, body: { ok: true, ...res } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}
