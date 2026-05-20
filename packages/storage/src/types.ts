/**
 * Pure interfaces for the .com control-plane stores. Two implementations:
 *   - InMemory (this package), used by tests and for dev runs.
 *   - D1 (this package), used in production by the Cloudflare Worker.
 *
 * The shapes mirror the in-memory record types previously defined in the
 * apps/web routes; they're hoisted here so both runtimes can share them
 * without depending on Fastify, Workers, or any HTTP framework.
 */

/**
 * v1.2 security cascade — account-type discriminator. See
 * docs/v1.2-security-cascade.md. The `demo` value is included for
 * downstream-code completeness; Plan A's demo_users rows live in
 * their OWN table (`demo_users`) and never get `accountType='demo'`
 * stored on `usernames` in practice. The union exists so audit-log
 * + push-fanout code can match all three account modes exhaustively
 * without forgetting demo.
 */
export type AccountType = "single" | "multi" | "demo";

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
  /**
   * v1.2 — account-type discriminator. Defaults to 'single' for
   * every pre-migration row via the column DEFAULT; opting into
   * 'multi' requires TOTP enrollment (Phase 3). Stored as TEXT in
   * D1; the storage adapter narrows it to AccountType on read.
   * Absent on records returned from pre-migration writes — readers
   * should treat undefined as 'single'.
   */
  accountType?: AccountType;
  /**
   * v1.2 — TOTP secret encrypted with a Worker-side KEK
   * (FLAGSHIP_TOTP_KEK; Phase 3 secret). Null until enrollment.
   * Bytes are opaque to this layer.
   */
  totpSecretEncrypted?: string;
  /**
   * v1.2 — JSON array of argon2id-hashed recovery codes. Each code
   * is single-use; the array is rewritten atomically on consume so
   * a consumed code can't be reused. Null until enrollment; rotated
   * on a fresh enroll-confirm.
   */
  recoveryCodesHashesJson?: string;
  /** v1.2 — wall-clock ms of the successful enroll-confirm. Null until enrolled. */
  totpEnrolledAt?: number;
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
  | "app-renamed"            // V2 — voi.ci-aware Replace stem
  // Plan A — demo-user lifecycle (docs/sample-users.md §13). Stored
  // under the demo username so the regular /api/users/:u/audit feed
  // surfaces them; never emitted for non-demo accounts.
  | "demo-user-created"
  | "demo-user-deleted"
  | "demo-vps-provisioned"
  | "demo-vps-destroyed"
  | "demo-vps-idle-reaped"
  | "demo-connect-attempt-rate-limited"
  | "demo-vps-stuck";

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
  /**
   * v1.2 — grace duration captured EXPLICITLY on the row in seconds.
   * Phase 2 sets this to 7 days (604_800) for single-device accounts
   * and 24h (86_400) for multi-device. Stored on the row (rather
   * than recomputed from account_type at completion time) so a row
   * that crossed the migration boundary keeps its original grace
   * even if the account's type changes mid-flow. Defaults to 86_400
   * on legacy rows.
   */
  graceSeconds?: number;
  /**
   * v1.2 — true iff the account was multi-device at initiation time,
   * meaning the RePairInitiate must include a valid TOTP or
   * recovery-code proof. Phase 2 rejects re-pair attempts that lack
   * the proof; this flag preserves the requirement on the row for
   * the eventual /complete step.
   */
  totpRequired?: boolean;
  /**
   * v1.2 — true once the TOTP/recovery proof has been verified for
   * this pending row. Belt-and-braces guard so /complete can refuse
   * to swap an unverified row even if the require-flag was set.
   */
  totpProofConsumed?: boolean;
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
  servicesServedJson: string;
  lastReported: number;
}

export interface DaemonStatusStorage {
  put(rec: DaemonStatusRecord): Promise<void>;
  get(serverDomain: string): Promise<DaemonStatusRecord | undefined>;
  listForUser(username: string, serverFilter?: (sd: string) => boolean): Promise<DaemonStatusRecord[]>;
}

// ──────────────────────────────────────────────────────────────────────
// Service URL aliases (voi.ci-aware rename — migration 0019)
// ──────────────────────────────────────────────────────────────────────

/** Per (username, serviceId) override of the URL stem the service
 *  surfaces at. Absent row → fall back to the slug-creator derived
 *  default. The internal `serviceId` stays stable across renames;
 *  only the user-visible `displayLabel` changes. */
