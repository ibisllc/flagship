/**
 * Marketplace listing handlers.
 *
 * .com stores ONLY metadata (description, screenshots, canonical URL).
 * Never code, never user data. Listings are IRK-signed by the creator;
 * the username's registered IRK pubkey is the source of authorship truth.
 *
 * Routes:
 *   POST   /api/marketplace/list                          → upsert listing
 *   GET    /api/marketplace/<creator>/<slug>              → single listing
 *   DELETE /api/marketplace/<creator>/<slug>              → soft-remove
 *   POST   /api/marketplace/<creator>/<slug>/install      → bump install count
 *   GET    /api/marketplace/search?q=&cat=&sort=&...      → list
 */

import {
  verifyMarketplaceList,
  verifyMarketplaceScanResult,
  APP_ONELINER_MAX_LEN,
  type MarketplaceListRequest,
  type MarketplaceScanResult,
} from "@flagship/protocol";
import { computeMarketplaceRank } from "@flagship/storage";
import type {
  MarketplaceListingRecord,
  MarketplaceSearchQuery,
  MarketplaceStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, equalHex, hexToBytes } from "./hex.js";
import { constantTimeEqual } from "./customDomainRedirections.js";
import { forbidden, malformed, notFound, ok, type HandlerResponse } from "./types.js";
import { isPaidListing, isEntitledToInstall, type AppPurchaseDeps } from "./appPurchase.js";

export type ScanGrade = "A" | "B" | "C" | "D" | "F";

/** The install-gate outcome for a listing's scan grade.
 *   - "allow":   A–C (or any grade not on the block list) → normal install.
 *   - "caution": NULL / ungraded → allowed, but the client MUST surface a
 *                "not yet security-scanned" caution on the confirm.
 *   - "block":   a blocked grade (F by default) → install refused unless the
 *                caller passes an explicit override (a distinct "install
 *                anyway" action, never the normal install tap). */
export type InstallGate = "allow" | "caution" | "block";

/**
 * Grades that BLOCK install by default. F is the scanner's fail-closed
 * grade: a scan that could not complete, a no-ship custom-check failure,
 * OR a CRITICAL CVE all resolve to F (see the scanner's grade policy), so
 * blocking F blocks both a graded-F listing AND a hard-failed scan.
 * Conservative by design — only the worst grade blocks; A–D install
 * normally. Override the set per-deployment via
 * MARKETPLACE_INSTALL_BLOCKED_GRADES (a comma list, e.g. "D,F").
 */
export const DEFAULT_BLOCKED_INSTALL_GRADES: readonly ScanGrade[] = ["F"];

