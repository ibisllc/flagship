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

/**
 * v2.1 — per-cloud recovery-wipe policy. Selected at cloud creation
 * (default `'graceful'`); honored by the re-pair completion handler:
 *
 *   - `'strict'`   — every existing DeviceCapabilityGrant for the
 *                    username is revoked at swap time. The new admin
 *                    must re-mint grants for every device that needs
 *                    continued access. Corporate default — the forced
 *                    re-onboarding is the point.
 *   - `'graceful'` — the /complete RPC body carries `refreshedGrants`
 *                    signed by the NEW IRK; the handler validates each
 *                    under the new IRK pub, confirms each `devicePubKey`
 *                    matches an existing active grant (scopes MUST be
 *                    a subset — no inflation), and atomically swaps the
 *                    old grants for the new. Family default — non-admin
 *                    devices keep working without re-onboarding.
 *
 * See docs/v1.2-security-cascade.md §"Recovery wipe policy".
 */
export type RecoveryWipePolicy = "strict" | "graceful";

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
  /**
   * v2.1 — per-cloud recovery-wipe policy. Defaults to `'graceful'`
   * at the handler boundary so pre-migration rows behave gracefully.
   * Stored as TEXT in D1; the storage adapter narrows it to
   * RecoveryWipePolicy on read.
   */
  recoveryWipePolicy?: RecoveryWipePolicy;
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
  /**
   * v1.2 Phase 3 — stage a TOTP secret during enroll-begin. Writes
   * `totp_secret_encrypted` only; the row stays single-device until
   * `finalizeTotpEnrollment` lands. Returns false on unknown username.
   * Repeated calls overwrite (a user mid-enrollment can restart).
   */
  setTotpSecretEncrypted(
    username: string,
    encrypted: string,
  ): Promise<boolean>;
  /**
   * v1.2 Phase 3 — atomic finalize on enroll-confirm. Sets
   * `totp_enrolled_at = at`, flips `account_type = 'multi'`, and
   * writes the freshly-generated recovery-code-hashes JSON. All
   * three fields update in ONE write so a partial-failure mid-call
   * can't leave the row in a half-enrolled state. Returns false on
   * unknown username.
   */
  finalizeTotpEnrollment(
    username: string,
    at: number,
    recoveryCodesHashesJson: string,
  ): Promise<boolean>;
  /**
   * v1.2 Phase 3 — disable: drops `totp_secret_encrypted`,
   * `recovery_codes_hashes_json`, `totp_enrolled_at`, and flips
   * `account_type` back to `'single'`. ONE write. Returns false on
   * unknown username.
   */
  clearTotp(username: string): Promise<boolean>;
  /**
   * v1.2 Phase 3 — atomic compare-and-set on
   * `recovery_codes_hashes_json` for single-use recovery-code
   * consumption. Updates the column iff its current value equals
   * `expectedJson` (string equality). Returns true on success; false
   * when the row doesn't exist OR another concurrent consumer
   * already swapped the column. The handler that lost the race
   * MUST treat its candidate code as already-consumed and reject
   * the re-pair / verify call.
   */
  casRecoveryCodes(
    username: string,
    expectedJson: string,
    newJson: string,
  ): Promise<boolean>;
}