export interface UserServiceAliasRecord {
  username: string;
  serviceId: string;
  /** DNS-safe label. Validated by the handler before write. */
  displayLabel: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserServiceAliasStorage {
  /** Insert or update — atomic. */
  upsert(rec: UserServiceAliasRecord): Promise<void>;
  get(username: string, serviceId: string): Promise<UserServiceAliasRecord | undefined>;
  /** Every alias for the user — drives the services-list BFF join. */
  listForUser(username: string): Promise<UserServiceAliasRecord[]>;
  /** Delete by composite key. Returns whether a row existed. */
  delete(username: string, serviceId: string): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────
// voi.ci short-link table (migration 0019)
// ──────────────────────────────────────────────────────────────────────

export interface VoiciLinkRecord {
  code: string;
  username: string;
  /** Optional — when present, deleting the service's links cascades here. */
  serviceId?: string;
  targetUrl: string;
  createdAt: number;
  /** Optional soft TTL. NULL on service-bound links; set on one-offs. */
  expiresAt?: number;
}

export interface VoiciLinkStorage {
  /** Mint a fresh row. Collision on `code` returns ok=false so the
   *  caller can pick another short code. */
  insert(rec: VoiciLinkRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Redirect-path lookup. */
  get(code: string): Promise<VoiciLinkRecord | undefined>;
  /** Look up the active service-bound short link for a (user, service)
   *  pair. At most ONE row should match — handleServiceRename
   *  cascade-deletes prior rows before minting the new one. Returns the
   *  most-recently created row when more than one is present
   *  (defensive); undefined if no service-bound short link has been
   *  minted. */
  getByService(username: string, serviceId: string): Promise<VoiciLinkRecord | undefined>;
  /** Cascade-delete on service rename / uninstall. Returns count deleted. */
  deleteByService(username: string, serviceId: string): Promise<number>;
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
  userServiceAliases: UserServiceAliasStorage;
  voiciLinks: VoiciLinkStorage;
  customDomainOrders: CustomDomainOrderStorage;
  demoLlmLedger: DemoLlmLedgerStorage;
  installPolicyFanout: InstallPolicyFanoutStorage;
  demoUsers: DemoUsersStorage;
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
  /**
   * Listings that need a (re)scan (#14 auto-trigger): status='listed'
   * AND (never scanned OR scanCompletedAt < `staleBeforeMs`). Powers
   * the authed scan-queue endpoint the nightly CI runner drains so a
   * listing never ships scan_grade=NULL indefinitely.
   */
  listNeedingScan(staleBeforeMs: number): Promise<MarketplaceListingRecord[]>;
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
  /**
   * v1.2 — 14-day quarantine on the revoke-others power for a newly-
   * admitted device. Wall-clock ms; 0 means already-trusted. The
   * plan doc names this `paired_sessions.quarantine_until` but on
   * the .com side the per-device record IS push_tokens — see the
   * 0028 migration. Phase 2 wires the enforcement on
   * /api/users/:u/devices/:id/disconnect + /api/re-pair (revoke-
   * others endpoints reject when the calling token's
   * quarantine_until > now).
   */
  quarantineUntil?: number;
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
// Demo-account rolling LLM token ledger (#85)
// ──────────────────────────────────────────────────────────────────────

/**
 * Append-only grant log used to enforce a strict rolling-window token
 * ceiling for `is_demo` users (#85). One row per LLM-promo issue; the
 * Worker pessimistically logs the full per-issue grant (it never proxies
 * traffic, mirroring the llm_promo_usage philosophy). A genuine rolling
 * window (not a calendar day) so a demo account can't burst-reset at
 * midnight. Old rows are pruned on append so the table stays tiny.
 */
export interface DemoLlmLedgerRecord {
  username: string;
  grantedAt: number; // ms epoch
  tokens: number;
}

export interface DemoLlmLedgerStorage {
  /**
   * Record a grant of `tokens` at `grantedAt`, then drop this user's
   * entries strictly older than `pruneBefore` in the same write so the
   * ledger self-trims to the active window.
   */
  append(username: string, grantedAt: number, tokens: number, pruneBefore: number): Promise<void>;
  /** Sum of tokens granted to `username` at or after `sinceMs`. */
  sumSince(username: string, sinceMs: number): Promise<number>;
}

/**
 * One row per newly-registered server (N0d-2). The phone owns the
 * install *policy*; .com only records that, on a new registration, it
 * fanned a category-only push out to the user's device family so they
 * reconcile their server list. Keyed by server_domain because server
 * registration is one-shot (the auth-code is single-use) — the record
 * doubles as a fan-out idempotency guard and as operational
 * visibility (how many devices, when).
 */
export interface InstallPolicyFanoutRecord {
  serverDomain: string;
  username: string;
  registeredAt: number;
  /** number of the user's push tokens the notification fanned out to. */
  fanoutCount: number;
  notifiedAt: number;
}

export interface InstallPolicyFanoutStorage {
  /**
   * Insert the fan-out record iff none exists for `serverDomain`.
   * Returns true if it was inserted (first time — the caller should
   * notify), false if a record already existed (a retry — do NOT
   * re-notify the device family).
   */
  recordOnce(rec: InstallPolicyFanoutRecord): Promise<boolean>;
  get(serverDomain: string): Promise<InstallPolicyFanoutRecord | undefined>;
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
// One row per (serviceId, userId): a new attach request DESTRUCTIVELY
// replaces any prior (decided design — irreversible; doubles as the
// only "forget a custom domain" affordance). `lastChanged` drives the
// 300s server-side rate limit (the client mirrors a UX cooldown but
// the server is the backstop). `status` is `pending` until the
// out-of-band CNAME verifier (Phase 4) flips it to `active`/`failed`.

export interface CustomDomainOrderRecord {
  serviceId: string;
  /** username, lowercased. */
  userId: string;
  fqdn: string;
  status: "pending" | "active" | "failed";
  /**
   * The pod canonical that serves this fqdn, set by the Phase-4
   * verifier when it confirms the CNAME (status→active). Undefined
   * until then. `.services` cold-start (#87) reads fqdn→podCanonical
   * from the active rows that have it.
   */
  podCanonical?: string;
  /** ms — when the order was last (re)requested; the rate-limit clock. */
  lastChanged: number;
  failCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CustomDomainOrderStorage {
  get(userId: string, serviceId: string): Promise<CustomDomainOrderRecord | undefined>;
  /** Destructive upsert: replaces any prior row for (serviceId,userId)
   *  wholesale and returns the stored row. */
  upsert(rec: CustomDomainOrderRecord): Promise<CustomDomainOrderRecord>;
  /** Phase-4 verifier transition (pending→active|failed). Bumps
   *  failCount when status='failed'. Returns false if no row /
   *  the fqdn no longer matches (a newer request superseded it). */
  setStatus(
    userId: string,
    serviceId: string,
    fqdn: string,
    status: CustomDomainOrderRecord["status"],
    at: number,
  ): Promise<boolean>;
  /** Phase-4 #82 re-verify sweep — every active order. */
  listActive(): Promise<CustomDomainOrderRecord[]>;
  /** Phase-4 verifier — every order in a given status (pending to
   *  verify, active to re-verify). */
  listByStatus(
    status: CustomDomainOrderRecord["status"],
  ): Promise<CustomDomainOrderRecord[]>;
}

// ──────────────────────────────────────────────────────────────────────
// Demo users (Plan A — sample-user / on-connect Hetzner provisioning)
// ──────────────────────────────────────────────────────────────────────

/** Server lifecycle state — see docs/sample-users.md §4. */
export type DemoUserState =
  | "none"
  | "provisioning"
  | "up"
  | "idle-pending-teardown";

export interface DemoUserRecord {
  /** Lowercased; PRIMARY KEY in D1. */
  username: string;
  /** Human-readable label used by /api/users/check + the demo UI. */
  display: string;
  /** Hetzner snapshot id, populated by /install-complete; NULL until then. */
  snapshotId: string | null;
  /** R2 object key under flagship-iso-temp; cleared on delete. */
  isoR2Key: string | null;
  ttlIdleMinutes: number;
  region: string;
  size: string;
  /** Hetzner server id while state ∈ (provisioning, up, idle-pending-teardown). */
  activeServerId: string | null;
  /** FQDN we publish for the running demo, e.g. home.demoalice.flagship.services. */
  activeServerFqdn: string | null;
  /** Wall-clock ms of the last /connect or /heartbeat. */
  lastActivityAt: number;
  state: DemoUserState;
  createdAt: number;
}

export interface DemoUsersStorage {
  /** Insert a fresh row. Returns `ok:false` on PK collision so the caller
   *  can decide whether to surface "already exists" or treat it as
   *  idempotent. */
  insert(rec: DemoUserRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(username: string): Promise<DemoUserRecord | undefined>;
  list(): Promise<DemoUserRecord[]>;
  /** Update an existing row's fields. No-op on missing username. */
  update(username: string, patch: Partial<DemoUserRecord>): Promise<void>;
  delete(username: string): Promise<void>;
  /** Atomic CAS — only transitions when current state matches `from`.
   *  Returns the updated row, or null if `from` no longer matches. */
  transition(
    username: string,
    from: DemoUserState,
    to: DemoUserState,
    patch?: Partial<DemoUserRecord>,
  ): Promise<DemoUserRecord | null>;
  /** Idle-reaper query. Returns rows in (up, provisioning,
   *  idle-pending-teardown) whose `lastActivityAt < cutoffMs`. Capped
   *  at 50 rows so a single cron tick is bounded. */
  findIdle(cutoffMs: number): Promise<DemoUserRecord[]>;
  /** Count rows whose state is in (provisioning, up, idle-pending-teardown)
   *  — drives the MAX_CONCURRENT_DEMO_VPS soft cap. */
  countActive(): Promise<number>;
}
