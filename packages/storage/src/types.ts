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
  /**
   * Demo account (task #84). A real claim with real keys, but login
   * returns a platform-signed directive telling the client to route
   * the *recovery* ceremony through the Mock (Apple Review can't
   * exercise a real WebAuthn-PRF passkey). Everything else stays
   * live. Absent / false = a normal account. Set only by the
   * operator-gated provisionDemoUser path, never by the claim flow.
   */
  isDemo?: boolean;
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

export interface UsernameAliasRecord {
  oldUsername: string;
  newUsername: string;
  effectiveAt: number;
  signatureHex: string;
}

export interface UsernameAliasStorage {
  /** Insert a permanent alias mapping old → new. Idempotent on
   *  identical inserts; rejects if oldUsername already aliases to
   *  someone different. */
  put(rec: UsernameAliasRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Resolve an alias chain: returns the current name + the path
   *  walked. Caps at 8 hops to defeat any pathological loops. */
  resolve(username: string): Promise<{ current: string; chain: string[] }>;
  /** Has this name ever been used (current or historical alias)?
   *  Used by the rename handler to refuse re-issuance of consumed names. */
  isConsumed(username: string): Promise<boolean>;
}

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
  /**
   * Flip the demo flag on an existing claim (task #84). Returns false
   * if the username doesn't exist. The claim flow never calls this;
   * only the operator-gated provision/decommission tooling does. The
   * `put` path must preserve an already-set flag (a benign re-claim
   * must not silently un-demo an account).
   */
  setDemo(username: string, isDemo: boolean): Promise<boolean>;
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

// ──────────────────────────────────────────────────────────────────────
// Audit events (account-level: disconnect, replace, wipe, etc.)
// ──────────────────────────────────────────────────────────────────────

/** Controlled vocabulary surfaced verbatim to the client UI. */
export type AuditEventKind =
  | "device-disconnected"
  | "device-replaced"        // IRK rotation (Replace device)
  | "device-added"           // new push-token registered
  | "wipe-restart"           // v1.1 — full UMK + passkey rotation
  | "recovery-set-up"
  | "recovery-rotated"
  | "app-renamed";           // V2 — voi.ci-aware Replace stem

export interface AuditEventRecord {
  seq: number;
  username: string;
  eventKind: AuditEventKind;
  /** Short free-form description rendered next to the icon. */
  detail: string;
  /** Token-prefix of the device involved (empty when not device-scoped). */
  devicePrefix: string;
  postedAt: number;
}

export interface AuditEventStorage {
  /** Insert one audit event. `seq` is assigned by the storage layer
   *  and returned so callers can surface it to the user immediately. */
  append(rec: Omit<AuditEventRecord, "seq">): Promise<AuditEventRecord>;
  /** List the last N events for a user, descending by seq. `sinceSeq`
   *  is exclusive lower bound; pass 0 to read from the start. */
  list(username: string, sinceSeq: number, limit: number): Promise<AuditEventRecord[]>;
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

export interface DaemonStatusRecord {
  serverDomain: string;
  certSha256: string | null;
  certValidUntil: number | null;
  certIssuer: string | null;
  /** JSON-encoded list of canonical FQDNs the daemon currently serves. */
  appsServedJson: string;
  lastReported: number;
}

export interface DaemonStatusStorage {
  put(rec: DaemonStatusRecord): Promise<void>;
  get(serverDomain: string): Promise<DaemonStatusRecord | undefined>;
  listForUser(username: string, serverFilter?: (sd: string) => boolean): Promise<DaemonStatusRecord[]>;
}

// ──────────────────────────────────────────────────────────────────────
// App URL aliases (voi.ci-aware rename — migration 0019)
// ──────────────────────────────────────────────────────────────────────

/** Per (username, appId) override of the URL stem the app surfaces
 *  at. Absent row → fall back to the slug-creator derived default.
 *  The internal `appId` stays stable across renames; only the
 *  user-visible `displayLabel` changes. */
export interface UserAppAliasRecord {
  username: string;
  appId: string;
  /** DNS-safe label. Validated by the handler before write. */
  displayLabel: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserAppAliasStorage {
  /** Insert or update — atomic. */
  upsert(rec: UserAppAliasRecord): Promise<void>;
  get(username: string, appId: string): Promise<UserAppAliasRecord | undefined>;
  /** Every alias for the user — drives the apps-list BFF join. */
  listForUser(username: string): Promise<UserAppAliasRecord[]>;
  /** Delete by composite key. Returns whether a row existed. */
  delete(username: string, appId: string): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────
// voi.ci short-link table (migration 0019)
// ──────────────────────────────────────────────────────────────────────

export interface VoiciLinkRecord {
  code: string;
  username: string;
  /** Optional — when present, deleting the app's links cascades here. */
  appId?: string;
  targetUrl: string;
  createdAt: number;
  /** Optional soft TTL. NULL on app-bound links; set on one-offs. */
  expiresAt?: number;
}

export interface VoiciLinkStorage {
  /** Mint a fresh row. Collision on `code` returns ok=false so the
   *  caller can pick another short code. */
  insert(rec: VoiciLinkRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Redirect-path lookup. */
  get(code: string): Promise<VoiciLinkRecord | undefined>;
  /** Look up the active app-bound short link for a (user, app) pair.
   *  At most ONE row should match — handleAppRename cascade-deletes
   *  prior rows before minting the new one. Returns the most-recently
   *  created row when more than one is present (defensive); undefined
   *  if no app-bound short link has been minted. */
  getByApp(username: string, appId: string): Promise<VoiciLinkRecord | undefined>;
  /** Cascade-delete on app rename / uninstall. Returns count deleted. */
  deleteByApp(username: string, appId: string): Promise<number>;
  /** Periodic GC for expired one-offs. */
  deleteExpired(before: number): Promise<number>;
}

export interface Storage {
  usernames: UsernameStorage;
  usernameAliases: UsernameAliasStorage;
  daemonStatus: DaemonStatusStorage;
  authCodes: AuthCodeStorage;
  buildTickets: BuildTicketStorage;
  servers: ServerStorage;
  routing: RoutingStorage;
  installEvents: InstallEventStorage;
  auditEvents: AuditEventStorage;
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
  userAppAliases: UserAppAliasStorage;
  voiciLinks: VoiciLinkStorage;
  customDomainOrders: CustomDomainOrderStorage;
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
  /**
   * User-facing device name from the registration envelope. Surfaced
   * verbatim in the "Trusted devices" list — the Worker sanitizes
   * length + control chars at the registration handler boundary.
   */
  label: string;
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


// ──────────────────────────────────────────────────────────────────────
// Custom (external) domain orders (#79A).
//
// One row per (appId, userId): a new attach request DESTRUCTIVELY
// replaces any prior (decided design — irreversible; doubles as the
// only "forget a custom domain" affordance). `lastChanged` drives the
// 300s server-side rate limit (the client mirrors a UX cooldown but
// the server is the backstop). `status` is `pending` until the
// out-of-band CNAME verifier (Phase 4) flips it to `active`/`failed`.

export interface CustomDomainOrderRecord {
  appId: string;
  /** username, lowercased. */
  userId: string;
  fqdn: string;
  status: "pending" | "active" | "failed";
  /** ms — when the order was last (re)requested; the rate-limit clock. */
  lastChanged: number;
  failCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CustomDomainOrderStorage {
  get(userId: string, appId: string): Promise<CustomDomainOrderRecord | undefined>;
  /** Destructive upsert: replaces any prior row for (appId,userId)
   *  wholesale and returns the stored row. */
  upsert(rec: CustomDomainOrderRecord): Promise<CustomDomainOrderRecord>;
  /** Phase-4 verifier transition (pending→active|failed). Bumps
   *  failCount when status='failed'. Returns false if no row /
   *  the fqdn no longer matches (a newer request superseded it). */
  setStatus(
    userId: string,
    appId: string,
    fqdn: string,
    status: CustomDomainOrderRecord["status"],
    at: number,
  ): Promise<boolean>;
  /** Phase-4 #82 re-verify sweep — every active order. */
  listActive(): Promise<CustomDomainOrderRecord[]>;
}
