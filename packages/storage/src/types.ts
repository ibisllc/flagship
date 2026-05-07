/**
 * Pure interfaces for the .com control-plane stores. Two implementations:
 *   - InMemory (this package), used by tests and for dev runs.
 *   - D1 (this package), used in production by the Cloudflare Worker.
 *
 * The shapes mirror the in-memory record types previously defined in the
 * apps/web routes; they're hoisted here so both runtimes can share them
 * without depending on Fastify, Workers, or any HTTP framework.
 */

export interface UsernameRecord {
  username: string;
  irkPubHex: string;
  claimedAt: number;
}

export type AuthCodeStatus = "active" | "used" | "revoked";

export interface AuthCodeRecord {
  serial: string;
  username: string;
  serverName: string;
  serverDomain: string;
  delegatedPubKeyHex: string;
  userPubKeyHex: string;
  userSignatureHex: string;
  issuedAt: number;
  expiresAt: number;
  status: AuthCodeStatus;
  recordedAt: number;
  usedAt?: number;
  revokedAt?: number;
}

export type BuildTicketStatus = "active" | "redeemed" | "revoked";

export interface BuildTicketRecord {
  code: string;
  /** The signed InstallBlob serialized as JSON. Stored opaquely; readers
   *  parse it with @flagship/iso-personalizer's installBlobFromJson. */
  blobJson: string;
  blobSignatureHex: string;
  username: string;
  serverDomain: string;
  createdAt: number;
  expiresAt: number;
  status: BuildTicketStatus;
  redeemedAt?: number;
  redemptions: number;
}

export interface ServerRecord {
  serverDomain: string;
  username: string;
  identityPubKeyHex: string;
  registeredAt: number;
  revokedAt?: number;
  revocationReason?: string;
}

export interface RoutingRecord {
  subdomain: string;
  username: string;
  rckPubKeyHex: string;
  /** The server identity currently receiving traffic for this subdomain.
   *  Empty string until the first server registers. */
  currentTargetHex: string;
  registeredAt: number;
  lastTargetUpdate: number;
  /** Highest nonce seen in a SetRoutingTarget — replay protection. */
  lastTargetNonce: string;
}

export type Result<T = void> =
  | ({ ok: true } & ({} extends T ? unknown : { value: T }))
  | { ok: false; reason: string };