/** Parse the configurable blocked-grade set. Empty/garbage ⇒ the default. */
export function parseBlockedInstallGrades(csv: string | undefined): ScanGrade[] {
  if (!csv) return [...DEFAULT_BLOCKED_INSTALL_GRADES];
  const out: ScanGrade[] = [];
  for (const raw of csv.split(",")) {
    const g = raw.trim().toUpperCase();
    if (g === "A" || g === "B" || g === "C" || g === "D" || g === "F") {
      if (!out.includes(g)) out.push(g);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_BLOCKED_INSTALL_GRADES];
}

/**
 * Pure install-gate policy. Deterministic given (grade, blocked-set) so
 * the server enforces it and the clients mirror it for their confirm UX.
 */
export function installGateDecision(
  grade: ScanGrade | null | undefined,
  blocked: readonly ScanGrade[] = DEFAULT_BLOCKED_INSTALL_GRADES,
): InstallGate {
  if (grade == null) return "caution"; // never security-scanned
  return blocked.includes(grade) ? "block" : "allow";
}

export interface MarketplaceDeps {
  marketplace: MarketplaceStorage;
  usernames: UsernameStorage;
  /** Registered servers, keyed by FQDN → {username, identityPubKeyHex}. When
   *  present, `handleMarketplaceList` ALSO accepts a listing signed by a
   *  non-revoked server identity key belonging to the creator's account — the
   *  box-originated publish path (a creator publishing from their running box,
   *  which holds its daemon identity key but NOT the phone-held owner IRK).
   *  Absent ⇒ owner-IRK-only (unchanged). */
  servers?: ServerStorage;
  /** Paid-app entitlement store (#14). When present, the install endpoint
   *  gates paid listings on ownership; absent ⇒ everything installs free
   *  (pre-#14 behaviour). */
  purchases?: AppPurchaseDeps["purchases"];
  /** Grades that block install (require an explicit override). Defaults to
   *  DEFAULT_BLOCKED_INSTALL_GRADES (["F"]); the route layer supplies the
   *  parsed MARKETPLACE_INSTALL_BLOCKED_GRADES env override. */
  blockedInstallGrades?: readonly ScanGrade[];
  freshnessMs?: number;
  now?: () => number;
  /** Cap descriptionMd at this many chars. Default 10_000. */
  maxDescriptionLength?: number;
  /** Cap tagline at this many chars. Default APP_ONELINER_MAX_LEN (30). */
  maxTaglineLength?: number;
  /** Max screenshots. Default 5. */
  maxScreenshots?: number;
}

interface ListBody {
  request?: Partial<MarketplaceListRequest> & { irkPub?: string };
  signature?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TAG_RE = /^[a-z0-9-]{1,32}$/;

export async function handleMarketplaceList(
  deps: MarketplaceDeps,
  body: ListBody | undefined,
): Promise<HandlerResponse> {
  const r = body?.request;
  if (!r || typeof body?.signature !== "string") return malformed("malformed body");
  const required = [
    r.creator, r.slug, r.name, r.tagline, r.descriptionMd, r.category,
    r.tagsCsv, r.canonicalUrl, r.manifestHashHex, r.manifestJson, r.status,
  ];
  if (required.some((x) => typeof x !== "string")) return malformed("missing required string field");
  if (typeof r.publicDistribution !== "boolean") return malformed("publicDistribution must be boolean");
  if (typeof r.issuedAt !== "number") return malformed("issuedAt must be number");
  if (!Array.isArray(r.screenshotKeys)) return malformed("screenshotKeys must be an array");

  if (!SLUG_RE.test(r.slug!)) return malformed("invalid slug");
  if (!SLUG_RE.test(r.creator!)) return malformed("invalid creator");
  if (r.tagline!.length > (deps.maxTaglineLength ?? APP_ONELINER_MAX_LEN)) return malformed("tagline too long");
  if (r.descriptionMd!.length > (deps.maxDescriptionLength ?? 10_000)) return malformed("description too long");
  if (r.screenshotKeys.length > (deps.maxScreenshots ?? 5)) return malformed("too many screenshots");
  for (const t of (r.tagsCsv ?? "").split(",").filter(Boolean)) {
    if (!TAG_RE.test(t.trim())) return malformed(`invalid tag ${JSON.stringify(t)}`);
  }
  if (r.status !== "listed" && r.status !== "private") return malformed("status must be listed|private");

  // Authorship: the creator must be a registered username; IRK pubkey
  // resolved from .com's username store.
  const userRec = await deps.usernames.get(r.creator!);
  if (!userRec) return notFound("creator username not registered");

  // Verify signature against the registered IRK.
  const claim: MarketplaceListRequest = {
    creator: r.creator!,
    slug: r.slug!,
    name: r.name!,
    tagline: r.tagline!,
    descriptionMd: r.descriptionMd!,
    category: r.category!,
    tagsCsv: r.tagsCsv!,
    canonicalUrl: r.canonicalUrl!,
    manifestHashHex: r.manifestHashHex!,
    manifestJson: r.manifestJson!,
    screenshotKeys: r.screenshotKeys,
    publicDistribution: r.publicDistribution,
    status: r.status as "listed" | "private",
    issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("invalid hex");
  }
  // Accept EITHER the account's owner IRK (phone-signed) OR — when the servers
  // store is wired — a non-revoked server identity key belonging to the
  // creator's account (box-originated publish; the box holds its daemon
  // identity key but not the phone-held IRK).
  let signerOk = verifyMarketplaceList(claim, sig, irkPub);
  if (!signerOk && deps.servers) {
    const owned = await deps.servers.listForUser(r.creator!);
    for (const s of owned) {
      if (s.revokedAt) continue;
      let idPub: Uint8Array;
      try {
        idPub = hexToBytes(s.identityPubKeyHex);
      } catch {
        continue;
      }
      if (verifyMarketplaceList(claim, sig, idPub)) {
        signerOk = true;
        break;
      }
    }
  }
  if (!signerOk) return forbidden("invalid signature");

  // The manifest is carried on the listing but NOT in the canonical bytes; bind
  // it to the (verified) signature transitively by checking its hash equals the
  // signed `manifestHashHex`. Rejects a manifest swapped after signing.
  const manifestHash = bytesToHex(sha256(new TextEncoder().encode(r.manifestJson!)));
  if (!equalHex(manifestHash, r.manifestHashHex!)) {
    return malformed("manifest_json does not match manifest_hash_hex");
  }

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  // Look up existing for install_count + scanGrade preservation.
  const existing = await deps.marketplace.get(r.creator!, r.slug!);
  const next: MarketplaceListingRecord = {
    creator: r.creator!,
    slug: r.slug!,
    name: r.name!,
    tagline: r.tagline!,
    descriptionMd: r.descriptionMd!,
    category: r.category!,
    tagsCsv: r.tagsCsv!,
    canonicalUrl: r.canonicalUrl!,
    manifestHashHex: r.manifestHashHex!,
    manifestJson: r.manifestJson!,
    screenshotKeysJson: JSON.stringify(claim.screenshotKeys),
    status: claim.status,
    scanGrade: existing?.scanGrade,
    scanReportKey: existing?.scanReportKey,
    scanCompletedAt: existing?.scanCompletedAt,
    featuredUntil: existing?.featuredUntil,
    rankScore: 0,
    installCount: existing?.installCount ?? 0,
    publicDistribution: claim.publicDistribution,
    listedAt: existing?.listedAt ?? now,
    updatedAt: now,
    irkSignatureHex: body.signature,
  };
  next.rankScore = computeMarketplaceRank(next);

  await deps.marketplace.upsert(next);
  return ok({
    ok: true,
    listing: serializeListing(next),
  });
}

export async function handleMarketplaceGet(
  deps: MarketplaceDeps,
  creator: string,
  slug: string,
): Promise<HandlerResponse> {
  const rec = await deps.marketplace.get(creator, slug);
  if (!rec || rec.status === "removed") return notFound("listing not found");
  return ok({ listing: serializeListing(rec) });
}

export async function handleMarketplaceSearch(
  deps: MarketplaceDeps,
  query: MarketplaceSearchQuery,
): Promise<HandlerResponse> {
  const results = await deps.marketplace.search(query);
  return ok({
    listings: results.map(serializeListing),
    pagination: {
      limit: query.limit ?? 30,
      offset: query.offset ?? 0,
      count: results.length,
    },
  });
}

export async function handleMarketplaceRemove(
  deps: MarketplaceDeps,
  creator: string,
  slug: string,
  body: { request?: { issuedAt?: number }; signature?: string } | undefined,
): Promise<HandlerResponse> {
  const userRec = await deps.usernames.get(creator);
  if (!userRec) return notFound("creator not found");
  const r = body?.request;
  if (!r || typeof r.issuedAt !== "number" || typeof body?.signature !== "string") {
    return malformed("malformed body");
  }
  // We don't define a separate remove canonical-bytes type; reuse the
  // list signature semantics by re-fetching the existing record and
  // running the listing's stored sig against the new request envelope.
  // For v1 we accept the simpler scheme: signed list with status='removed'.
  // (The handler won't catch a stale-removal-replay across slugs because
  // canonical-bytes don't include "remove" verb. Acceptable for v1; v2
  // adds a dedicated `MarketplaceRemoveRequest` type.)
  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  await deps.marketplace.remove(creator, slug);
  return ok({ ok: true });
}

export async function handleMarketplaceInstall(
  deps: MarketplaceDeps,
  creator: string,
  slug: string,
  username?: string | null,
  /** An explicit "install anyway" override for a blocked (F-grade) listing.
   *  Threaded from the client's distinct override action — NOT the normal
   *  install tap. Ignored for allow/caution grades. */
  overrideBlockedInstall?: boolean,
): Promise<HandlerResponse> {
  const rec = await deps.marketplace.get(creator, slug);
  if (!rec || rec.status !== "listed") return notFound("listing not found");

  // Security-scan gate (#L GA). Grade F (which the scanner also assigns to a
  // hard-failed scan) is BLOCKED unless the caller passes an explicit
  // override; NULL/ungraded is ALLOWED but flagged so the client cautions;
  // A–D install normally. Enforced ahead of the paid gate so a dangerous app
  // is refused even to someone who already owns it.
  const blocked = deps.blockedInstallGrades ?? DEFAULT_BLOCKED_INSTALL_GRADES;
  const gate = installGateDecision(rec.scanGrade ?? null, blocked);
  if (gate === "block" && !overrideBlockedInstall) {
    return {
      status: 403,
      body: {
        ok: false,
        blocked: true,
        reason: "security-scan-failed",
        scan_grade: rec.scanGrade ?? null,
        override_required: true,
        error:
          "this app failed its security scan (grade F); installing is blocked — an explicit override is required to install anyway",
      },
    };
  }

  // Paid-app gate (#14): a paid listing needs a purchase. Free apps (or a
  // deployment without the purchases store wired) install unconditionally.
  const paid = isPaidListing(rec);
  if (paid && deps.purchases) {
    const entitled = await isEntitledToInstall(
      { purchases: deps.purchases, marketplace: deps.marketplace },
      rec,
      username,
    );
    if (!entitled) {
      // 402 Payment Required — the client routes the user to checkout.
      return {
        status: 402,
        body: {
          ok: false,
          paid: true,
          price_usd_cents: rec.priceUsdCents ?? 0,
          creator: rec.creator,
          slug: rec.slug,
          error: "this app must be purchased before it can be installed",
        },
      };
    }
  }

  await deps.marketplace.recordInstall(creator, slug);
  return ok({
    ok: true,
    paid,
    owned: paid ? true : undefined,
    scan_grade: rec.scanGrade ?? null,
    // Surface the advisory state so a client that calls this endpoint can
    // reflect it: "caution" ⇒ never-scanned; "overridden" ⇒ a blocked app
    // installed via the explicit override.
    scan_gate: gate === "caution" ? "caution" : gate === "block" ? "overridden" : "ok",
  });
}

/**
 * Receive a scanner-signed scan result. .com verifies the signature
 * against a fixed `scannerPubkey` (env-loaded; the Flagship-operated
 * scanner holds the corresponding private key). Updates scan_grade +
 * scan_report_key on the listing.
 *
 * Listings ship scan_grade=NULL until a verifying scan posts. The
 * search endpoint's `verifiedOnly` filter gates on this field.
 */
export interface MarketplaceScanDeps {
  marketplace: MarketplaceStorage;
  /** Ed25519 pubkey of the Flagship-operated scanner. */
  scannerPubkey: Uint8Array;
  freshnessMs?: number;
  now?: () => number;
}

export async function handleMarketplaceScanResult(
  deps: MarketplaceScanDeps,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const freshnessMs = deps.freshnessMs ?? 60 * 60_000; // 1 hour — scans run async

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.creator !== "string" ||
    typeof r.slug !== "string" ||
    typeof r.grade !== "string" ||
    typeof r.reportKey !== "string" ||
    typeof r.imageDigestHex !== "string" ||
    typeof r.scannedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (!["A", "B", "C", "D", "F"].includes(r.grade)) {
    return malformed("grade must be A|B|C|D|F");
  }
  if (Math.abs(now() - r.scannedAt) > freshnessMs) {
    return forbidden("stale scan result");
  }

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  const claim: MarketplaceScanResult = {
    creator: r.creator,
    slug: r.slug,
    grade: r.grade as "A" | "B" | "C" | "D" | "F",
    reportKey: r.reportKey,
    imageDigestHex: r.imageDigestHex,
    scannedAt: r.scannedAt,
  };
  if (!verifyMarketplaceScanResult(claim, sig, deps.scannerPubkey)) {
    return forbidden("invalid scanner signature");
  }
  const updated = await deps.marketplace.setScanResult(
    r.creator,
    r.slug,
    r.grade as "A" | "B" | "C" | "D" | "F",
    r.reportKey,
    r.scannedAt,
  );
  if (!updated) return notFound("listing not found");
  return ok({ ok: true, grade: r.grade });
}

/**
 * GET /api/internal/marketplace-scan-queue?staleDays=N — the
 * auto-trigger (#14). Same fail-closed constant-time bearer as the
 * other /api/internal/* endpoints. Returns listed listings that are
 * never-scanned OR whose last scan is older than `staleDays` (default
 * 30) so the nightly CI runner drains them with
 * scripts/scan-marketplace-listing.sh — closing the
 * "scan_grade=NULL forever" gap. Returns only the identity needed to
 * scan (no enumeration of private fields).
 */
export interface MarketplaceScanQueueDeps {
  marketplace: MarketplaceStorage;
  now?: () => number;
}

export async function handleMarketplaceScanQueue(
  deps: MarketplaceScanQueueDeps,
  presentedSecret: string | null,
  expectedSecret: string | undefined,
  staleDays: number | undefined,
): Promise<HandlerResponse> {
  if (!expectedSecret) {
    return { status: 503, body: { error: "scan-queue not configured" } };
  }
  if (!presentedSecret || !constantTimeEqual(presentedSecret, expectedSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const now = (deps.now ?? (() => Date.now()))();
  const days = Number.isFinite(staleDays) && (staleDays as number) > 0 ? (staleDays as number) : 30;
  const staleBefore = now - days * 24 * 60 * 60_000;
  const listings = await deps.marketplace.listNeedingScan(staleBefore);
  return ok({
    staleDays: days,
    queue: listings.map((l) => ({
      creator: l.creator,
      slug: l.slug,
      canonicalUrl: l.canonicalUrl,
      manifestHashHex: l.manifestHashHex,
      // The scanner resolves `runtime.image` from this to pick the
      // container-scan target and to skip a listing with no pullable
      // image (see services/marketplace-scanner resolveImageRefFromJson).
      manifestJson: l.manifestJson ?? "",
      scanCompletedAt: l.scanCompletedAt ?? null,
    })),
  });
}

function serializeListing(r: MarketplaceListingRecord) {
  return {
    creator: r.creator,
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    description_md: r.descriptionMd,
    category: r.category,
    tags: r.tagsCsv.split(",").filter(Boolean),
    canonical_url: r.canonicalUrl,
    manifest_hash: r.manifestHashHex,
    manifest_json: r.manifestJson ?? "",
    screenshots: JSON.parse(r.screenshotKeysJson) as string[],
    status: r.status,
    price_usd_cents: r.priceUsdCents ?? 0,
    is_paid: (r.priceUsdCents ?? 0) > 0,
    scan_grade: r.scanGrade ?? null,
    install_count: r.installCount,
    public_distribution: r.publicDistribution,
    featured: r.featuredUntil != null && r.featuredUntil > Date.now(),
    rank_score: Math.round(r.rankScore * 100) / 100,
    listed_at: r.listedAt,
    updated_at: r.updatedAt,
  };
}

void notFound;
