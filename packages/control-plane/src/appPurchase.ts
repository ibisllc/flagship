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

import type {
  AppPurchaseStorage,
  AppSalesStorage,
  MarketplaceListingRecord,
  MarketplaceStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { verifySetAppPrice, type SetAppPriceRequest } from "@flagship/protocol";
import { hexToBytes } from "./hex.js";

const USERNAME_RE = /^[a-z0-9]{3,30}$/;
/** $1,000 ceiling — a fat-fingered price can't bill a fortune. */
export const MAX_APP_PRICE_CENTS = 100_000;

/** Platform revenue cut, in basis points (1% = 100 bps). Default 15%.
 *  Configurable per-deployment via MARKETPLACE_CUT_BPS. */
export const DEFAULT_MARKETPLACE_CUT_BPS = 1500;

/** Parse the configurable cut. Out-of-range / garbage ⇒ the default. A cut
 *  must be 0..10000 bps (0%..100%). */
export function parseCutBps(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MARKETPLACE_CUT_BPS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return DEFAULT_MARKETPLACE_CUT_BPS;
  return Math.floor(n);
}

/** Split a gross amount into the platform cut + the creator's net. Floors the
 *  cut (rounding in the creator's favor). */
export function computeCut(
  grossCents: number,
  cutBps: number = DEFAULT_MARKETPLACE_CUT_BPS,
): { cutCents: number; netCents: number } {
  const bps =
    Number.isFinite(cutBps) && cutBps >= 0 && cutBps <= 10_000
      ? Math.floor(cutBps)
      : DEFAULT_MARKETPLACE_CUT_BPS;
  const gross = Math.max(0, Math.floor(grossCents));
  const cutCents = Math.floor((gross * bps) / 10_000);
  return { cutCents, netCents: gross - cutCents };
}

/** Composite marketplace listing id: `<creator>--<slug>`. */
export function listingId(creator: string, slug: string): string {
  return `${creator}--${slug}`;
}

export interface AppPurchaseDeps {
  purchases: AppPurchaseStorage;
  marketplace: MarketplaceStorage;
  /** Payout ledger (#15). When present, a NEW paid grant (except an admin
   *  comp — no revenue) also writes an app_sales row. */
  sales?: AppSalesStorage;
  /** Platform cut in bps for the sale split. Defaults to DEFAULT_MARKETPLACE_CUT_BPS. */
  cutBps?: number;
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
  /** The Stripe event id, when source==="stripe". Used as the app_sales
   *  idempotency key (and audit provenance) so a webhook redelivery never
   *  double-writes a sale. */
  stripeEventId?: string;
}

export interface GrantAppPurchaseResult {
  username: string;
  creator: string;
  slug: string;
  /** true if this granted a NEW entitlement; false if already owned. */
  granted: boolean;
  /** true if this write also recorded an app_sales payout row. */
  saleRecorded?: boolean;
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

  const at = nowMs(deps);
  const granted = await deps.purchases.grant({
    username,
    creator,
    slug,
    purchasedAt: at,
    source: args.source,
    ...(args.ref ? { ref: args.ref } : {}),
  });

  // Revenue split (#15): a NEW paid grant that isn't an admin comp (a comp is
  // free — no revenue, no payout) writes an app_sales row. The ledger write
  // is itself idempotent on sale_key, so it double-guards a redelivery even if
  // `granted` were ever true twice. A failed grant, a free app, or a missing
  // sales store all short-circuit (nothing to pay out).
  let saleRecorded = false;
  const grossCents = listing.priceUsdCents ?? 0;
  if (deps.sales && granted && grossCents > 0 && args.source !== "admin") {
    const { cutCents, netCents } = computeCut(grossCents, deps.cutBps ?? DEFAULT_MARKETPLACE_CUT_BPS);
    const saleKey =
      args.source === "stripe" && args.stripeEventId
        ? args.stripeEventId
        : `${args.source}:${creator}:${slug}:${username}`;
    saleRecorded = await deps.sales.record({
      saleKey,
      listingId: listingId(creator, slug),
      creatorAccount: creator,
      buyerAccount: username,
      grossCents,
      cutCents,
      netCents,
      currency: "usd",
      ...(args.source === "stripe" && args.stripeEventId ? { stripeEventId: args.stripeEventId } : {}),
      at,
    });
  }

  return { username, creator, slug, granted, saleRecorded };
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

/** `POST /api/marketplace/:creator/:slug/price` — CREATOR self-serve (#15).
 *  Body `{ request: SetAppPriceRequest, signature }`. The creator signs with
 *  their account IRK (phone) OR a non-revoked server identity key of their
 *  account (box-originated) — the same signer set `.com` accepts for a
 *  listing. Gated to the listing's creator; `priceUsdCents` capped at
 *  MAX_APP_PRICE_CENTS (0 ⇒ free). Distinct from the admin path
 *  (handleAdminSetAppPrice), which stays for curation/support. */
export interface CreatorSetAppPriceDeps {
  marketplace: MarketplaceStorage;
  usernames: UsernameStorage;
  /** When present, ALSO accept a non-revoked server identity key of the
   *  creator's account (box-originated). Absent ⇒ owner-IRK-only. */
  servers?: ServerStorage;
  freshnessMs?: number;
  now?: () => number;
}

export async function handleCreatorSetAppPrice(
  deps: CreatorSetAppPriceDeps,
  creator: string,
  slug: string,
  body: unknown,
): Promise<AppPurchaseHttpResult> {
  const b = (body ?? {}) as { request?: Partial<SetAppPriceRequest>; signature?: unknown };
  const r = b.request;
  if (!r || typeof b.signature !== "string") return { status: 400, body: { error: "malformed body" } };
  const c = String(creator).toLowerCase();
  const s = String(slug).toLowerCase();
  if (typeof r.creator !== "string" || typeof r.slug !== "string" ||
      typeof r.priceUsdCents !== "number" || typeof r.issuedAt !== "number") {
    return { status: 400, body: { error: "request needs creator, slug, priceUsdCents, issuedAt" } };
  }
  // The signed request must name the same listing as the route.
  if (r.creator.toLowerCase() !== c || r.slug.toLowerCase() !== s) {
    return { status: 400, body: { error: "request creator/slug must match the route" } };
  }
  if (!Number.isFinite(r.priceUsdCents) || r.priceUsdCents < 0) {
    return { status: 400, body: { error: "priceUsdCents must be a non-negative number" } };
  }
  if (r.priceUsdCents > MAX_APP_PRICE_CENTS) {
    return { status: 400, body: { error: `priceUsdCents must be ≤ ${MAX_APP_PRICE_CENTS}` } };
  }

  const userRec = await deps.usernames.get(c);
  if (!userRec) return { status: 404, body: { error: "creator username not registered" } };

  const claim: SetAppPriceRequest = {
    creator: r.creator, slug: r.slug, priceUsdCents: r.priceUsdCents, issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  // Accept the creator's owner IRK OR a non-revoked server identity of the
  // creator's account (box-originated) — mirrors handleMarketplaceList.
  let signerOk = verifySetAppPrice(claim, sig, irkPub);
  if (!signerOk && deps.servers) {
    const owned = await deps.servers.listForUser(c);
    for (const srv of owned) {
      if (srv.revokedAt) continue;
      try {
        if (verifySetAppPrice(claim, sig, hexToBytes(srv.identityPubKeyHex))) {
          signerOk = true;
          break;
        }
      } catch { /* skip an unparseable key */ }
    }
  }
  if (!signerOk) return { status: 403, body: { error: "invalid signature" } };

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = deps.now ? deps.now() : Date.now();
  if (Math.abs(now - r.issuedAt) > freshness) return { status: 403, body: { error: "stale request" } };

  const okSet = await deps.marketplace.setPrice(c, s, Math.floor(r.priceUsdCents));
  if (!okSet) return { status: 404, body: { error: "listing not found" } };
  return { status: 200, body: { ok: true, creator: c, slug: s, priceUsdCents: Math.floor(r.priceUsdCents) || 0 } };
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
