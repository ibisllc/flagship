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
  /**
   * Atomically swap the IRK pubkey for an existing username. Used by
   * the recovery re-pair flow (J.3) after the 24h grace expires
   * without an objection. Returns false if the username doesn't
   * exist or if the supplied `expectedOldIrkPubHex` doesn't match
   * the stored value (concurrent rotation defense).
   */
  swapIrkPub(
    username: string,
    expectedOldIrkPubHex: string,
    newIrkPubHex: string,
    at: number,
  ): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────
// Username aliases (#93 — username handover)
// ──────────────────────────────────────────────────────────────────────

/**
 * A single permanent mapping `oldUsername → newUsername`. Rows are
 * write-once: once `old_username` is mapped, neither it nor any new
 * alias from it can ever be re-issued. The old name is consumed FOREVER.
 *
 * `effectiveAt` is informational (clients use it for soft-redirect
 * decisions during the operational overlap window); the alias itself
 * is authoritative the moment the row is written.
 */
export interface UsernameAliasRecord {
  oldUsername: string;
  newUsername: string;
  effectiveAt: number;
  /** Hex of the IRK signature over the UsernameRename canonical bytes. */
  signatureHex: string;
}

export interface UsernameAliasStorage {
  /**
   * Insert a fresh alias row. Returns ok=false if `oldUsername`
   * already has an alias — the old name is one-shot. Callers MUST
   * NOT update the row in place; renames out of a renamed name are
   * a fresh oldUsername=current → newUsername=fresh edge, not an
   * edit of the existing alias.
   */
  insert(rec: UsernameAliasRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Read a single alias by its old-username key. */
  get(oldUsername: string): Promise<UsernameAliasRecord | undefined>;
  /**
   * Resolve a stale-link username to its current name by walking the
   * alias chain. Returns the input unchanged when no alias exists.
   * Cycle-safe — stops after `maxHops` (default 8) and returns the
   * last-visited name; cycles cannot occur in a write-once table but
   * the bound is a defensive shield against data corruption.
   */
  resolve(username: string, maxHops?: number): Promise<{
    resolved: string;
    hops: string[];
  }>;
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

// ──────────────────────────────────────────────────────────────────────
// Webapp cloud-shard recovery records (WebAuthn PRF)
// ──────────────────────────────────────────────────────────────────────

export interface WebauthnRecoveryRecord {
  username: string;
  credentialIdHex: string;
  /** Opaque AES-GCM ciphertext (base64). `.com` cannot decrypt — only the user's passkey can. */
  wrappedUmkB64: string;
  irkPubHex: string;
  /**
   * Task #74 — passphrase-derived fetch-token gate (hex SHA-256).
   * `.com` only releases the ciphertext when the caller presents a
   * token whose SHA-256 matches this hash. Nullable for legacy rows
   * uploaded before the migration; new rows MUST set it.
   */
  fetchTokenHashHex?: string;
  /**
   * Task #74 — passphrase-derived PRF-salt hash (hex SHA-256). The
   * stored hash binds the PRF salt the client used during enrolment
   * so a tampered .com cannot swap the salt and trick the client into
   * deriving a different PRF output.
   */
  prfSaltHashHex?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebauthnRecoveryStorage {
  /** Insert or replace. Caller has already verified the IRK signature. */
  upsert(rec: WebauthnRecoveryRecord): Promise<void>;
  /** Public read by username; ciphertext-only so disclosure is safe. */
  get(username: string): Promise<WebauthnRecoveryRecord | undefined>;
  /** Delete by username (kill switch — also requires sig verification at handler). */
  delete(username: string): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────
// Pending re-pair (recovery J.3 — IRK takeover after lost-UMK recovery)
// ──────────────────────────────────────────────────────────────────────

export interface PendingRePairRecord {
  username: string;
  newIrkPubHex: string;
  oldIrkPubHex: string;
  initiatedAt: number;
  /** Wall-clock ms after which `complete` will swap if no objection. */
  completesAt: number;
  /** Set when an objection is filed; blocks completion. */
  objectedAt?: number;
}

export interface PendingRePairStorage {
  /**
   * Initiate a re-pair. Returns ok=false if a pending row already
   * exists (caller should object the old one before re-initiating).
   */
  initiate(rec: PendingRePairRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(username: string): Promise<PendingRePairRecord | undefined>;
  /** Mark the row as objected; no-op if no row exists. Returns whether the row existed. */
  object(username: string, at: number): Promise<boolean>;
  /** Delete the row (called after `complete` succeeds). */
  delete(username: string): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────
// Pending unlock approvals (push trigger from /consume)
// ──────────────────────────────────────────────────────────────────────

export interface PendingUnlockApprovalRecord {
  serverDomain: string;
  requestId: string;
  requestedAt: number;
  /** Wall-clock ms of the last push fan-out for this row, or 0 if never. */
  lastPushAt: number;
}

export interface PendingUnlockApprovalStorage {
  /**
   * Insert (or refresh) a pending row keyed by serverDomain. Returns
   * `{ requestId, shouldPush }` — `shouldPush` is true iff the row
   * was newly inserted OR `now - lastPushAt > pushDedupMs`. Either
   * way, callers should `touchLastPushAt(serverDomain, now)` after a
   * successful fan-out so subsequent polls within the dedup window
   * skip the push.
   */
  upsertWithDedup(
    serverDomain: string,
    requestId: string,
    now: number,
    pushDedupMs: number,
  ): Promise<{ requestId: string; shouldPush: boolean }>;
  /** Confirm push fired (writes lastPushAt). */
  touchLastPushAt(serverDomain: string, at: number): Promise<void>;
  /** Read for /api/unlock/approvals/pending (the daemon proxies this). */
  get(serverDomain: string): Promise<PendingUnlockApprovalRecord | undefined>;
  /** Called from handleDepositAutoUnlockLease on success. */
  delete(serverDomain: string): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────
// Auto-unlock leases
// ──────────────────────────────────────────────────────────────────────

/** Persisted shape mirrors the IRK-signed AutoUnlockLease envelope. */
export interface AutoUnlockLeaseRecord {
  serverDomain: string;
  leaseId: string;
  unlockKeyHex: string;
  multiUse: boolean;
  depositedAt: number;
  expiresAt: number;
}

export interface AutoUnlockLeaseStorage {
  /** Insert or replace a lease (keyed by serverDomain + leaseId). */
  put(rec: AutoUnlockLeaseRecord): Promise<void>;
  /**
   * Boot stage's /consume path. Returns the most-recently-deposited
   * non-expired lease for the server, deleting it iff it's one-shot
   * (multiUse=false). Multi-use leases are returned without delete
   * so subsequent boots reuse them until expiry. Expired rows are
   * cleaned up opportunistically when seen.
   */
  consume(serverDomain: string, now: number): Promise<AutoUnlockLeaseRecord | undefined>;
  /** Per-device kill switch. Returns true iff a row was actually deleted. */
  revoke(serverDomain: string, leaseId: string): Promise<boolean>;
  /** Snapshot of active (non-expired) leases for a server (UI listing). */
  list(serverDomain: string, now: number): Promise<AutoUnlockLeaseRecord[]>;
}

export interface Storage {
  usernames: UsernameStorage;
  usernameAliases: UsernameAliasStorage;
  authCodes: AuthCodeStorage;
  buildTickets: BuildTicketStorage;
  servers: ServerStorage;
  routing: RoutingStorage;
  installEvents: InstallEventStorage;
  luksKeys: LuksKeyStorage;
  autoUnlockLeases: AutoUnlockLeaseStorage;
  pendingUnlockApprovals: PendingUnlockApprovalStorage;
  pendingRePairs: PendingRePairStorage;
  webauthnRecovery: WebauthnRecoveryStorage;
  marketplace: MarketplaceStorage;
  pushTokens: PushTokenStorage;
  llmPromo: LlmPromoStorage;
  tiers: TierStorage;
  entitlementRevocations: EntitlementRevocationStorage;
  userIdentity: UserIdentityRecordStorage;
  daemonStatus: DaemonStatusStorage;
}

// ──────────────────────────────────────────────────────────────────────
// Daemon status reports (#21 — pod inventory cert reconciliation)
// ──────────────────────────────────────────────────────────────────────

/**
 * Most-recent cert + apps snapshot reported by a user's daemon. Written
 * by the daemon's HELLO bridge (POST /api/daemon-status, signed by the
 * server identity key registered in the `servers` table) and read by
 * the pod-inventory handler for the user's phone/webapp to reconcile
 * "what does my daemon say it's serving" against "what does .com have
 * routed there".
 */
export interface DaemonStatusRecord {
  serverDomain: string;
  /** Hex SHA-256 of the daemon's current TLS leaf cert (DER). */
  certSha256?: string;
  /** Unix ms — leaf cert's NotAfter. */
  certValidUntil?: number;
  /** Issuer DN string (e.g. "Let's Encrypt R3"). */
  certIssuer?: string;
  /** JSON array of `appName@authorStableId` strings — what's actively served. */
  appsServedJson?: string;
  lastReported: number;
}

export interface DaemonStatusStorage {
  put(rec: DaemonStatusRecord): Promise<void>;
  get(serverDomain: string): Promise<DaemonStatusRecord | undefined>;
  /** Bulk read for the pod-inventory handler — one round-trip per user. */
  getMany(serverDomains: string[]): Promise<Map<string, DaemonStatusRecord>>;
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
  /**
   * Update scan_grade + scan_report_key + scan_completed_at on an
   * existing listing. Called by the scanner service after it
   * pulls the listing's docker image and runs Trivy + custom checks.
   * Returns false if the listing doesn't exist.
   */
  setScanResult(
    creator: string,
    slug: string,
    grade: "A" | "B" | "C" | "D" | "F",
    reportKey: string,
    completedAt: number,
  ): Promise<boolean>;
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

// ──────────────────────────────────────────────────────────────────────
// User-identity mandate store (#71)
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-user identity state held by `.com` as an opaque encrypted blob.
 *
 * `.com` is allowed to see:
 *   - `usernameHash`         — keyed lookup label (sha256 of a salted
 *                              username). No way back to the username
 *                              without a brute-force over the username
 *                              namespace.
 *   - `authorizedSigners`    — the user's own published Ed25519 pubkey
 *                              list. Plaintext because the Worker has
 *                              to verify the PUT signature against it.
 *   - `blobVersion`          — monotonic counter; rolls forward only.
 *   - `signatureHex`         — Ed25519 signature over the canonical
 *                              bytes the user signed (`encryptedBlob |
 *                              blobVersion`). Retained so any replica
 *                              can re-verify.
 *
 * `.com` never sees the plaintext: only the user's UMK-derived key
 * (`maintainers/protocol`'s `EncryptedBlobAdapter`) can unseal it. See
 * docs/policy/no-kyc.md.
 */
export interface UserIdentityRecord {
  usernameHash: string;
  encryptedBlob: Uint8Array;
  authorizedSigners: string[];
  blobVersion: number;
  signatureHex: string;
  updatedAt: number;
}

export interface UserIdentityRecordStorage {
  /**
   * Replace the row iff `blobVersion` is strictly greater than the
   * stored version. Returns the post-state record (either the freshly
   * stored one or the unchanged existing one) so the caller can branch
   * on `accepted` without re-fetching.
   */
  putIfNewer(
    rec: UserIdentityRecord,
  ): Promise<{ stored: UserIdentityRecord; accepted: boolean }>;
  get(usernameHash: string): Promise<UserIdentityRecord | undefined>;
}

