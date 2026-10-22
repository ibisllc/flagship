/**
 * Marketplace domain — the scanner's signed grade and the phone-signed
 * listing request.
 *
 * Split out of the original monolithic `auth.ts` (it lives on
 * `feat/marketplace`, which carries the marketplace feature on top of the
 * by-domain `auth.ts` refactor); tags, field order, and the canonical-bytes
 * construction are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_MARKETPLACE_SCAN_RESULT = "flagship/marketplace-scan-result/v1";

/**
 * Result of the marketplace security scan, posted by the scanner
 * service to .com. Signed by a SCANNER_SIGNING_PUBKEY held by the
 * Flagship-operated scanner — `.com` env carries the corresponding
 * pubkey so the verify gate is centralized. Listings stay
 * scan_grade=NULL until a verifying scan result lands.
 */
export interface MarketplaceScanResult {
  creator: string;
  slug: string;
  grade: "A" | "B" | "C" | "D" | "F";
  /** R2 object key for the full Trivy + custom-checks report. */
  reportKey: string;
  /** sha256 of the docker image scanned, hex. Pins WHICH image got the grade. */
  imageDigestHex: string;
  scannedAt: number;
}

function canonicalMarketplaceScanResult(r: MarketplaceScanResult): Bytes {
  return new TextEncoder().encode(
    [
      TAG_MARKETPLACE_SCAN_RESULT,
      r.creator,
      r.slug,
      r.grade,
      r.reportKey,
      r.imageDigestHex,
      r.scannedAt,
    ].join("|"),
  );
}

export function signMarketplaceScanResult(r: MarketplaceScanResult, scanner: Keypair): Bytes {
  return ed.sign(canonicalMarketplaceScanResult(r), scanner.privateKey);
}
export function verifyMarketplaceScanResult(
  r: MarketplaceScanResult,
  sig: Bytes,
  scannerPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalMarketplaceScanResult(r), scannerPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Marketplace listing
// ──────────────────────────────────────────────────────────────────────

/**
 * Phone-signed marketplace listing request. .com stores the listing
 * metadata AND the public app manifest here — never code or user data.
 * `manifestHashHex` commits to the manifest the listing claims; clients
 * re-check `sha256(manifestJson) == manifestHashHex` before installing.
 *
 * `manifestJson` is the app's public manifest (config, not a secret). It is
 * deliberately NOT part of the canonical bytes: the signature covers
 * `manifestHashHex`, and .com verifies `manifestHashHex == sha256(manifestJson)`
 * at listing-write time, so a tampered manifest is rejected without rippling
 * the canonical-bytes / signature construction across every platform.
 *
 * `descriptionMd` is markdown, capped at 10_000 chars on the .com side.
 * `screenshotKeys` is a list of R2 keys uploaded via a separate route;
 * the listing references them.
 */
export interface MarketplaceListRequest {
  creator: string;        // username
  slug: string;
  name: string;           // display name
  tagline: string;        // ≤ 80 chars
  descriptionMd: string;
  category: string;       // free text on .com side; UI offers a curated set
  tagsCsv: string;        // comma-separated lowercase tags
  canonicalUrl: string;   // <slug>.<creator>.flagship.services
  manifestHashHex: string;
  /** The app's public manifest JSON. NOT in the canonical bytes — bound to
   *  the signature transitively via `manifestHashHex` (see above). */
  manifestJson: string;
  screenshotKeys: string[];
  publicDistribution: boolean;
  status: "listed" | "private";
  issuedAt: number;
}

const TAG_MARKETPLACE_LIST = "flagship/marketplace-list/v1";

function canonicalMarketplaceList(r: MarketplaceListRequest): Bytes {
  return new TextEncoder().encode(
    [
      TAG_MARKETPLACE_LIST,
      r.creator,
      r.slug,
      r.name,
      r.tagline,
      r.descriptionMd,
      r.category,
      r.tagsCsv,
      r.canonicalUrl,
      r.manifestHashHex,
      r.screenshotKeys.join(","),
      r.publicDistribution ? "1" : "0",
      r.status,
      r.issuedAt,
    ].join("|"),
  );
}

export function signMarketplaceList(r: MarketplaceListRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalMarketplaceList(r), irk.privateKey);
}

export function verifyMarketplaceList(r: MarketplaceListRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalMarketplaceList(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Creator self-serve pricing (#15)
// ──────────────────────────────────────────────────────────────────────

/**
 * Creator-signed price change for their OWN listing. Signed by the
 * creator's account IRK (phone) OR a non-revoked server identity key of
 * the creator's account (box-originated) — the SAME signer set `.com`
 * already accepts for `MarketplaceListRequest`. `.com` gates the handler
 * to the listing's creator and caps `priceUsdCents` at MAX_APP_PRICE_CENTS.
 * `0` makes the app free.
 */
export interface SetAppPriceRequest {
  creator: string;
  slug: string;
  priceUsdCents: number;
  issuedAt: number;
}

const TAG_MARKETPLACE_SET_PRICE = "flagship/marketplace-set-price/v1";

function canonicalSetAppPrice(r: SetAppPriceRequest): Bytes {
  return new TextEncoder().encode(
    [
      TAG_MARKETPLACE_SET_PRICE,
      r.creator,
      r.slug,
      r.priceUsdCents,
      r.issuedAt,
    ].join("|"),
  );
}

export function signSetAppPrice(r: SetAppPriceRequest, signer: Keypair): Bytes {
  return ed.sign(canonicalSetAppPrice(r), signer.privateKey);
}

export function verifySetAppPrice(r: SetAppPriceRequest, sig: Bytes, signerPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalSetAppPrice(r), signerPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Developer console — signed read of a creator's own sales ledger (#15)
// ──────────────────────────────────────────────────────────────────────

/**
 * A creator's signed proof-of-ownership for reading their OWN payout
 * ledger (`GET /api/developer/sales/:creator`). The sales/revenue data is
 * sensitive, so unlike the public purchases list this read is gated: the
 * creator signs `creator|issuedAt` with their account IRK (or a
 * non-revoked server identity of their account), and `.com` verifies it +
 * freshness-checks `issuedAt` before returning the ledger.
 */
export interface DeveloperSalesReadRequest {
  creator: string;
  issuedAt: number;
}

const TAG_DEVELOPER_SALES_READ = "flagship/developer-sales-read/v1";

function canonicalDeveloperSalesRead(r: DeveloperSalesReadRequest): Bytes {
  return new TextEncoder().encode(
    [TAG_DEVELOPER_SALES_READ, r.creator, r.issuedAt].join("|"),
  );
}

export function signDeveloperSalesRead(r: DeveloperSalesReadRequest, signer: Keypair): Bytes {
  return ed.sign(canonicalDeveloperSalesRead(r), signer.privateKey);
}

export function verifyDeveloperSalesRead(
  r: DeveloperSalesReadRequest,
  sig: Bytes,
  signerPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalDeveloperSalesRead(r), signerPub);
  } catch {
    return false;
  }
}
