// Developer console (#15) — a creator's signed read of their OWN payout
// ledger. Revenue data is sensitive, so this read is GATED: the creator
// signs `creator|issuedAt` with their account IRK (or a non-revoked server
// identity of their account — the same signer set .com accepts for a
// listing), and .com verifies it + freshness before returning the ledger.
//
// The endpoint reports the ledger + rollups (gross/cut/net + install
// counts, per-listing and in total) and the net "payout owed". Actual
// disbursement is an owner/ops process — this is the source-of-truth
// report it runs from, not a money movement.

import type {
  AppSaleRecord,
  AppSalesStorage,
  MarketplaceListingRecord,
  MarketplaceStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import {
  verifyDeveloperSalesRead,
  type DeveloperSalesReadRequest,
} from "@flagship/protocol";
import { hexToBytes } from "./hex.js";
import { DEFAULT_MARKETPLACE_CUT_BPS, listingId as makeListingId } from "./appPurchase.js";

export interface DeveloperSalesDeps {
  sales: AppSalesStorage;
  marketplace: MarketplaceStorage;
  usernames: UsernameStorage;
  /** When present, ALSO accept a non-revoked server identity of the creator's
   *  account (box-originated read). Absent ⇒ owner-IRK-only. */
  servers?: ServerStorage;
  /** Current platform cut in bps, surfaced so the console can show it. */
  cutBps?: number;
  freshnessMs?: number;
  now?: () => number;
}

export interface DeveloperSalesHttpResult {
  status: number;
  body: unknown;
}

function perListingRollup(sales: AppSaleRecord[]): Map<string, { grossCents: number; cutCents: number; netCents: number; saleCount: number }> {
  const by = new Map<string, { grossCents: number; cutCents: number; netCents: number; saleCount: number }>();
  for (const s of sales) {
    const cur = by.get(s.listingId) ?? { grossCents: 0, cutCents: 0, netCents: 0, saleCount: 0 };
    cur.grossCents += s.grossCents;
    cur.cutCents += s.cutCents;
    cur.netCents += s.netCents;
    cur.saleCount += 1;
    by.set(s.listingId, cur);
  }
  return by;
}

/**
 * `GET /api/developer/sales/:creator?issuedAt=&sig=` — the developer
 * console report. Verifies the creator's signed read proof, then returns
 * the ledger + rollups.
 */
export async function handleDeveloperSales(
  deps: DeveloperSalesDeps,
  creator: string,
  issuedAtRaw: string | null,
  sigHex: string | null,
): Promise<DeveloperSalesHttpResult> {
  const c = String(creator).toLowerCase();
  const issuedAt = Number(issuedAtRaw);
  if (!issuedAtRaw || !Number.isFinite(issuedAt)) {
    return { status: 400, body: { error: "issuedAt query param required" } };
  }
  if (!sigHex) return { status: 400, body: { error: "sig query param required" } };

  const userRec = await deps.usernames.get(c);
  if (!userRec) return { status: 404, body: { error: "creator username not registered" } };

  const claim: DeveloperSalesReadRequest = { creator: c, issuedAt };
  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    sig = hexToBytes(sigHex);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  let signerOk = verifyDeveloperSalesRead(claim, sig, irkPub);
  if (!signerOk && deps.servers) {
    const owned = await deps.servers.listForUser(c);
    for (const srv of owned) {
      if (srv.revokedAt) continue;
      try {
        if (verifyDeveloperSalesRead(claim, sig, hexToBytes(srv.identityPubKeyHex))) {
          signerOk = true;
          break;
        }
      } catch { /* skip unparseable key */ }
    }
  }
  if (!signerOk) return { status: 403, body: { error: "invalid signature" } };

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = deps.now ? deps.now() : Date.now();
  if (Math.abs(now - issuedAt) > freshness) return { status: 403, body: { error: "stale request" } };

  const [sales, totals, listings] = await Promise.all([
    deps.sales.listForCreator(c),
    deps.sales.totalsForCreator(c),
    deps.marketplace.listByCreator(c),
  ]);
  const rollup = perListingRollup(sales);

  const listingReport = listings.map((l: MarketplaceListingRecord) => {
    const lid = makeListingId(l.creator, l.slug);
    const agg = rollup.get(lid) ?? { grossCents: 0, cutCents: 0, netCents: 0, saleCount: 0 };
    return {
      listing_id: lid,
      creator: l.creator,
      slug: l.slug,
      name: l.name,
      status: l.status,
      price_usd_cents: l.priceUsdCents ?? 0,
      is_paid: (l.priceUsdCents ?? 0) > 0,
      scan_grade: l.scanGrade ?? null,
      install_count: l.installCount,
      gross_cents: agg.grossCents,
      cut_cents: agg.cutCents,
      net_cents: agg.netCents,
      sale_count: agg.saleCount,
    };
  });

  return {
    status: 200,
    body: {
      ok: true,
      creator: c,
      currency: "usd",
      cut_bps: deps.cutBps ?? DEFAULT_MARKETPLACE_CUT_BPS,
      totals: {
        gross_cents: totals.grossCents,
        cut_cents: totals.cutCents,
        net_cents: totals.netCents,
        sale_count: totals.saleCount,
        // Net is the amount owed to the creator; disbursement is an ops step.
        payout_owed_cents: totals.netCents,
        install_count: listingReport.reduce((s, l) => s + l.install_count, 0),
      },
      listings: listingReport,
      sales: sales.map((s) => ({
        sale_key: s.saleKey,
        listing_id: s.listingId,
        buyer: s.buyerAccount,
        gross_cents: s.grossCents,
        cut_cents: s.cutCents,
        net_cents: s.netCents,
        currency: s.currency,
        at: s.at,
      })),
    },
  };
}