export interface UsernameStorage {
  put(rec: UsernameRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(username: string): Promise<UsernameRecord | undefined>;
  list(): Promise<UsernameRecord[]>;
}

export interface AuthCodeStorage {
  put(rec: AuthCodeRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(serial: string): Promise<AuthCodeRecord | undefined>;
  /** Atomic active+now<=expiresAt → used. Returns the post-state. */
  markUsed(serial: string, now: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  markRevoked(serial: string, now: number): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface BuildTicketStorage {
  put(rec: BuildTicketRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(code: string): Promise<BuildTicketRecord | undefined>;
  refresh(code: string, expiresAt: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Increment redemption count and stamp redeemedAt; idempotent for the same now. */
  markRedeemed(code: string, now: number): Promise<void>;
}

export interface ServerStorage {
  put(rec: ServerRecord): Promise<void>;
  get(serverDomain: string): Promise<ServerRecord | undefined>;
  listForUser(username: string): Promise<ServerRecord[]>;
  /**
   * Every non-revoked server. Used by operational tooling — e.g. the
   * DNS re-publisher that rewrites A/AAAA after a passthrough-IP move.
   */
  listAll(): Promise<ServerRecord[]>;
  revoke(serverDomain: string, reason: string, at: number): Promise<boolean>;
}

export interface InstallEvent {
  serial: string;
  seq: number;
  eventName: string;
  detail: string;
  postedAt: number;
}

export interface InstallEventStorage {
  /** Append a new event. Implementations cap the per-serial history at
   *  `maxPerSerial` (default 100); older events get dropped. */
  put(rec: Omit<InstallEvent, "seq">): Promise<{ ok: true; seq: number } | { ok: false; reason: string }>;
  list(serial: string, sinceSeq?: number): Promise<InstallEvent[]>;
}

export interface RoutingStorage {
  /** Register a fresh RCK for a subdomain. Errors if the subdomain is taken
   *  by a different RCK; idempotent for the same RCK pubkey. */
  register(rec: RoutingRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(subdomain: string): Promise<RoutingRecord | undefined>;
  setTarget(
    subdomain: string,
    newTargetHex: string,
    nonce: string,
    at: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface SealedLuksKeyRecord {
  serverDomain: string;
  sealedKeyHex: string;
  sealedAt: number;
}

export interface UnlockKeyDeposit {
  serverDomain: string;
  unlockKeyHex: string;
  depositedAt: number;
  expiresAt: number;
}

export interface LuksKeyStorage {
  /** Server stores its sealed LUKS root key (sealed-with-BAK). Idempotent overwrite. */
  putSealed(rec: SealedLuksKeyRecord): Promise<void>;
  /** Public read of the sealed blob (useless without the phone). */
  getSealed(serverDomain: string): Promise<SealedLuksKeyRecord | undefined>;
  /** Phone deposits the unsealed key. Replaces any prior pending deposit. */
  putUnlock(rec: UnlockKeyDeposit): Promise<void>;
  /**
   * Boot stage fetches and atomically clears the deposit. Returns
   * undefined if no deposit is pending or the deposit has expired.
   */
  consumeUnlock(serverDomain: string, now: number): Promise<UnlockKeyDeposit | undefined>;
}

export interface Storage {
  usernames: UsernameStorage;
  authCodes: AuthCodeStorage;
  buildTickets: BuildTicketStorage;
  servers: ServerStorage;
  routing: RoutingStorage;
  installEvents: InstallEventStorage;
  luksKeys: LuksKeyStorage;
  marketplace: MarketplaceStorage;
  pushTokens: PushTokenStorage;
  llmPromo: LlmPromoStorage;
  tiers: TierStorage;
  entitlementRevocations: EntitlementRevocationStorage;
}

// ──────────────────────────────────────────────────────────────────────
// Entitlement revocation lists (N12c)
// ──────────────────────────────────────────────────────────────────────

export interface EntitlementRevocationListRecord {
  username: string;
  /** JSON array of revoked cert id hex strings. */
  certIdsJson: string;
  /** IRK signature over the canonical bytes of the list (for .services to verify). */
  irkSignatureHex: string;
  issuedAt: number;
  updatedAt: number;
}

export interface EntitlementRevocationStorage {
  /**
   * Replace the user's revocation list iff `issuedAt` is strictly
   * greater than the existing list's `issuedAt` (monotonic — older
   * lists can't un-revoke). Returns the stored record (either the
   * new one or the unchanged existing one).
   */
  putIfNewer(rec: EntitlementRevocationListRecord): Promise<{
    stored: EntitlementRevocationListRecord;
    accepted: boolean;
  }>;
  get(username: string): Promise<EntitlementRevocationListRecord | undefined>;
}

// ──────────────────────────────────────────────────────────────────────
// Marketplace
// ──────────────────────────────────────────────────────────────────────

export interface MarketplaceListingRecord {
  creator: string;
  slug: string;
  name: string;
  tagline: string;
  descriptionMd: string;
  category: string;
  tagsCsv: string;
  canonicalUrl: string;
  manifestHashHex: string;
  screenshotKeysJson: string;       // JSON array of strings
  status: "listed" | "private" | "removed";
  scanGrade?: "A" | "B" | "C" | "D" | "F";
  scanReportKey?: string;
  scanCompletedAt?: number;
  featuredUntil?: number;
  rankScore: number;
  installCount: number;
  publicDistribution: boolean;
  listedAt: number;
  updatedAt: number;
  irkSignatureHex: string;
}

export interface MarketplaceSearchQuery {
  text?: string;            // free-text search across name + tagline + tags
  category?: string;
  verifiedOnly?: boolean;
  limit?: number;           // default 30
  offset?: number;          // default 0
  sort?: "popular" | "newest" | "name";
}

export interface MarketplaceStorage {
  upsert(rec: MarketplaceListingRecord): Promise<void>;
  get(creator: string, slug: string): Promise<MarketplaceListingRecord | undefined>;
  search(q: MarketplaceSearchQuery): Promise<MarketplaceListingRecord[]>;
  remove(creator: string, slug: string): Promise<void>;
  recordInstall(creator: string, slug: string): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// Push tokens
// ──────────────────────────────────────────────────────────────────────

export interface PushTokenRecord {
  tokenId: string;                      // random 16-byte hex
  username: string;
  platform: "apns" | "fcm" | "webpush";
  providerToken: string;                 // opaque
  pushX25519PubHex: string;
  registrationSignatureHex: string;
  registeredAt: number;
  lastSeenAt: number;
}

export interface PushTokenStorage {
  put(rec: PushTokenRecord): Promise<void>;
  get(tokenId: string): Promise<PushTokenRecord | undefined>;
  listByUser(username: string): Promise<PushTokenRecord[]>;
  remove(tokenId: string): Promise<void>;
  touchLastSeen(tokenId: string, at: number): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// LLM-promo usage
// ──────────────────────────────────────────────────────────────────────

export interface LlmPromoUsageRecord {
  username: string;
  day: number;                            // floor(ms / 86_400_000)
  dailyCount: number;
  dailyInputTokens: number;
  dailyOutputTokens: number;
}

export interface LlmPromoLifetimeRecord {
  username: string;
  lifetimeCount: number;
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  /** Per-tier override; null fields fall back to defaults. */
  overrideJson?: string;
  updatedAt: number;
}

export interface LlmPromoStorage {
  getDaily(username: string, day: number): Promise<LlmPromoUsageRecord | undefined>;
  bumpDaily(username: string, day: number, inputTokens: number, outputTokens: number): Promise<LlmPromoUsageRecord>;
  getLifetime(username: string): Promise<LlmPromoLifetimeRecord | undefined>;
  bumpLifetime(username: string, inputTokens: number, outputTokens: number, now: number): Promise<LlmPromoLifetimeRecord>;
}

// ──────────────────────────────────────────────────────────────────────
// Tier subscriptions
// ──────────────────────────────────────────────────────────────────────

export type TierName = "free" | "hobby" | "maker";

export interface TierSubscriptionRecord {
  username: string;
  tier: TierName;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodEnd?: number;
  irkReceiptHex?: string;
  irkSignatureHex?: string;
  updatedAt: number;
}

export interface TierStorage {
  get(username: string): Promise<TierSubscriptionRecord | undefined>;
  put(rec: TierSubscriptionRecord): Promise<void>;
}