export interface AuthCodeStorage {
  put(rec: AuthCodeRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(serial: string): Promise<AuthCodeRecord | undefined>;
  /** Atomic active+now<=expiresAt → used. Returns the post-state. */
  markUsed(serial: string, now: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  markRevoked(serial: string, now: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Every still-`active` auth-code that reserves `serverDomain`. Used by
   * the "cancel the server / free the name" release path to revoke each
   * outstanding ticket pinning a name (a name can accumulate >1 active
   * code across retries, since auth-codes are keyed by serial, not
   * domain). Returns an empty array when none are active.
   */
  listActiveByServerDomain(serverDomain: string): Promise<AuthCodeRecord[]>;
  /**
   * Every OUTSTANDING auth-code for a username — `status='active'` AND not
   * yet expired (`expiresAt > now`). These are the user's in-flight install
   * orders: a recipe was minted but the box hasn't registered (which would
   * mark the code `used`) and the user hasn't cancelled it (`revoked`).
   *
   * Drives `POST /api/users/:u/outstanding-orders`, the authority the phone
   * reconciles its local pending-server cache against: an order present here
   * is a real in-flight install (surface it); one absent from BOTH this list
   * and the registered `/pods` inventory is a ghost (drop it).
   */
  listOutstandingByUsername(username: string, now: number): Promise<AuthCodeRecord[]>;
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
// Provisioning-status channel (per-order install progress — migration 0038)
//
// Keyed by the auth-code SERIAL (the order id). The phone knows it from
// the order it created; the installer has it in the recipe. The box POSTs
// named PHASE checkpoints; the phone polls the latest phase + the
// append-only history so it can render a live install timeline. Distinct
// from `install_events` (a generic seq'd event log) and from
// `demo_users.provision_phase` (the demo-row latest-phase mirror): this is
// the canonical per-order channel for the real install path.
// ──────────────────────────────────────────────────────────────────────

/** One entry in a provision-status row's append-only history. */
export interface ProvisionStatusHistoryEntry {
  phase: string;
  detail?: string;
  ts: number;
}

export interface ProvisionStatusRecord {
  serial: string;
  serverDomain?: string;
  /** The latest reported phase. */
  phase: string;
  /** Free-form latest detail (error text, percentage, etc.). */
  detail?: string;
  /** Wall-clock ms of the latest report. */
  updatedAt: number;
  /** Append-only history of every phase report, oldest first. */
  history: ProvisionStatusHistoryEntry[];
}

export interface ProvisionStatusStorage {
  /**
   * Upsert the row keyed by `serial`: set the latest phase/detail/
   * updated_at AND append `{phase, detail, ts}` to the history. A first
   * report for an unseen serial inserts the row with a one-element
   * history; subsequent reports update the latest fields and grow the
   * history.
   */
  putProvisionStatus(
    serial: string,
    entry: { serverDomain?: string; phase: string; detail?: string; ts: number },
  ): Promise<void>;
  /** Read the full record (latest fields + history), or null when absent. */
  getProvisionStatus(serial: string): Promise<ProvisionStatusRecord | null>;
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
  | "demo-user-cancelled"
  | "demo-vps-provisioned"
  | "demo-vps-destroyed"
  | "demo-vps-idle-reaped"
  | "demo-connect-attempt-rate-limited"
  | "demo-vps-stuck"
  // Plan B Phase 5 — v1.2 security cascade audit kinds. The first
  // four track the multi-device toggle; recovery-code-consumed
  // logs single-use recovery-code spend; quarantine-blocked-revoke
  // flags a freshly-admitted-quarantined device trying to kick
  // siblings; totp-failed-rate marks the >5-in-15min failure burst
  // that also fires a push to all the user's trusted devices.
  | "totp-enrolled"
  | "totp-disabled"
  | "account-type-changed-single-to-multi"
  | "account-type-changed-multi-to-single"
  | "recovery-code-consumed"
  | "quarantine-blocked-revoke"
  | "totp-failed-rate"
  // P13 — IRK-signed user-initiated server revocation
  // (POST /api/server-registry/revoke). Reason ∈ {lost, stolen,
  // decommissioned}. Cascades through every active boot-unlock lease
  // on the server so the box bricks on the next reboot.
  | "server-revoked";

/**
 * Plan B Phase 5 — recovery-method tag stored next to a re-pair
 * audit row so the Activity feed can render "Recovered via TOTP" /
 * "Recovered via recovery code" / "Recovered without 2FA". Mirrors
 * the `RePairInitiate.totpProof.method` discriminator.
 */
export type AuditRecoveryMethod = "totp" | "recovery-code" | "none";

export interface AuditEventRecord {
  seq: number;
  username: string;
  eventKind: AuditEventKind;
  /** Short free-form description rendered next to the icon. */
  detail: string;
  /** Token-prefix of the device involved (empty when not device-scoped). */
  devicePrefix: string;
  postedAt: number;
  /**
   * Plan B Phase 5 — snapshot of `usernames.account_type` AT THE
   * TIME the event was recorded. Stored on the row because the
   * type can change later (totp-disabled flips `multi` → `single`
   * but the row must remember the user was multi-device when the
   * disable fired). Absent on pre-v1.2 rows.
   */
  accountTypeAtEvent?: AccountType;
  /**
   * Plan B Phase 5 — set when the row reflects a device admission
   * event that landed under a quarantine window (most commonly the
   * `device-added` row that lands during a re-pair completion).
   * Wall-clock ms; absent / undefined otherwise.
   */
  quarantineUntil?: number;
  /**
   * Plan B Phase 5 — set on re-pair completion / recovery-code
   * consumption rows so the UI can render the method used.
   */
  recoveryMethod?: AuditRecoveryMethod;
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
  /**
   * Release the routing record for `subdomain` so the leftmost `<server>`
   * label is free to be claimed again (a fresh RCK can `register()` it).
   * This is what actually un-loses a name after a failed install — the
   * RCK record is the thing `register()` refuses to overwrite with a
   * different key. Idempotent: deleting an absent record is success
   * (`{ ok: true }`). Returns `{ ok: true }` when the record was removed
   * or already gone.
   */
  release(subdomain: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface SealedLuksKeyRecord {
  serverDomain: string;
  sealedKeyHex: string;
  sealedAt: number;
}

export interface LuksKeyStorage {
  /** Server stores its sealed LUKS root key (sealed-with-BAK). Idempotent overwrite. */
  putSealed(rec: SealedLuksKeyRecord): Promise<void>;
  /** Public read of the sealed blob (useless without the phone). */
  getSealed(serverDomain: string): Promise<SealedLuksKeyRecord | undefined>;
  /**
   * Drop the sealed blob for a domain. Called on server release so a reused
   * name starts clean. Idempotent — deleting an absent row is a no-op. The
   * stale blob is harmless if left (it's sealed to the old box's STK and is
   * overwritten on reuse), but clearing it keeps the reservation tidy.
   */
  deleteSealed(serverDomain: string): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// Webapp cloud-shard recovery records (WebAuthn PRF)
// ──────────────────────────────────────────────────────────────────────

export interface WebauthnRecoveryRecord {
  username: string;
  credentialIdHex: string;
  /** Opaque AES-GCM ciphertext (base64). `.com` cannot decrypt — only the user's passkey can. */
  wrappedUmkB64: string;
  /**
   * Per-user-cert (#28): the ACME ACCOUNT key, escrowed as opaque ciphertext
   * (base64) wrapped to the SAME recovery credential as the UMK. The account
   * key is admin-held (not UMK-derived), so losing every admin device would
   * otherwise brick cert issuance forever — escrowing it here makes it
   * recoverable independently of any surviving device. `.com` only ever sees
   * ciphertext. Optional + backward-compatible: legacy rows / accounts
   * without a minted account key leave it unset.
   */
  wrappedAcmeAccountKeyB64?: string;
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
  /**
   * v1.2 Phase 2 — bitfield tracking which scheduled push alerts
   * have ALREADY fired for this pending row. See migration
   * 0029_re_pair_alerts.sql for the bit layout. The scheduler MUST
   * treat a power-of-2 increment as the only legal mutation
   * (OR-in a single bit); repeated fires of the same offset are
   * no-ops (the bit's already set). Absent / 0 = nothing fired yet.
   *
   *   bit 0 = T+0  (fired on initiate)
   *   bit 1 = T+1d
   *   bit 2 = T+3d
   *   bit 3 = T+6d
   *   bit 4 = T+7d (~1h before completesAt; single-device only)
   */
  alertsFiredBitmap?: number;
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
  /**
   * v1.2 Phase 2 — walk every non-objected pending row, capped at
   * `limit` (default 100). Used by the cron-driven alert scheduler
   * (`schedulePendingRePairAlerts`) so it can OR-in the next-due
   * bit on each row crossing a T+1d/T+3d/T+6d/T+7d threshold.
   * Returns rows in initiation-ascending order so the scheduler
   * processes the oldest pendings first.
   */
  listActive(limit?: number): Promise<PendingRePairRecord[]>;
  /**
   * v1.2 Phase 2 — OR a single new bit into `alerts_fired_bitmap`
   * for the given username. Returns the post-write bitmap so the
   * caller can confirm idempotency. No-op (returns the existing
   * value) if the bit was already set.
   */
  orInAlertsFiredBit(username: string, bit: number): Promise<number>;
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

// ──────────────────────────────────────────────────────────────────────
// Secret mailbox (phone-as-unlock-endpoint RELAY model)
//
// docs/security-phone-as-unlock-endpoint.md §4 + §9. A per-user blind
// store-and-forward mailbox: the box POSTs an STK-signed SecretRequest;
// `.com` parks the pending row (keyed by the request's 32-byte nonce),
// fires a push, and serves it back to the phone; the phone POSTs a
// SealedSecretResponse (or signed RootEntitlement) which `.com` stores
// against the nonce and releases ONCE to the polling box. `.com` only
// ever holds ciphertext (the sealed response) and public-signed blobs
// (the request) — invariant I1. The request's `stkPubHex` was verified
// against the directory's bound STK at the handler boundary, so the
// phone seals only for the user-confirmed box (I2/I3).
// ──────────────────────────────────────────────────────────────────────

export type SecretMailboxPurpose = "unlock-key" | "entitlement";

export interface SecretMailboxRecord {
  /** Box FQDN the request is for. */
  serverDomain: string;
  /** Account that owns the mailbox (the box's registered username). */
  username: string;
  /** 32-byte request nonce, hex — the row key. The phone binds its
   *  reply to this; the box re-derives the same nonce to fetch it. */
  requestNonceHex: string;
  /** Box STK pubkey, hex — the request was verified against this. */
  stkPubHex: string;
  purpose: SecretMailboxPurpose;
  /** issuedAt from the signed SecretRequest (ms). */
  requestIssuedAt: number;
  /** Box's STK signature over the canonical SecretRequest, hex. Stored
   *  so the phone can re-verify the request against the directory STK
   *  it independently looks up — `.com` is not the trust anchor. */
  requestSignatureHex: string;
  /**
   * Box-supplied display hint (ip/region/os) the app shows for the
   * "is this my box?" confirm. NOT signed and NOT the security
   * boundary — the user's visual confirm + the STK→directory binding
   * are. JSON object stringified; opaque to this layer. NULL when the
   * box sent none.
   */
  deviceInfoJson: string | null;
  /** When the box posted the request (ms). */
  postedAt: number;
  /** Row TTL — `.com` GCs / refuses to serve past this (ms). */
  expiresAt: number;
  /** Wall-clock ms of the last push fan-out for this row, or 0. */
  lastPushAt: number;
  /**
   * The phone's reply, sealed for `stkPubHex` (SealedSecretResponse.sealed)
   * OR — for the entitlement purpose — the phone-signed RootEntitlement
   * carrier JSON. Hex of the wire bytes. NULL until the phone replies.
   * NEVER plaintext (I1).
   */
  responseSealedHex: string | null;
  /** issuedAt from the phone's SealedSecretResponse (ms), or null. */
  responseIssuedAt: number | null;
  /** When the phone posted the reply (ms), or null. */
  respondedAt: number | null;
  /** Set when the box consumes the reply — single-use release. */
  consumedAt: number | null;
}

export interface SecretMailboxStorage {
  /**
   * Box posts a fresh request. Keyed by (serverDomain, requestNonceHex).
   * Returns `ok:false` with reason `'duplicate nonce'` when a row with
   * the same nonce already exists for the server (single-use nonce —
   * the box must mint a fresh nonce per request).
   */
  putRequest(rec: SecretMailboxRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Box-side fetch of one request by its nonce (for the response poll
   *  + freshness/expiry checks). */
  getRequest(serverDomain: string, requestNonceHex: string): Promise<SecretMailboxRecord | undefined>;
  /**
   * Phone-side mailbox listing: every pending (un-consumed, un-expired,
   * un-answered) request for the user's account. Sorted postedAt DESC.
   * Capped at `limit` (default 50).
   */
  listPendingForUser(username: string, now: number, limit?: number): Promise<SecretMailboxRecord[]>;
  /** Confirm a push fired for a row (writes lastPushAt). */
  touchLastPushAt(serverDomain: string, requestNonceHex: string, at: number): Promise<void>;
  /**
   * Extend a parked request's TTL. Called on every (re-)announce so a
   * heartbeat re-POST keeps a waiting box's row alive; when the box powers
   * off the heartbeats stop and the row lapses (the "box stopped" signal).
   * No-op when no matching row exists.
   */
  refreshExpiry(serverDomain: string, requestNonceHex: string, expiresAt: number): Promise<void>;
  /**
   * Phone stores its sealed reply against an existing request. Returns
   * `ok:false` with `'unknown request'` when no matching un-expired row
   * exists, or `'already answered'` when a reply is already on file
   * (replies are write-once — a second device can't overwrite). The
   * caller has already verified the phone owns the mailbox.
   */
  putResponse(
    serverDomain: string,
    requestNonceHex: string,
    responseSealedHex: string,
    responseIssuedAt: number,
    now: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Box polls for + atomically consumes the reply. Returns the row iff a
   * reply is present, un-expired, and not yet consumed; marks it consumed
   * (single-use release — I1/I3). Returns undefined when no reply is
   * ready yet OR it was already consumed. Expired rows are GC'd when seen.
   */
  consumeResponse(serverDomain: string, requestNonceHex: string, now: number): Promise<SecretMailboxRecord | undefined>;
}

// ──────────────────────────────────────────────────────────────────────
// Box-sealed auto-unlock leases (AutoUnlockLeaseV2 — relay model §7a)
//
// The unattended-reboot fallback under the rogue-operator invariants:
// the LUKS key is stored SEALED for the box's STK (never plaintext —
// I1), with the recipient `stkPub` PINNED by the user's IRK signature
// (I2). On reboot the box pulls the sealed blob + unseals it itself.
// `.com` holds ciphertext only and can withhold but never read/retarget
// (I3). Distinct from `AutoUnlockLeaseStorage` (the legacy PLAINTEXT
// path, kept as a deprecated fallback this wave).
// ──────────────────────────────────────────────────────────────────────

/** Persisted shape mirrors the IRK-signed AutoUnlockLeaseV2 envelope. */
export interface BoxSealedLeaseRecord {
  serverDomain: string;
  leaseId: string;
  /** The PINNED seal recipient — box STK pubkey, hex. */
  stkPubHex: string;
  /** The LUKS key sealed for `stkPubHex`, hex. NEVER plaintext (I1). */
  sealedKeyHex: string;
  /** issuedAt from the signed lease (ms). */
  issuedAt: number;
  expiresAt: number;
  /** Optional release cap; null ⇒ unbounded until expiresAt. */
  maxUses: number | null;
  /** Releases so far — incremented on each box consume. */
  usesConsumed: number;
  /** The IRK signature over the canonical AutoUnlockLeaseV2, hex.
   *  Released to the box so it can re-verify the lease against the
   *  user IRK independently of `.com`. */
  signatureHex: string;
  depositedAt: number;
}

export interface BoxSealedLeaseStorage {
  /** Insert or replace a lease (keyed by serverDomain + leaseId). */
  put(rec: BoxSealedLeaseRecord): Promise<void>;
  /**
   * Box reboot path: return the freshest non-expired, non-exhausted
   * lease for the server and increment its `usesConsumed`. Deletes the
   * row when the increment reaches `maxUses` (one-shot leases with
   * maxUses=1 are gone after the first release). The returned record
   * carries only the SEALED key (I1). Expired rows GC'd when seen.
   */
  release(serverDomain: string, now: number): Promise<BoxSealedLeaseRecord | undefined>;
  /** Per-device kill switch. Returns true iff a row was actually deleted. */
  revoke(serverDomain: string, leaseId: string): Promise<boolean>;
  /** Snapshot of active (non-expired) leases for a server (UI listing). */
  list(serverDomain: string, now: number): Promise<BoxSealedLeaseRecord[]>;
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
  servers: ServerStorage;
  routing: RoutingStorage;
  installEvents: InstallEventStorage;
  provisionStatus: ProvisionStatusStorage;
  auditEvents: AuditEventStorage;
  luksKeys: LuksKeyStorage;
  autoUnlockLeases: AutoUnlockLeaseStorage;
  secretMailbox: SecretMailboxStorage;
  boxSealedLeases: BoxSealedLeaseStorage;
  pendingRePairs: PendingRePairStorage;
  webauthnRecovery: WebauthnRecoveryStorage;
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
  deviceCapabilityGrants: DeviceCapabilityGrantStorage;
  watchDelegates: WatchDelegateStorage;
  mintReservations: MintReservationStorage;
  acmeAccountKeyGrants: AcmeAccountKeyGrantStorage;
  acmeAccountKeyDelivery: AcmeAccountKeyDeliveryStorage;
  namespace: NamespaceStorage;
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
  /**
   * Phase 3b (cross-device QR pairing) — bitfield tracking which
   * scheduled "review your trusted devices" alerts have ALREADY
   * fired for this freshly-admitted (quarantined) device. Mirrors
   * `pending_re_pairs.alerts_fired_bitmap`: the scheduler OR-s in a
   * single power-of-2 bit per ladder rung, so a repeated tick past
   * the same offset is a no-op. Absent / 0 = nothing fired yet.
   *
   *   bit 0 = T+0   (admit)
   *   bit 1 = T+1d
   *   bit 2 = T+3d
   *   bit 3 = T+7d
   *   bit 4 = T+13d (last nudge before quarantine lifts at T+14d)
   *
   * Only meaningful while `quarantineUntil > now`; once the
   * quarantine lifts the scheduler stops walking the row.
   */
  quarantineAlertsFiredBitmap?: number;
}

export interface PushTokenStorage {
  put(rec: PushTokenRecord): Promise<void>;
  get(tokenId: string): Promise<PushTokenRecord | undefined>;
  listByUser(username: string): Promise<PushTokenRecord[]>;
  remove(tokenId: string): Promise<void>;
  touchLastSeen(tokenId: string, at: number): Promise<void>;
  /**
   * v1.2 Phase 2 — stamp `quarantine_until` on a freshly-admitted
   * device's row. Called by the re-pair completion handler (the
   * new IRK's first push_token, if any, gets `now + 14*86_400_000`)
   * and by the device-add path once that endpoint exists.
   * Returns true iff the row exists (false on unknown tokenId).
   * Idempotent — repeated calls with the same untilMs are no-ops.
   */
  setQuarantineUntil(tokenId: string, untilMs: number): Promise<boolean>;
  /**
   * Phase 3b — walk every push-token row still under quarantine
   * (`quarantine_until > now`), capped at `limit` (default 100).
   * Backed by `idx_push_tokens_quarantine`. Used by the cron-driven
   * `scheduleQuarantineAlerts` so it can OR-in the next-due
   * "review your trusted devices" bit on each device crossing a
   * T+0/T+1d/T+3d/T+7d/T+13d threshold. Returns rows in
   * registration-ascending order so the oldest admit fires first.
   */
  listQuarantined(now: number, limit?: number): Promise<PushTokenRecord[]>;
  /**
   * Phase 3b — OR a single new bit into `quarantine_alerts_fired_bitmap`
   * for the given push-token row. Returns the post-write bitmap so the
   * caller can confirm idempotency, or 0 if the row no longer exists.
   * No-op (returns the existing value) if the bit was already set.
   */
  orInQuarantineAlertBit(tokenId: string, bit: number): Promise<number>;
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
  /** Public IPv4 the provider handed back at create time (migration 0036).
   *  Device-identifying so a demo user can confirm the running box is
   *  theirs ("my device is at 1.2.3.4"). NULL until the provider returns
   *  it / pre-0036 rows. */
  activeServerIp: string | null;
  /** Provider OS image the box was provisioned from, e.g. `debian-12`
   *  (migration 0036). Device-identifying; surfaced in the detail page's
   *  info block. NULL on pre-0036 rows. */
  image: string | null;
  /** FQDN we publish for the running demo, e.g. home.demoalice.flagship.services. */
  activeServerFqdn: string | null;
  /** Wall-clock ms of the last /connect or /heartbeat. */
  lastActivityAt: number;
  state: DemoUserState;
  createdAt: number;
  /**
   * Provisioning observability (migration 0035). The latest named PHASE
   * checkpoint the box pushed to .com — see `@flagship/protocol`
   * `PROVISION_PHASES`. NULL until the first checkpoint arrives. The
   * `state` machine above ('none'/'provisioning'/'up') is coarse; this
   * field is the fine-grained "which step within provisioning" signal
   * the phone + debug tooling read via /api/account/resolve.
   */
  provisionPhase: string | null;
  /** Wall-clock ms the latest phase landed. NULL until first checkpoint. */
  provisionPhaseAt: number | null;
  /** Failure detail; set alongside `provisionPhase === "failed"`. */
  provisionLastError: string | null;
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
  /** Record the latest provisioning PHASE checkpoint for a row. Stamps
   *  `provision_phase` + `provision_phase_at`; `error` populates
   *  `provision_last_error` (passing `null` clears it). Returns the
   *  updated row, or `null` when no such username exists. Idempotent —
   *  re-posting the same phase just refreshes the timestamp. */
  setProvisionPhase(
    username: string,
    phase: string,
    error: string | null,
    at: number,
  ): Promise<DemoUserRecord | null>;
}

// ──────────────────────────────────────────────────────────────────────
// Device capability grants (v2 device-addressing — S3.2)
// ──────────────────────────────────────────────────────────────────────

/**
 * Persisted row for a `DeviceCapabilityGrant` envelope (see
 * `@flagship/protocol`'s auth.ts + docs/v2-device-addressing-and-real-
 * ticket.md §2). The envelope itself lives on the phone / Worker / daemon
 * as canonical bytes + Ed25519 signature; this row is the .com-side
 * persistence layer keyed by the grant id (SHA-256 of canonical bytes).
 *
 * `scopesJson` is the sorted JSON array of DeviceScope strings as
 * serialized by the protocol layer's canonicalization; storing it as
 * text keeps D1 schema-agnostic while preserving the exact byte shape
 * the envelope was signed over. Readers MUST `JSON.parse` and validate
 * against the protocol's `DEVICE_SCOPES` set before trusting it.
 *
 * `revokedAt` is null while the grant is active; a successful
 * `RevokeDeviceCapabilityGrant` flips it to ms-since-epoch. The row is
 * NEVER deleted — historic grants remain queryable for audit + replay.
 */
export interface DeviceCapabilityGrantRecord {
  grantId: string;
  username: string;
  deviceLabel: string;
  devicePubHex: string;
  scopesJson: string;
  issuedAt: number;
  expiresAt: number;
  signatureHex: string;
  revokedAt: number | null;
}

/**
 * Store contract for `device_capability_grants`. Implementations live
 * in `inMemory.ts` (tests + dev runs) and `d1.ts` (Worker production).
 *
 * Invariants enforced by the storage layer:
 *
 *   • `put` rejects a duplicate ACTIVE grant for the same
 *     `(username, deviceLabel)` — re-issuance MUST call `revoke` on
 *     the prior grant first. The D1 adapter relies on the unique
 *     partial index (`idx_dcg_username_label_active`) for this; the
 *     InMemory adapter checks explicitly. The shared reason string
 *     `'duplicate active grant for (username, device_label)'` makes
 *     the failure mode caller-checkable across both adapters.
 *
 *   • `getActiveForUserLabel` returns AT MOST one row. Both adapters
 *     fail loudly (throw) if the invariant is somehow violated —
 *     defense-in-depth against a future migration that drops the
 *     partial index.
 *
 *   • `listForUser` returns rows sorted by `issuedAt` DESCENDING
 *     (most-recent first). Callers that want chronological order
 *     reverse the array — the docs/spec audit feeds want
 *     newest-first.
 *
 *   • `revoke` mutates `revokedAt` only; the row stays so a later
 *     `get(grantId)` still resolves. Throws on unknown grantId — the
 *     handler that issued the revoke should have read the row
 *     immediately before, so a missing row indicates a logic bug.
 */
export interface DeviceCapabilityGrantStorage {
  /** Insert a fresh grant row. Returns `ok:false` with the well-known
   *  reason `'duplicate active grant for (username, device_label)'`
   *  when another ACTIVE row already exists for that pair AND the
   *  incoming row is itself ACTIVE (`revokedAt === null`). */
  put(rec: DeviceCapabilityGrantRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(grantId: string): Promise<DeviceCapabilityGrantRecord | undefined>;
  /** All grants for a user, ACTIVE + revoked, sorted issued_at DESC
   *  (most-recent first). */
  listForUser(username: string): Promise<DeviceCapabilityGrantRecord[]>;
  /** The SINGLE active grant matching `(username, deviceLabel)`, or
   *  undefined. */
  getActiveForUserLabel(username: string, deviceLabel: string): Promise<DeviceCapabilityGrantRecord | undefined>;
  /** Look up by device pubkey hex. When more than one grant covers
   *  the same pubkey (a device that's been re-labeled), returns the
   *  most-recent ACTIVE grant; undefined when no active row matches. */
  getByDevicePub(devicePubHex: string): Promise<DeviceCapabilityGrantRecord | undefined>;
  /** Stamp `revoked_at` on the matching grant. Throws Error
   *  `'unknown grantId'` if no row exists. */
  revoke(grantId: string, revokedAt: number): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// WatchDelegateKey — opt-in quick-approve delegate keys (migration 0041)
//
// The IRK-attested `WatchDelegateKey` envelope (packages/protocol/src/auth.ts)
// lets the owner approve a server BOOT from the Watch without a fresh phone
// biometric prompt. Stored per user, scoped to "boot-approval" ONLY, short-TTL,
// independently revocable. Parallels device_capability_grants but is simpler:
// ONE active delegate per user (re-mint tombstones the prior), no device label.
// `revoked_at` is null while active; the row is RETAINED on revoke so audit +
// replay still resolve.
// ──────────────────────────────────────────────────────────────────────

export interface WatchDelegateRecord {
  grantId: string;
  username: string;
  delegatePubHex: string;
  scopesJson: string;
  issuedAt: number;
  expiresAt: number;
  /** Ed25519 IRK signature over the WatchDelegateKey canonical bytes. */
  signatureHex: string;
  revokedAt: number | null;
}

/**
 * Store contract for `watch_delegates`. Invariants:
 *   • `put` rejects a duplicate ACTIVE delegate for the same `username`
 *     (re-mint MUST `revoke` the prior first). The D1 adapter relies on the
 *     unique partial index `idx_wd_username_active`; InMemory checks
 *     explicitly. Shared reason `'duplicate active watch delegate for user'`.
 *   • `getActiveForUser` returns AT MOST one row; both adapters throw if that
 *     invariant is somehow violated.
 *   • `listForUser` is issued_at DESC (most-recent first).
 *   • `revoke` mutates `revoked_at` only; the row stays. Throws
 *     `'unknown grantId'` on a missing row.
 */
export interface WatchDelegateStorage {
  put(rec: WatchDelegateRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(grantId: string): Promise<WatchDelegateRecord | undefined>;
  /** All delegates for a user, ACTIVE + revoked, issued_at DESC. */
  listForUser(username: string): Promise<WatchDelegateRecord[]>;
  /** The SINGLE active delegate for a user, or undefined. */
  getActiveForUser(username: string): Promise<WatchDelegateRecord | undefined>;
  /** The active delegate whose pubkey matches — used to verify a
   *  delegate-signed boot approval. undefined when none active. */
  getActiveByDelegatePub(delegatePubHex: string): Promise<WatchDelegateRecord | undefined>;
  revoke(grantId: string, revokedAt: number): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// AcmeAccountKeyGrant — sealed ACME account key handed to an admin device
// (migration 0043; per-user-cert design)
//
// The IRK-signed `AcmeAccountKeyGrant` envelope (packages/protocol/src/auth.ts)
// distributes the (already-sealed, opaque) ACME account key to each device the
// account designates `admin`. Those devices may mint/renew the per-user cert;
// `.com` never sees the unsealed key. Shape parallels WatchDelegateRecord, but
// with TWO deliberate differences:
//   • MULTIPLE active grants per user are allowed — each admin device holds its
//     own sealed copy, so there is NO unique-active index. `put` only rejects a
//     duplicate `grantId`.
//   • `revokeByAccountKeyId` tombstones EVERY grant of a retired key in one
//     shot (rotation on admin demotion / compromise kills all copies at once).
// `revoked_at` is null while active; rows are RETAINED on revoke for audit.
// ──────────────────────────────────────────────────────────────────────

export interface AcmeAccountKeyGrantRecord {
  grantId: string;
  username: string;
  /** sha256-hex of the ACME account PUBLIC key — shared by every grant of the
   *  same key; rotation changes it. The handle `revokeByAccountKeyId` keys on. */
  accountKeyId: string;
  /** The recipient admin device's Ed25519 pubkey, 32 bytes hex. */
  recipientPubHex: string;
  /** The ACME account key sealed to the recipient (opaque ciphertext, hex). */
  sealedAccountKeyHex: string;
  issuedAt: number;
  expiresAt: number;
  /** Ed25519 IRK signature over the AcmeAccountKeyGrant canonical bytes. */
  signatureHex: string;
  revokedAt: number | null;
}

/**
 * Store contract for `acme_account_key_grants`. Invariants:
 *   • `put` rejects only a duplicate `grantId` (reason
 *     `'duplicate acme account key grant id'`). Unlike watch delegates there is
 *     NO one-active-per-user limit — every admin device holds its own grant.
 *   • `getActiveForUser` returns ALL active (non-revoked) grants for a user.
 *   • `getActiveByRecipient` returns the active grants sealed to one device.
 *   • `listForUser` is issued_at DESC (most-recent first), active + revoked.
 *   • `revoke` mutates one row's `revoked_at`; throws `'unknown grantId'` on a
 *     missing row.
 *   • `revokeByAccountKeyId` tombstones every still-active grant of that key and
 *     returns the count revoked (rotation of a retired account key).
 */
export interface AcmeAccountKeyGrantStorage {
  put(rec: AcmeAccountKeyGrantRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  get(grantId: string): Promise<AcmeAccountKeyGrantRecord | undefined>;
  /** All grants for a user, ACTIVE + revoked, issued_at DESC. */
  listForUser(username: string): Promise<AcmeAccountKeyGrantRecord[]>;
  /** ALL active grants for a user (one per admin device). */
  getActiveForUser(username: string): Promise<AcmeAccountKeyGrantRecord[]>;
  /** Active grants sealed to a specific recipient device pubkey. */
  getActiveByRecipient(recipientPubHex: string): Promise<AcmeAccountKeyGrantRecord[]>;
  revoke(grantId: string, revokedAt: number): Promise<void>;
  /** Tombstone every active grant of `accountKeyId`; returns the count revoked. */
  revokeByAccountKeyId(accountKeyId: string, revokedAt: number): Promise<number>;
}

// ──────────────────────────────────────────────────────────────────────
// AcmeAccountKeyDelivery — seal-to-box delivery of the shared ACME account
// key (#28 Option B; per-user-cert design). Deposit-and-release, mirroring
// the box-sealed LUKS lease (BoxSealedLeaseStorage above):
//   • An admin DEPOSITS the account key sealed to the box STK (one slot per
//     server_domain — the box that serves it).
//   • The box RELEASES the slot on boot and unseals with its STK private key.
// `.com` holds only ciphertext (sealed to the box STK) + the IRK-signature-
// vetted public references; it can withhold (DoS) but never read or retarget
// the seal — the same invariants the LUKS lease release carries (I1/I2/I3).
//
// ONE slot per server_domain (PK), distinct from AcmeAccountKeyGrantStorage
// (which keeps the per-admin-device fan-out + audit/requireMinter copies). On
// rotation, deleteByAccountKeyId tombstones the box's released-key slot so a
// stolen box can't re-release a retired key.
// ──────────────────────────────────────────────────────────────────────

export interface AcmeAccountKeyDeliveryRecord {
  /** The box FQDN this sealed key is delivered to (PK — one slot per box). */
  serverDomain: string;
  /** sha256-hex of the ACME account PUBLIC key; rotation changes it. The
   *  handle `deleteByAccountKeyId` keys on this to drop a retired key's slot. */
  accountKeyId: string;
  /** The ACME account key sealed to `recipientPubHex` — opaque ciphertext hex.
   *  NEVER plaintext (I1). The box unseals with its STK private key. */
  sealedAccountKeyHex: string;
  /** The PINNED seal recipient — box STK pubkey, hex (the directory-bound
   *  identity for `serverDomain`; covered by the IRK signature on the grant). */
  recipientPubHex: string;
  issuedAt: number;
  expiresAt: number;
  /** ms since epoch, null = active. Set on a delivery-revoke (the slot is
   *  retained for audit; release refuses a revoked slot). */
  revokedAt: number | null;
}

/**
 * Store contract for `acme_account_key_delivery`. ONE active slot per box.
 *   • `put` inserts-or-replaces the slot for `serverDomain` (re-deposit
 *     overwrites — a fresh seal supersedes the prior one).
 *   • `getByDomain` returns the slot regardless of revoked/expired state
 *     (the handler applies the freshness + revoked gate, mirroring how the
 *     box-sealed-lease release filters).
 *   • `deleteByDomain` drops the slot (delivery-revoke).
 *   • `deleteByAccountKeyId` drops EVERY slot of a retired account key in one
 *     statement (rotation hook) and returns the count deleted.
 */
export interface AcmeAccountKeyDeliveryStorage {
  put(rec: AcmeAccountKeyDeliveryRecord): Promise<void>;
  getByDomain(serverDomain: string): Promise<AcmeAccountKeyDeliveryRecord | undefined>;
  deleteByDomain(serverDomain: string): Promise<void>;
  deleteByAccountKeyId(accountKeyId: string): Promise<number>;
}

// ──────────────────────────────────────────────────────────────────────
// Mint reservation lease (per-user-cert design — mint coordination)
//
// A short-TTL CAS lock that serializes who re-mints a user's per-user cert
// this cycle. A minter (admin device or "autonomous" box) acquires it before
// minting; others back off while it's live; if the holder dies the TTL lapses
// (δ ≈ one ACME order, ≪ remaining cert life) and the next minter takes over —
// dead-lead-safe, no static election. BEST-EFFORT: if `.com` is unreachable
// the daemon falls back to a deterministic local order, so renewal never
// hard-depends on `.com`. The lease is non-secret coordination metadata.
// ──────────────────────────────────────────────────────────────────────

export interface MintReservationRecord {
  /** One active reservation per user (the storage key). */
  username: string;
  /** The minter currently holding the lease (their signing pubkey, hex). */
  holderPubHex: string;
  acquiredAt: number;
  /** ms; the lease is reclaimable by anyone once `now >= expiresAt`. */
  expiresAt: number;
}

export interface MintReservationStorage {
  /**
   * Atomic CAS acquire: succeeds IFF no LIVE reservation exists for
   * `username` (no row, or the existing row is expired at `now`). Returns
   * the resulting live holder either way — `acquired` says whether YOU won.
   * Re-acquiring your own live lease (same holder) extends it and returns
   * acquired:true.
   */
  tryAcquire(args: {
    username: string;
    holderPubHex: string;
    expiresAt: number;
    now: number;
  }): Promise<{ acquired: boolean; holder: MintReservationRecord }>;
  get(username: string): Promise<MintReservationRecord | undefined>;
  /** Release the lease only if `holderPubHex` currently holds it; a no-op
   *  otherwise (a stale holder can't free a successor's lease). */
  release(username: string, holderPubHex: string): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// Merged per-user leftmost-label namespace (§3.4 invariant — migration 0044)
//
// docs/per-user-cert-and-addressing.md §3.4 + worklist task #25. Under
// per-user addressing every public name a user serves — an APP label
// (`<label>.<user>`), a BOX name (the per-box apex), and a DEVICE label
// (the v2 device-addressing `<user>.<device-label>` form) — shares ONE
// leftmost-label space beneath `*.<user>`. They MUST be mutually unique:
// the resolver (worklist task #24) walks `--`-pin → box-name → device-label
// → app-label, and that precedence is only sound if a single label can't
// simultaneously mean two different things. This store is the `.com`-side
// serializer of phone-signed name claims — it orders + dedupes so an
// offline cross-box install race resolves to exactly one owner per label.
//
// One row per (username, label); `(username, label)` is the uniqueness key
// (a UNIQUE index in D1). Labels are matched case-INSENSITIVELY (DNS labels
// are case-folding) — the adapters lower-case both columns on write so the
// stored form is already canonical. `kind` tags which of the three sources
// claimed it; `refId` is the stable identity the label maps to (the app's
// stable-id, the box's serverId, or the device-label). A re-claim that
// carries the IDENTICAL `(kind, refId)` is idempotent (ok); a claim from a
// DIFFERENT `(kind, refId)` is the collision the invariant exists to reject.
// ──────────────────────────────────────────────────────────────────────

export type NameClaimKind = "app" | "box" | "device";

export interface NameClaimRecord {
  /** Account that owns the `*.<user>` namespace. */
  username: string;
  /** The leftmost DNS label being claimed (case-insensitive; the adapters
   *  store it lower-cased). */
  label: string;
  /** Which of the three merged sources is claiming the label. */
  kind: NameClaimKind;
  /** The stable identity the label resolves to: an app's stable-id, a box's
   *  serverId, or a device-label. Pairs with `kind` to decide whether a
   *  re-claim is the same claim (idempotent) or a genuine collision. */
  refId: string;
  /** ms since epoch — when the claim was first recorded. */
  claimedAt: number;
}

/**
 * Store contract for `name_claims` — the merged per-user leftmost-label
 * uniqueness invariant. Implementations live in `inMemory.ts` (tests + dev)
 * and `d1.ts` (Worker production). Invariants:
 *
 *   • `claim` is the single mutating entry point. It returns
 *     `{ ok: true }` when the label is free OR when an existing claim for
 *     `(username, label)` has the IDENTICAL `(kind, refId)` (an idempotent
 *     re-claim — `claimedAt` is preserved, not bumped). It returns
 *     `{ ok: false, reason: "name taken" }` when `(username, label)` is
 *     already claimed by a DIFFERENT `kind`-or-`refId`. The shared reason
 *     string `"name taken"` makes the collision caller-checkable across
 *     both adapters.
 *   • `release` deletes the `(username, label)` row so the label is free
 *     to be claimed again (e.g. an app uninstalled, a box decommissioned).
 *     Idempotent: releasing an absent row is success.
 *   • `resolve` returns the single claim for `(username, label)` or
 *     undefined — the lookup the addressing resolver uses to learn a
 *     label's kind + target.
 *   • `listForUser` returns every claim for the user (claimedAt ASC, oldest
 *     first) — drives the "what names does this account own" listing.
 *
 * Username + label are matched case-insensitively throughout.
 */
export interface NamespaceStorage {
  claim(rec: NameClaimRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  release(username: string, label: string): Promise<void>;
  resolve(username: string, label: string): Promise<NameClaimRecord | undefined>;
  listForUser(username: string): Promise<NameClaimRecord[]>;
}
