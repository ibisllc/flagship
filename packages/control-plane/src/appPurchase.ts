// Paid-app purchase entitlements (#14 — the golden goose).
//
// A marketplace listing may carry a price (priceUsdCents; absent/0 ⇒ free). A
// paid app can't be installed without a purchase attributing it to a username.
// grantAppPurchase is the SINGLE writer (Stripe webhook #11, an admin comp, or
// a voucher all converge here), idempotent so a redelivery never duplicates.
//
// Distribution stays box-direct over the listing's canonical pipe — .com only
// ATTESTS ownership (a metadata yes/no), it never sees or proxies the app's
// content. The install endpoint returns the install go-ahead for a free app,
// or for a paid app the caller already owns; otherwise 402 with the price so
// the client can route to checkout.

import type { AppPurchaseStorage, MarketplaceListingRecord, MarketplaceStorage } from "@flagship/storage";

const USERNAME_RE = /^[a-z0-9]{3,30}$/;
/** $1,000 ceiling — a fat-fingered price can't bill a fortune. */
export const MAX_APP_PRICE_CENTS = 100_000;

export interface AppPurchaseDeps {
  purchases: AppPurchaseStorage;
  marketplace: MarketplaceStorage;
  now?: () => number;
}

function nowMs(deps: AppPurchaseDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/** A listing is free when it has no positive price. */
export function isPaidListing(listing: Pick<MarketplaceListingRecord, "priceUsdCents">): boolean {
  return (listing.priceUsdCents ?? 0) > 0;
}

export interface GrantAppPurchaseArgs {
  username: string;
  creator: string;
  slug: string;
  source: "stripe" | "admin" | "voucher";
  ref?: string;
}

export interface GrantAppPurchaseResult {
  username: string;
  creator: string;
  slug: string;
  /** true if this granted a NEW entitlement; false if already owned. */
  granted: boolean;
}

/** Grant `username` ownership of `<creator>/<slug>`. Validates the username +
 *  that the listing exists, then idempotently records the purchase. Throws on
 *  invalid input / unknown listing so a bad call never writes a dangling row. */
export async function grantAppPurchase(
  deps: AppPurchaseDeps,
  args: GrantAppPurchaseArgs,
): Promise<GrantAppPurchaseResult> {
  const username = String(args.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new Error("invalid username (3–30 lowercase letters/digits)");
  const creator = String(args.creator ?? "").trim().toLowerCase();
  const slug = String(args.slug ?? "").trim().toLowerCase();
  if (!creator || !slug) throw new Error("creator and slug are required");
  const listing = await deps.marketplace.get(creator, slug);
  if (!listing || listing.status === "removed") throw new Error("listing not found");

  const granted = await deps.purchases.grant({
    username,
    creator,
    slug,
    purchasedAt: nowMs(deps),
    source: args.source,
    ...(args.ref ? { ref: args.ref } : {}),
  });
  return { username, creator, slug, granted };
}

/** May `username` install `<creator>/<slug>`? Free ⇒ always. Paid ⇒ only if
 *  owned. (An anonymous/absent username can only install free apps.) */
export async function isEntitledToInstall(
  deps: AppPurchaseDeps,
  listing: MarketplaceListingRecord,
  username: string | null | undefined,
): Promise<boolean> {
  if (!isPaidListing(listing)) return true;
  const u = String(username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return false;
  return deps.purchases.has(u, listing.creator, listing.slug);
}

export interface AppPurchaseHttpResult {
  status: number;
  body: unknown;
}

/** `GET /api/users/:u/purchases` — PUBLIC. The install-what-you-own list
 *  (mobile #19 consumes it). Account METADATA only (which apps the user owns),
 *  same disclosure class as the `/pods` directory. */
export async function handleListUserPurchases(
  deps: AppPurchaseDeps,
  username: string | null,
): Promise<AppPurchaseHttpResult> {
  const u = String(username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return { status: 400, body: { error: "valid username required" } };
  const records = await deps.purchases.listForUser(u);
  return {
    status: 200,
    body: {
      ok: true,
      purchases: records.map((r) => ({
        creator: r.creator,
        slug: r.slug,
        purchased_at: r.purchasedAt,
        source: r.source,
      })),
    },
  };
}

/** `POST /api/admin/marketplace/:creator/:slug/price` — ADMIN. Body
 *  `{ priceUsdCents }` (0 ⇒ make free). Curated pricing for now (#15 is dev
 *  self-serve). */
export async function handleAdminSetAppPrice(
  deps: AppPurchaseDeps,
  creator: string,
  slug: string,
  body: unknown,
): Promise<AppPurchaseHttpResult> {
  const b = (body ?? {}) as { priceUsdCents?: unknown };
  if (typeof b.priceUsdCents !== "number" || !Number.isFinite(b.priceUsdCents) || b.priceUsdCents < 0) {
    return { status: 400, body: { error: "priceUsdCents must be a non-negative number" } };
  }
  if (b.priceUsdCents > MAX_APP_PRICE_CENTS) {
    return { status: 400, body: { error: `priceUsdCents must be ≤ ${MAX_APP_PRICE_CENTS}` } };
  }
  const ok = await deps.marketplace.setPrice(creator.toLowerCase(), slug.toLowerCase(), Math.floor(b.priceUsdCents));
  if (!ok) return { status: 404, body: { error: "listing not found" } };
  return { status: 200, body: { ok: true, priceUsdCents: Math.floor(b.priceUsdCents) || 0 } };
}

/** `POST /api/admin/marketplace/:creator/:slug/grant-purchase` — ADMIN. Body
 *  `{ username }`. A comp / support grant (the cash/Monero lane for an app,
 *  mirroring the tier admin-grant). */
export async function handleAdminGrantPurchase(
  deps: AppPurchaseDeps,
  creator: string,
  slug: string,
  body: unknown,
): Promise<AppPurchaseHttpResult> {
  const b = (body ?? {}) as { username?: unknown; ref?: unknown };
  if (typeof b.username !== "string") return { status: 400, body: { error: "username is required" } };
  try {
    const res = await grantAppPurchase(deps, {
      username: b.username,
      creator,
      slug,
      source: "admin",
      ...(typeof b.ref === "string" ? { ref: b.ref } : {}),
    });
    return { status: 200, body: { ok: true, ...res } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}
