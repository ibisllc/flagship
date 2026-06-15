import type {
  AccountType,
  AuditEventRecord,
  AuditEventStorage,
  AutoUnlockLeaseRecord,
  AutoUnlockLeaseStorage,
  SecretMailboxRecord,
  SecretMailboxStorage,
  SecretMailboxPurpose,
  BoxSealedLeaseRecord,
  BoxSealedLeaseStorage,
  PendingRePairRecord,
  PendingRePairStorage,
  RecoveryWipePolicy,
  WebauthnRecoveryRecord,
  WebauthnRecoveryStorage,
  EntitlementRevocationListRecord,
  EntitlementRevocationStorage,
  AuthCodeRecord,
  AuthCodeStorage,
  InstallEvent,
  InstallEventStorage,
  ProvisionStatusRecord,
  ProvisionStatusHistoryEntry,
  ProvisionStatusStorage,
  LlmPromoLifetimeRecord,
  LlmPromoStorage,
  LlmPromoUsageRecord,
  LuksKeyStorage,
  MarketplaceListingRecord,
  MarketplaceSearchQuery,
  MarketplaceStorage,
  PushTokenRecord,
  PushTokenStorage,
  RoutingRecord,
  RoutingStorage,
  SealedLuksKeyRecord,
  ServerRecord,
  ServerStorage,
  Storage,
  TierStorage,
  TierSubscriptionRecord,
  UsageStorage,
  UsageCounterRecord,
  VoucherStorage,
  VoucherRecord,
  UserIdentityRecord,
  UserIdentityRecordStorage,
  UsernameRecord,
  UsernameAliasRecord,
  UsernameAliasStorage,
  UsernameStorage,
  DaemonStatusRecord,
  DaemonStatusStorage,
  UserServiceAliasRecord,
  UserServiceAliasStorage,
  VoiciLinkRecord,
  VoiciLinkStorage,
  CustomDomainOrderRecord,
  CustomDomainOrderStorage,
  DemoLlmLedgerStorage,
  DemoUserRecord,
  DemoUserState,
  DemoUsersStorage,
  InstallPolicyFanoutRecord,
  InstallPolicyFanoutStorage,
  DeviceCapabilityGrantRecord,
  DeviceCapabilityGrantStorage,
  SchemaVersionRecord,
  SchemaVersionStorage,
  CtAlertStorage,
  TrustExceptionRecord,
  TrustExceptionStorage,
  WatchDelegateRecord,
  WatchDelegateStorage,
  AcmeAccountKeyGrantRecord,
  AcmeAccountKeyGrantStorage,
  AcmeAccountKeyDeliveryRecord,
  AcmeAccountKeyDeliveryStorage,
  MintReservationRecord,
  MintReservationStorage,
  NameClaimRecord,
  NamespaceStorage,
  NameClaimKind,
} from "./types.js";

/**
 * Cloudflare D1 (SQLite) implementations of the storage interfaces.
 *
 * D1 isn't imported as a Worker type to keep this package buildable
 * outside the Worker; the binding is duck-typed via D1Database below.
 */

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>;
  exec?(query: string): Promise<unknown>;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: D1Meta }>;
  run(): Promise<D1Result>;
}
export interface D1Result {
  success: boolean;
  meta: D1Meta;
  error?: string;
}
export interface D1Meta {
  changes?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

interface UsernameRow {
  username: string;
  irk_pub_hex: string;
  claimed_at: number;
  /** 0/1; nullable so a pre-migration row (no column) decodes safely. */
  is_demo?: number | null;
  // v1.2 — security-cascade columns (migration 0028). All four are
  // nullable here so a SELECT against a database that hasn't yet
  // applied the migration decodes without throwing; the rowTo* helper
  // defaults account_type to 'single' on absence, matching the
  // column-DEFAULT semantics in the migration.
  account_type?: string | null;
  totp_secret_encrypted?: string | null;
  recovery_codes_hashes_json?: string | null;
  totp_enrolled_at?: number | null;
  // v2.1 — recovery-wipe policy column (migration 0032). Nullable for
  // pre-migration safety; the rowTo* helper defaults to 'graceful'.
  recovery_wipe_policy?: string | null;
}
interface AuthCodeRow {
  serial: string;
  username: string;
  server_name: string;
  server_domain: string;
  delegated_pubkey_hex: string;
  user_pubkey_hex: string;
  user_signature_hex: string;
  issued_at: number;
  expires_at: number;
  status: string;
  recorded_at: number;
  used_at: number | null;
  revoked_at: number | null;
}
interface ServerRow {
  server_domain: string;
  username: string;
  identity_pubkey_hex: string;
  registered_at: number;
  revoked_at: number | null;
  revocation_reason: string | null;
}

function rowToUsername(r: UsernameRow): UsernameRecord {
  // v1.2 — account_type narrows TEXT to the AccountType union. A row
  // from a database that hasn't yet applied 0028 lands as undefined
  // here; we default to 'single' to mirror the column DEFAULT.
  const accountType: AccountType =
    r.account_type === "multi" || r.account_type === "demo"
      ? r.account_type
      : "single";
  // v2.1 — recovery_wipe_policy narrows TEXT to the RecoveryWipePolicy
  // union. Pre-0032 rows decode as undefined and we COALESCE to
  // 'graceful', matching the migration column DEFAULT.
  const recoveryWipePolicy: RecoveryWipePolicy =
    r.recovery_wipe_policy === "strict" ? "strict" : "graceful";
  return {
    username: r.username,
    irkPubHex: r.irk_pub_hex,
    claimedAt: r.claimed_at,
    isDemo: r.is_demo === 1,
    accountType,
    recoveryWipePolicy,
    ...(r.totp_secret_encrypted != null
      ? { totpSecretEncrypted: r.totp_secret_encrypted }
      : {}),
    ...(r.recovery_codes_hashes_json != null
      ? { recoveryCodesHashesJson: r.recovery_codes_hashes_json }
      : {}),
    ...(r.totp_enrolled_at != null ? { totpEnrolledAt: r.totp_enrolled_at } : {}),
  };
}
function rowToAuthCode(r: AuthCodeRow): AuthCodeRecord {
  return {
    serial: r.serial,
    username: r.username,
    serverName: r.server_name,
    serverDomain: r.server_domain,
    delegatedPubKeyHex: r.delegated_pubkey_hex,
    userPubKeyHex: r.user_pubkey_hex,
    userSignatureHex: r.user_signature_hex,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    status: r.status as AuthCodeRecord["status"],
    recordedAt: r.recorded_at,
    usedAt: r.used_at ?? undefined,
    revokedAt: r.revoked_at ?? undefined,
  };
}
function rowToServer(r: ServerRow): ServerRecord {
  return {
    serverDomain: r.server_domain,
    username: r.username,
    identityPubKeyHex: r.identity_pubkey_hex,
    registeredAt: r.registered_at,
    revokedAt: r.revoked_at ?? undefined,
    revocationReason: r.revocation_reason ?? undefined,
  };
}

export class D1UsernameStorage implements UsernameStorage {
  constructor(private db: D1Database) {}
  async put(rec: UsernameRecord) {
    const norm = rec.username.toLowerCase();
    const existing = await this.db
      .prepare("SELECT * FROM usernames WHERE username = ?")
      .bind(norm)
      .first<UsernameRow>();
    if (existing && existing.irk_pub_hex !== rec.irkPubHex) {
      return { ok: false as const, reason: "username already claimed" };
    }
    // ON CONFLICT deliberately updates only claimed_at — is_demo and
    // the v1.2 cascade fields (account_type, TOTP artifacts) are never
    // touched on a re-claim, so a benign re-put can't clear an
    // operator-set demo flag or kick a multi-device account back to
    // single. Mutation of those fields goes through setDemo() and the
    // dedicated TOTP-enrollment paths (Phase 3) respectively.
    await this.db
      .prepare(
        "INSERT INTO usernames " +
          "(username, irk_pub_hex, claimed_at, is_demo, account_type, totp_secret_encrypted, recovery_codes_hashes_json, totp_enrolled_at, recovery_wipe_policy) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(username) DO UPDATE SET claimed_at = excluded.claimed_at",
      )
      .bind(
        norm,
        rec.irkPubHex,
        rec.claimedAt,
        rec.isDemo ? 1 : 0,
        rec.accountType ?? "single",
        rec.totpSecretEncrypted ?? null,
        rec.recoveryCodesHashesJson ?? null,
        rec.totpEnrolledAt ?? null,
        rec.recoveryWipePolicy ?? "graceful",
      )
      .run();
    return { ok: true as const };
  }
  async get(username: string) {
    const r = await this.db
      .prepare("SELECT * FROM usernames WHERE username = ?")
      .bind(username.toLowerCase())
      .first<UsernameRow>();
    return r ? rowToUsername(r) : undefined;
  }
  async list() {
    const r = await this.db.prepare("SELECT * FROM usernames").all<UsernameRow>();
    return r.results.map(rowToUsername);
  }
  async swapIrkPub(username: string, expectedOldIrkPubHex: string, newIrkPubHex: string, at: number) {
    // Conditional update: only swaps if the current row's irk_pub_hex
    // matches `expectedOldIrkPubHex` (case-insensitive). meta.changes
    // tells us whether the swap happened.
    const r = await this.db
      .prepare(
        "UPDATE usernames SET irk_pub_hex = ?, claimed_at = ? " +
        "WHERE username = ? AND lower(irk_pub_hex) = lower(?)",
      )
      .bind(newIrkPubHex, at, username.toLowerCase(), expectedOldIrkPubHex)
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async setDemo(username: string, isDemo: boolean) {
    const r = await this.db
      .prepare("UPDATE usernames SET is_demo = ? WHERE username = ?")
      .bind(isDemo ? 1 : 0, username.toLowerCase())
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async setTotpSecretEncrypted(username: string, encrypted: string) {
    const r = await this.db
      .prepare(
        "UPDATE usernames SET totp_secret_encrypted = ? WHERE username = ?",
      )
      .bind(encrypted, username.toLowerCase())
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async finalizeTotpEnrollment(
    username: string,
    at: number,
    recoveryCodesHashesJson: string,
  ) {
    const r = await this.db
      .prepare(
        "UPDATE usernames SET account_type = 'multi', " +
          "totp_enrolled_at = ?, recovery_codes_hashes_json = ? " +
          "WHERE username = ?",
      )
      .bind(at, recoveryCodesHashesJson, username.toLowerCase())
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async clearTotp(username: string) {
    const r = await this.db
      .prepare(
        "UPDATE usernames SET account_type = 'single', " +
          "totp_secret_encrypted = NULL, recovery_codes_hashes_json = NULL, " +
          "totp_enrolled_at = NULL WHERE username = ?",
      )
      .bind(username.toLowerCase())
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async casRecoveryCodes(
    username: string,
    expectedJson: string,
    newJson: string,
  ) {
    // CAS the JSON column. SQLite/D1 doesn't have a native "compare
    // value or NULL" so we branch the WHERE: when the caller expects
    // an empty baseline (""), match either NULL or literal "".
    const norm = username.toLowerCase();
    const sql =
      expectedJson === ""
        ? "UPDATE usernames SET recovery_codes_hashes_json = ? " +
          "WHERE username = ? AND (recovery_codes_hashes_json IS NULL OR recovery_codes_hashes_json = '')"
        : "UPDATE usernames SET recovery_codes_hashes_json = ? " +
          "WHERE username = ? AND recovery_codes_hashes_json = ?";
    const stmt = this.db.prepare(sql);
    const bound =
      expectedJson === ""
        ? stmt.bind(newJson, norm)
        : stmt.bind(newJson, norm, expectedJson);
    const r = await bound.run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
}

export class D1UsernameAliasStorage implements UsernameAliasStorage {
  constructor(private db: D1Database) {}
  async put(rec: UsernameAliasRecord) {
    const oldNorm = rec.oldUsername.toLowerCase();
    const newNorm = rec.newUsername.toLowerCase();
    const existing = await this.db
      .prepare(`SELECT new_username FROM usernames_aliases WHERE old_username = ?1`)
      .bind(oldNorm)
      .first<{ new_username: string }>();
    if (existing && existing.new_username.toLowerCase() !== newNorm) {
      return { ok: false as const, reason: "alias already points elsewhere" };
    }
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO usernames_aliases
         (old_username, new_username, effective_at, signature_hex)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(oldNorm, newNorm, rec.effectiveAt, rec.signatureHex)
      .run();
    return { ok: true as const };
  }
  async resolve(username: string) {
    const chain: string[] = [];
    let current = username.toLowerCase();
    chain.push(current);
    for (let hops = 0; hops < 8; hops++) {
      const next = await this.db
        .prepare(`SELECT new_username FROM usernames_aliases WHERE old_username = ?1`)
        .bind(current)
        .first<{ new_username: string }>();
      if (!next) break;
      current = next.new_username.toLowerCase();
      chain.push(current);
    }
    return { current, chain };
  }
  async isConsumed(username: string) {
    const norm = username.toLowerCase();
    const r = await this.db
      .prepare(
        `SELECT 1 AS hit FROM usernames_aliases
         WHERE old_username = ?1 OR new_username = ?1 LIMIT 1`,
      )
      .bind(norm)
      .first<{ hit: number }>();
    return !!r;
  }
}

export class D1AuthCodeStorage implements AuthCodeStorage {
  constructor(private db: D1Database) {}
  async put(rec: AuthCodeRecord) {
    try {
      await this.db
        .prepare(
          `INSERT INTO auth_codes (
            serial, username, server_name, server_domain,
            delegated_pubkey_hex, user_pubkey_hex, user_signature_hex,
            issued_at, expires_at, status, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          rec.serial,
          rec.username,
          rec.serverName,
          rec.serverDomain,
          rec.delegatedPubKeyHex,
          rec.userPubKeyHex,
          rec.userSignatureHex,
          rec.issuedAt,
          rec.expiresAt,
          rec.status,
          rec.recordedAt,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE/i.test(msg)) {
        return { ok: false as const, reason: "serial already issued" };
      }
      throw e;
    }
  }
  async get(serial: string) {
    const r = await this.db
      .prepare("SELECT * FROM auth_codes WHERE serial = ?")
      .bind(serial)
      .first<AuthCodeRow>();
    return r ? rowToAuthCode(r) : undefined;
  }
  async markUsed(serial: string, now: number) {
    const r = await this.db
      .prepare(
        `UPDATE auth_codes
         SET status = 'used', used_at = ?
         WHERE serial = ? AND status = 'active' AND expires_at >= ?`,
      )
      .bind(now, serial, now)
      .run();
    if (r.meta.changes && r.meta.changes > 0) return { ok: true as const };
    const cur = await this.get(serial);
    if (!cur) return { ok: false as const, reason: "unknown serial" };
    if (cur.status === "used") return { ok: false as const, reason: "already used" };
    if (cur.status === "revoked") return { ok: false as const, reason: "revoked" };
    if (now > cur.expiresAt) return { ok: false as const, reason: "expired" };
    return { ok: false as const, reason: "could not mark used" };
  }
  async markRevoked(serial: string, now: number) {
    const r = await this.db
      .prepare(
        `UPDATE auth_codes
         SET status = 'revoked', revoked_at = ?
         WHERE serial = ? AND status != 'revoked'`,
      )
      .bind(now, serial)
      .run();
    if (r.meta.changes && r.meta.changes > 0) return { ok: true as const };
    const cur = await this.get(serial);
    if (!cur) return { ok: false as const, reason: "unknown serial" };
    return { ok: true as const };
  }
  async listActiveByServerDomain(serverDomain: string) {
    const r = await this.db
      .prepare(
        "SELECT * FROM auth_codes WHERE server_domain = ? AND status = 'active'",
      )
      .bind(serverDomain)
      .all<AuthCodeRow>();
    return r.results.map(rowToAuthCode);
  }
  async latestByServerDomain(serverDomain: string) {
    const r = await this.db
      .prepare(
        "SELECT * FROM auth_codes WHERE server_domain = ? ORDER BY recorded_at DESC LIMIT 1",
      )
      .bind(serverDomain)
      .first<AuthCodeRow>();
    return r ? rowToAuthCode(r) : undefined;
  }
  async listOutstandingByUsername(username: string, now: number) {
    const r = await this.db
      .prepare(
        "SELECT * FROM auth_codes WHERE username = ? AND status = 'active' AND expires_at > ?",
      )
      .bind(username, now)
      .all<AuthCodeRow>();
    return r.results.map(rowToAuthCode);
  }
}

export class D1ServerStorage implements ServerStorage {
  constructor(private db: D1Database) {}
  async put(rec: ServerRecord) {
    await this.db
      .prepare(
        `INSERT INTO servers (
          server_domain, username, identity_pubkey_hex, registered_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(server_domain) DO UPDATE SET
          username = excluded.username,
          identity_pubkey_hex = excluded.identity_pubkey_hex,
          registered_at = excluded.registered_at,
          revoked_at = NULL,
          revocation_reason = NULL`,
      )
      .bind(rec.serverDomain, rec.username, rec.identityPubKeyHex, rec.registeredAt)
      .run();
  }
  async get(serverDomain: string) {
    const r = await this.db
      .prepare("SELECT * FROM servers WHERE server_domain = ?")
      .bind(serverDomain)
      .first<ServerRow>();
    return r ? rowToServer(r) : undefined;
  }
  async listForUser(username: string) {
    const r = await this.db
      .prepare("SELECT * FROM servers WHERE username = ?")
      .bind(username)
      .all<ServerRow>();
    return r.results.map(rowToServer);
  }
  async listAll() {
    const r = await this.db
      .prepare("SELECT * FROM servers")
      .all<ServerRow>();
    return r.results.map(rowToServer);
  }
  async revoke(serverDomain: string, reason: string, at: number) {
    const r = await this.db
      .prepare(
        "UPDATE servers SET revoked_at = ?, revocation_reason = ? WHERE server_domain = ?",
      )
      .bind(at, reason, serverDomain)
      .run();
    return Boolean(r.meta.changes && r.meta.changes > 0);
  }
}

interface RoutingRow {
  subdomain: string;
  username: string;
  rck_pubkey_hex: string;
  current_target_hex: string;
  registered_at: number;
  last_target_update: number;
  last_target_nonce: string;
}

function rowToRouting(r: RoutingRow): RoutingRecord {
  return {
    subdomain: r.subdomain,
    username: r.username,
    rckPubKeyHex: r.rck_pubkey_hex,
    currentTargetHex: r.current_target_hex,
    registeredAt: r.registered_at,
    lastTargetUpdate: r.last_target_update,
    lastTargetNonce: r.last_target_nonce ?? "",
  };
}

export class D1RoutingStorage implements RoutingStorage {
  constructor(private db: D1Database) {}
  async register(rec: RoutingRecord) {
    const existing = await this.db
      .prepare("SELECT * FROM routing WHERE subdomain = ?")
      .bind(rec.subdomain)
      .first<RoutingRow>();
    if (existing && existing.rck_pubkey_hex !== rec.rckPubKeyHex) {
      return { ok: false as const, reason: "subdomain already controlled by a different RCK" };
    }
    await this.db
      .prepare(
        `INSERT INTO routing (
          subdomain, username, rck_pubkey_hex,
          current_target_hex, registered_at, last_target_update, last_target_nonce
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subdomain) DO UPDATE SET
          username = excluded.username,
          rck_pubkey_hex = excluded.rck_pubkey_hex,
          registered_at = excluded.registered_at`,
      )
      .bind(
        rec.subdomain,
        rec.username,
        rec.rckPubKeyHex,
        rec.currentTargetHex,
        rec.registeredAt,
        rec.lastTargetUpdate,
        rec.lastTargetNonce,
      )
      .run();
    return { ok: true as const };
  }
  async get(subdomain: string) {
    const r = await this.db
      .prepare("SELECT * FROM routing WHERE subdomain = ?")
      .bind(subdomain)
      .first<RoutingRow>();
    return r ? rowToRouting(r) : undefined;
  }
  async setTarget(subdomain: string, newTargetHex: string, nonce: string, at: number) {
    const result = await this.db
      .prepare(
        `UPDATE routing
         SET current_target_hex = ?, last_target_update = ?, last_target_nonce = ?
         WHERE subdomain = ? AND (last_target_nonce = '' OR last_target_nonce < ?)`,
      )
      .bind(newTargetHex, at, nonce, subdomain, nonce)
      .run();
    if (result.meta.changes && result.meta.changes > 0) return { ok: true as const };
    const cur = await this.get(subdomain);
    if (!cur) return { ok: false as const, reason: "unknown subdomain" };
    return { ok: false as const, reason: "stale nonce (replay)" };
  }
  async release(subdomain: string) {
    await this.db
      .prepare("DELETE FROM routing WHERE subdomain = ?")
      .bind(subdomain)
      .run();
    return { ok: true as const };
  }
}

interface InstallEventRow {
  serial: string;
  seq: number;
  event_name: string;
  detail: string;
  posted_at: number;
}

export class D1InstallEventStorage implements InstallEventStorage {
  constructor(private db: D1Database) {}
  async put(rec: Omit<InstallEvent, "seq">) {
    const seqRow = await this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM install_events WHERE serial = ?")
      .bind(rec.serial)
      .first<{ max_seq: number }>();
    const seq = (seqRow?.max_seq ?? 0) + 1;
    await this.db
      .prepare(
        `INSERT INTO install_events (serial, seq, event_name, detail, posted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(rec.serial, seq, rec.eventName, rec.detail, rec.postedAt)
      .run();
    // Cap at 100 events per serial; oldest dropped first.
    await this.db
      .prepare(
        `DELETE FROM install_events
         WHERE serial = ? AND seq <= (
           SELECT MAX(seq) - 100 FROM install_events WHERE serial = ?
         )`,
      )
      .bind(rec.serial, rec.serial)
      .run();
    return { ok: true as const, seq };
  }
  async list(serial: string, sinceSeq = 0) {
    const r = await this.db
      .prepare(
        "SELECT * FROM install_events WHERE serial = ? AND seq > ? ORDER BY seq ASC",
      )
      .bind(serial, sinceSeq)
      .all<InstallEventRow>();
    return r.results.map((row) => ({
      serial: row.serial,
      seq: row.seq,
      eventName: row.event_name,
      detail: row.detail,
      postedAt: row.posted_at,
    }));
  }
}

interface ProvisionStatusRow {
  serial: string;
  server_domain: string | null;
  phase: string;
  detail: string | null;
  updated_at: number;
  history: string;
}

export class D1ProvisionStatusStorage implements ProvisionStatusStorage {
  constructor(private db: D1Database) {}
  async putProvisionStatus(
    serial: string,
    entry: { serverDomain?: string; phase: string; detail?: string; ts: number },
  ): Promise<void> {
    const existing = await this.db
      .prepare("SELECT history, server_domain FROM provision_status WHERE serial = ?")
      .bind(serial)
      .first<{ history: string; server_domain: string | null }>();
    let history: ProvisionStatusHistoryEntry[] = [];
    if (existing?.history) {
      try {
        const parsed = JSON.parse(existing.history);
        if (Array.isArray(parsed)) history = parsed as ProvisionStatusHistoryEntry[];
      } catch {
        history = [];
      }
    }
    history.push({
      phase: entry.phase,
      ts: entry.ts,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    });
    // Preserve a previously-recorded server_domain when this report omits it.
    const serverDomain = entry.serverDomain ?? existing?.server_domain ?? null;
    await this.db
      .prepare(
        `INSERT INTO provision_status (serial, server_domain, phase, detail, updated_at, history)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(serial) DO UPDATE SET
           server_domain = excluded.server_domain,
           phase = excluded.phase,
           detail = excluded.detail,
           updated_at = excluded.updated_at,
           history = excluded.history`,
      )
      .bind(
        serial,
        serverDomain,
        entry.phase,
        entry.detail ?? null,
        entry.ts,
        JSON.stringify(history),
      )
      .run();
  }
  async getProvisionStatus(serial: string): Promise<ProvisionStatusRecord | null> {
    // #56 — swallow a missing-table / query failure and return null. This
    // lookup only ENRICHES the authoritative server list (the merged `/pods`);
    // it must never be the reason the list 500s or comes back empty.
    let r: ProvisionStatusRow | null;
    try {
      r = await this.db
        .prepare("SELECT * FROM provision_status WHERE serial = ?")
        .bind(serial)
        .first<ProvisionStatusRow>();
    } catch {
      return null;
    }
    if (!r) return null;
    let history: ProvisionStatusHistoryEntry[] = [];
    try {
      const parsed = JSON.parse(r.history);
      if (Array.isArray(parsed)) history = parsed as ProvisionStatusHistoryEntry[];
    } catch {
      history = [];
    }
    return {
      serial: r.serial,
      serverDomain: r.server_domain ?? undefined,
      phase: r.phase,
      detail: r.detail ?? undefined,
      updatedAt: r.updated_at,
      history,
    };
  }
}

export class D1AuditEventStorage implements AuditEventStorage {
  constructor(private db: D1Database) {}
  async append(rec: Omit<AuditEventRecord, "seq">): Promise<AuditEventRecord> {
    const username = rec.username.toLowerCase();
    // v1.2 Phase 5 — the three account-type-aware columns are
    // NULLable on storage so pre-migration rows don't break; we bind
    // null when the caller didn't provide them.
    const r = await this.db
      .prepare(
        `INSERT INTO audit_events
           (username, event_kind, detail, device_prefix, posted_at,
            account_type_at_event, quarantine_until, recovery_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING seq`,
      )
      .bind(
        username,
        rec.eventKind,
        rec.detail,
        rec.devicePrefix,
        rec.postedAt,
        rec.accountTypeAtEvent ?? null,
        rec.quarantineUntil ?? null,
        rec.recoveryMethod ?? null,
      )
      .first<{ seq: number }>();
    return { ...rec, username, seq: r?.seq ?? 0 };
  }
  async list(username: string, sinceSeq: number, limit: number): Promise<AuditEventRecord[]> {
    const u = username.toLowerCase();
    const r = await this.db
      .prepare(
        `SELECT seq, username, event_kind, detail, device_prefix, posted_at,
                account_type_at_event, quarantine_until, recovery_method
         FROM audit_events
         WHERE username = ? AND seq > ?
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .bind(u, sinceSeq, limit)
      .all<{
        seq: number;
        username: string;
        event_kind: string;
        detail: string;
        device_prefix: string;
        posted_at: number;
        account_type_at_event: string | null;
        quarantine_until: number | null;
        recovery_method: string | null;
      }>();
    return (r.results ?? []).map((row) => {
      const base: AuditEventRecord = {
        seq: row.seq,
        username: row.username,
        eventKind: row.event_kind as AuditEventRecord["eventKind"],
        detail: row.detail,
        devicePrefix: row.device_prefix,
        postedAt: row.posted_at,
      };
      if (row.account_type_at_event !== null && row.account_type_at_event !== undefined) {
        base.accountTypeAtEvent = row.account_type_at_event as AuditEventRecord["accountTypeAtEvent"];
      }
      if (row.quarantine_until !== null && row.quarantine_until !== undefined) {
        base.quarantineUntil = row.quarantine_until;
      }
      if (row.recovery_method !== null && row.recovery_method !== undefined) {
        base.recoveryMethod = row.recovery_method as AuditEventRecord["recoveryMethod"];
      }
      return base;
    });
  }
}

export class D1UserServiceAliasStorage implements UserServiceAliasStorage {
  constructor(private db: D1Database) {}
  async upsert(rec: UserServiceAliasRecord): Promise<void> {
    const u = rec.username.toLowerCase();
    await this.db
      .prepare(
        `INSERT INTO user_service_aliases (username, service_id, display_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(username, service_id) DO UPDATE SET
           display_label = excluded.display_label,
           updated_at    = excluded.updated_at`,
      )
      .bind(u, rec.serviceId, rec.displayLabel, rec.createdAt, rec.updatedAt)
      .run();
  }
  async get(username: string, serviceId: string): Promise<UserServiceAliasRecord | undefined> {
    const r = await this.db
      .prepare(
        `SELECT username, service_id, display_label, created_at, updated_at
         FROM user_service_aliases WHERE username = ? AND service_id = ?`,
      )
      .bind(username.toLowerCase(), serviceId)
      .first<{ username: string; service_id: string; display_label: string; created_at: number; updated_at: number }>();
    return r ? {
      username: r.username,
      serviceId: r.service_id,
      displayLabel: r.display_label,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    } : undefined;
  }
  async listForUser(username: string): Promise<UserServiceAliasRecord[]> {
    const r = await this.db
      .prepare(
        `SELECT username, service_id, display_label, created_at, updated_at
         FROM user_service_aliases WHERE username = ?`,
      )
      .bind(username.toLowerCase())
      .all<{ username: string; service_id: string; display_label: string; created_at: number; updated_at: number }>();
    return (r.results ?? []).map((row) => ({
      username: row.username,
      serviceId: row.service_id,
      displayLabel: row.display_label,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  async delete(username: string, serviceId: string): Promise<boolean> {
    const r = await this.db
      .prepare("DELETE FROM user_service_aliases WHERE username = ? AND service_id = ?")
      .bind(username.toLowerCase(), serviceId)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
}

export class D1VoiciLinkStorage implements VoiciLinkStorage {
  constructor(private db: D1Database) {}
  async insert(rec: VoiciLinkRecord) {
    try {
      await this.db
        .prepare(
          `INSERT INTO voici_links (code, username, service_id, target_url, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          rec.code,
          rec.username.toLowerCase(),
          rec.serviceId ?? null,
          rec.targetUrl,
          rec.createdAt,
          rec.expiresAt ?? null,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // D1 surfaces UNIQUE constraint failures as "SQLITE_CONSTRAINT_PRIMARYKEY"
      // / "UNIQUE constraint failed: voici_links.code". A `code` collision is
      // the only expected failure (the only UNIQUE/PK constraint on this
      // table); normalize it to the SAME contract reason the InMemory adapter
      // returns ("code already taken") so the two adapters are observably
      // identical and the raw SQLite error never leaks to a caller. Any OTHER
      // failure rethrows — it's a genuine storage fault, not a retryable
      // collision the handler should swallow by minting a fresh code.
      if (/unique constraint|constraint failed/i.test(msg)) {
        return { ok: false as const, reason: "code already taken" };
      }
      throw e;
    }
  }
  async get(code: string): Promise<VoiciLinkRecord | undefined> {
    const r = await this.db
      .prepare(
        `SELECT code, username, service_id, target_url, created_at, expires_at
         FROM voici_links WHERE code = ?`,
      )
      .bind(code)
      .first<{
        code: string; username: string; service_id: string | null;
        target_url: string; created_at: number; expires_at: number | null;
      }>();
    return r ? {
      code: r.code,
      username: r.username,
      ...(r.service_id ? { serviceId: r.service_id } : {}),
      targetUrl: r.target_url,
      createdAt: r.created_at,
      ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
    } : undefined;
  }
  async getByService(username: string, serviceId: string): Promise<VoiciLinkRecord | undefined> {
    const r = await this.db
      .prepare(
        `SELECT code, username, service_id, target_url, created_at, expires_at
         FROM voici_links
         WHERE username = ? AND service_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .bind(username.toLowerCase(), serviceId)
      .first<{
        code: string; username: string; service_id: string | null;
        target_url: string; created_at: number; expires_at: number | null;
      }>();
    return r ? {
      code: r.code,
      username: r.username,
      ...(r.service_id ? { serviceId: r.service_id } : {}),
      targetUrl: r.target_url,
      createdAt: r.created_at,
      ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
    } : undefined;
  }
  async deleteByService(username: string, serviceId: string): Promise<number> {
    const r = await this.db
      .prepare("DELETE FROM voici_links WHERE username = ? AND service_id = ?")
      .bind(username.toLowerCase(), serviceId)
      .run();
    return r.meta?.changes ?? 0;
  }
  async deleteExpired(before: number): Promise<number> {
    const r = await this.db
      .prepare("DELETE FROM voici_links WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .bind(before)
      .run();
    return r.meta?.changes ?? 0;
  }
}

export class D1LuksKeyStorage implements LuksKeyStorage {
  constructor(private db: D1Database) {}
  async putSealed(rec: SealedLuksKeyRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sealed_luks_keys (server_domain, sealed_key_hex, sealed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(server_domain) DO UPDATE SET
           sealed_key_hex = excluded.sealed_key_hex,
           sealed_at = excluded.sealed_at`,
      )
      .bind(rec.serverDomain, rec.sealedKeyHex, rec.sealedAt)
      .run();
  }
  async getSealed(serverDomain: string): Promise<SealedLuksKeyRecord | undefined> {
    const r = await this.db
      .prepare("SELECT * FROM sealed_luks_keys WHERE server_domain = ?")
      .bind(serverDomain)
      .first<{ server_domain: string; sealed_key_hex: string; sealed_at: number }>();
    return r ? { serverDomain: r.server_domain, sealedKeyHex: r.sealed_key_hex, sealedAt: r.sealed_at } : undefined;
  }
  async deleteSealed(serverDomain: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM sealed_luks_keys WHERE server_domain = ?")
      .bind(serverDomain)
      .run();
  }
}

export class D1AutoUnlockLeaseStorage implements AutoUnlockLeaseStorage {
  constructor(private readonly db: D1Database) {}

  async put(rec: AutoUnlockLeaseRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO auto_unlock_leases
           (server_domain, lease_id, unlock_key_hex, multi_use, deposited_at, expires_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(server_domain, lease_id) DO UPDATE SET
           unlock_key_hex = excluded.unlock_key_hex,
           multi_use = excluded.multi_use,
           deposited_at = excluded.deposited_at,
           expires_at = excluded.expires_at`,
      )
      .bind(
        rec.serverDomain,
        rec.leaseId,
        rec.unlockKeyHex,
        rec.multiUse ? 1 : 0,
        rec.depositedAt,
        rec.expiresAt,
      )
      .run();
  }

  async consume(
    serverDomain: string,
    now: number,
  ): Promise<AutoUnlockLeaseRecord | undefined> {
    // Pick the freshest non-expired row. There's a small race when two
    // boot stages call simultaneously — single-server production case
    // where this can't happen, so we accept it. GC of expired rows
    // happens here too so the table doesn't grow unbounded.
    await this.db
      .prepare("DELETE FROM auto_unlock_leases WHERE server_domain = ? AND expires_at <= ?")
      .bind(serverDomain, now)
      .run();
    const r = await this.db
      .prepare(
        "SELECT * FROM auto_unlock_leases WHERE server_domain = ? ORDER BY deposited_at DESC LIMIT 1",
      )
      .bind(serverDomain)
      .first<{
        server_domain: string;
        lease_id: string;
        unlock_key_hex: string;
        multi_use: number;
        deposited_at: number;
        expires_at: number;
      }>();
    if (!r) return undefined;
    if (r.multi_use === 0) {
      await this.db
        .prepare("DELETE FROM auto_unlock_leases WHERE server_domain = ? AND lease_id = ?")
        .bind(serverDomain, r.lease_id)
        .run();
    }
    return {
      serverDomain: r.server_domain,
      leaseId: r.lease_id,
      unlockKeyHex: r.unlock_key_hex,
      multiUse: r.multi_use === 1,
      depositedAt: r.deposited_at,
      expiresAt: r.expires_at,
    };
  }

  async revoke(serverDomain: string, leaseId: string): Promise<boolean> {
    const r = await this.db
      .prepare("DELETE FROM auto_unlock_leases WHERE server_domain = ? AND lease_id = ?")
      .bind(serverDomain, leaseId)
      .run();
    // D1's `meta.changes` reports rows affected. Older bindings may not
    // expose it; fall back to assuming success when undefined.
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }

  async list(
    serverDomain: string,
    now: number,
  ): Promise<AutoUnlockLeaseRecord[]> {
    const r = await this.db
      .prepare(
        "SELECT * FROM auto_unlock_leases WHERE server_domain = ? AND expires_at > ? ORDER BY deposited_at DESC",
      )
      .bind(serverDomain, now)
      .all<{
        server_domain: string;
        lease_id: string;
        unlock_key_hex: string;
        multi_use: number;
        deposited_at: number;
        expires_at: number;
      }>();
    return (r.results ?? []).map((row) => ({
      serverDomain: row.server_domain,
      leaseId: row.lease_id,
      unlockKeyHex: row.unlock_key_hex,
      multiUse: row.multi_use === 1,
      depositedAt: row.deposited_at,
      expiresAt: row.expires_at,
    }));
  }
}

interface SecretMailboxRow {
  server_domain: string;
  username: string;
  request_nonce_hex: string;
  stk_pub_hex: string;
  purpose: string;
  request_issued_at: number;
  request_signature_hex: string;
  device_info_json: string | null;
  posted_at: number;
  expires_at: number;
  last_push_at: number;
  response_sealed_hex: string | null;
  response_issued_at: number | null;
  responded_at: number | null;
  consumed_at: number | null;
}

function rowToSecretMailbox(r: SecretMailboxRow): SecretMailboxRecord {
  return {
    serverDomain: r.server_domain,
    username: r.username,
    requestNonceHex: r.request_nonce_hex,
    stkPubHex: r.stk_pub_hex,
    purpose: r.purpose as SecretMailboxPurpose,
    requestIssuedAt: r.request_issued_at,
    requestSignatureHex: r.request_signature_hex,
    deviceInfoJson: r.device_info_json,
    postedAt: r.posted_at,
    expiresAt: r.expires_at,
    lastPushAt: r.last_push_at,
    responseSealedHex: r.response_sealed_hex,
    responseIssuedAt: r.response_issued_at,
    respondedAt: r.responded_at,
    consumedAt: r.consumed_at,
  };
}

export class D1SecretMailboxStorage implements SecretMailboxStorage {
  constructor(private readonly db: D1Database) {}

  async putRequest(rec: SecretMailboxRecord) {
    // The PRIMARY KEY (server_domain, request_nonce_hex) enforces the
    // single-use nonce at the DB level. We catch the surfaced
    // UNIQUE/PRIMARY-KEY message rather than read-then-write so the
    // reason string is byte-identical to the InMemory adapter.
    try {
      await this.db
        .prepare(
          `INSERT INTO secret_mailbox
             (server_domain, username, request_nonce_hex, stk_pub_hex,
              purpose, request_issued_at, request_signature_hex,
              device_info_json, posted_at, expires_at, last_push_at,
              response_sealed_hex, response_issued_at, responded_at,
              consumed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                   NULL, NULL, NULL, NULL)`,
        )
        .bind(
          rec.serverDomain,
          rec.username.toLowerCase(),
          rec.requestNonceHex,
          rec.stkPubHex.toLowerCase(),
          rec.purpose,
          rec.requestIssuedAt,
          rec.requestSignatureHex,
          rec.deviceInfoJson,
          rec.postedAt,
          rec.expiresAt,
          rec.lastPushAt,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
        return { ok: false as const, reason: "duplicate nonce" };
      }
      throw e;
    }
  }

  async getRequest(serverDomain: string, requestNonceHex: string) {
    const r = await this.db
      .prepare(
        "SELECT * FROM secret_mailbox WHERE server_domain = ?1 AND request_nonce_hex = ?2",
      )
      .bind(serverDomain, requestNonceHex)
      .first<SecretMailboxRow>();
    return r ? rowToSecretMailbox(r) : undefined;
  }

  async listPendingForUser(username: string, now: number, limit = 50) {
    const r = await this.db
      .prepare(
        `SELECT * FROM secret_mailbox
         WHERE username = ?1
           AND expires_at > ?2
           AND response_sealed_hex IS NULL
           AND consumed_at IS NULL
         ORDER BY posted_at DESC
         LIMIT ?3`,
      )
      .bind(username.toLowerCase(), now, Math.max(0, limit))
      .all<SecretMailboxRow>();
    return (r.results ?? []).map(rowToSecretMailbox);
  }

  async touchLastPushAt(serverDomain: string, requestNonceHex: string, at: number) {
    await this.db
      .prepare(
        "UPDATE secret_mailbox SET last_push_at = ?1 WHERE server_domain = ?2 AND request_nonce_hex = ?3",
      )
      .bind(at, serverDomain, requestNonceHex)
      .run();
  }

  async refreshExpiry(serverDomain: string, requestNonceHex: string, expiresAt: number) {
    await this.db
      .prepare(
        "UPDATE secret_mailbox SET expires_at = ?1 WHERE server_domain = ?2 AND request_nonce_hex = ?3",
      )
      .bind(expiresAt, serverDomain, requestNonceHex)
      .run();
  }

  async putResponse(
    serverDomain: string,
    requestNonceHex: string,
    responseSealedHex: string,
    responseIssuedAt: number,
    now: number,
  ) {
    const existing = await this.db
      .prepare(
        "SELECT response_sealed_hex, expires_at FROM secret_mailbox WHERE server_domain = ?1 AND request_nonce_hex = ?2",
      )
      .bind(serverDomain, requestNonceHex)
      .first<{ response_sealed_hex: string | null; expires_at: number }>();
    if (!existing || existing.expires_at <= now) {
      return { ok: false as const, reason: "unknown request" };
    }
    if (existing.response_sealed_hex !== null) {
      return { ok: false as const, reason: "already answered" };
    }
    // Conditional UPDATE — write-once even under a concurrent second
    // device: the WHERE response_sealed_hex IS NULL loses the race.
    const w = await this.db
      .prepare(
        `UPDATE secret_mailbox
         SET response_sealed_hex = ?1, response_issued_at = ?2, responded_at = ?3
         WHERE server_domain = ?4 AND request_nonce_hex = ?5
           AND response_sealed_hex IS NULL`,
      )
      .bind(responseSealedHex, responseIssuedAt, now, serverDomain, requestNonceHex)
      .run();
    const meta = (w as { meta?: { changes?: number } }).meta;
    if (meta?.changes !== undefined && meta.changes === 0) {
      return { ok: false as const, reason: "already answered" };
    }
    return { ok: true as const };
  }

  async consumeResponse(serverDomain: string, requestNonceHex: string, now: number) {
    const r = await this.db
      .prepare(
        "SELECT * FROM secret_mailbox WHERE server_domain = ?1 AND request_nonce_hex = ?2",
      )
      .bind(serverDomain, requestNonceHex)
      .first<SecretMailboxRow>();
    if (!r) return undefined;
    if (r.expires_at <= now) {
      await this.db
        .prepare("DELETE FROM secret_mailbox WHERE server_domain = ?1 AND request_nonce_hex = ?2")
        .bind(serverDomain, requestNonceHex)
        .run();
      return undefined;
    }
    if (r.response_sealed_hex === null || r.consumed_at !== null) return undefined;
    // Single-use release — the conditional WHERE consumed_at IS NULL
    // makes a concurrent double-consume return at-most-once.
    const w = await this.db
      .prepare(
        `UPDATE secret_mailbox SET consumed_at = ?1
         WHERE server_domain = ?2 AND request_nonce_hex = ?3 AND consumed_at IS NULL`,
      )
      .bind(now, serverDomain, requestNonceHex)
      .run();
    const meta = (w as { meta?: { changes?: number } }).meta;
    if (meta?.changes !== undefined && meta.changes === 0) return undefined;
    return rowToSecretMailbox({ ...r, consumed_at: now });
  }
}

interface BoxSealedLeaseRow {
  server_domain: string;
  lease_id: string;
  stk_pub_hex: string;
  sealed_key_hex: string;
  issued_at: number;
  expires_at: number;
  max_uses: number | null;
  uses_consumed: number;
  signature_hex: string;
  deposited_at: number;
}

function rowToBoxSealedLease(r: BoxSealedLeaseRow): BoxSealedLeaseRecord {
  return {
    serverDomain: r.server_domain,
    leaseId: r.lease_id,
    stkPubHex: r.stk_pub_hex,
    sealedKeyHex: r.sealed_key_hex,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    maxUses: r.max_uses,
    usesConsumed: r.uses_consumed,
    signatureHex: r.signature_hex,
    depositedAt: r.deposited_at,
  };
}

export class D1BoxSealedLeaseStorage implements BoxSealedLeaseStorage {
  constructor(private readonly db: D1Database) {}

  async put(rec: BoxSealedLeaseRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO box_sealed_leases
           (server_domain, lease_id, stk_pub_hex, sealed_key_hex,
            issued_at, expires_at, max_uses, uses_consumed,
            signature_hex, deposited_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(server_domain, lease_id) DO UPDATE SET
           stk_pub_hex = excluded.stk_pub_hex,
           sealed_key_hex = excluded.sealed_key_hex,
           issued_at = excluded.issued_at,
           expires_at = excluded.expires_at,
           max_uses = excluded.max_uses,
           uses_consumed = excluded.uses_consumed,
           signature_hex = excluded.signature_hex,
           deposited_at = excluded.deposited_at`,
      )
      .bind(
        rec.serverDomain,
        rec.leaseId,
        rec.stkPubHex.toLowerCase(),
        rec.sealedKeyHex,
        rec.issuedAt,
        rec.expiresAt,
        rec.maxUses,
        rec.usesConsumed,
        rec.signatureHex,
        rec.depositedAt,
      )
      .run();
  }

  async release(serverDomain: string, now: number): Promise<BoxSealedLeaseRecord | undefined> {
    // GC expired + exhausted rows first so they never win the pick.
    await this.db
      .prepare(
        `DELETE FROM box_sealed_leases
         WHERE server_domain = ?1
           AND (expires_at <= ?2 OR (max_uses IS NOT NULL AND uses_consumed >= max_uses))`,
      )
      .bind(serverDomain, now)
      .run();
    const r = await this.db
      .prepare(
        "SELECT * FROM box_sealed_leases WHERE server_domain = ?1 ORDER BY deposited_at DESC LIMIT 1",
      )
      .bind(serverDomain)
      .first<BoxSealedLeaseRow>();
    if (!r) return undefined;
    const nextUses = r.uses_consumed + 1;
    if (r.max_uses !== null && nextUses >= r.max_uses) {
      await this.db
        .prepare("DELETE FROM box_sealed_leases WHERE server_domain = ?1 AND lease_id = ?2")
        .bind(serverDomain, r.lease_id)
        .run();
    } else {
      await this.db
        .prepare(
          "UPDATE box_sealed_leases SET uses_consumed = ?1 WHERE server_domain = ?2 AND lease_id = ?3",
        )
        .bind(nextUses, serverDomain, r.lease_id)
        .run();
    }
    return rowToBoxSealedLease({ ...r, uses_consumed: nextUses });
  }

  async revoke(serverDomain: string, leaseId: string): Promise<boolean> {
    const r = await this.db
      .prepare("DELETE FROM box_sealed_leases WHERE server_domain = ?1 AND lease_id = ?2")
      .bind(serverDomain, leaseId)
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }

  async list(serverDomain: string, now: number): Promise<BoxSealedLeaseRecord[]> {
    const r = await this.db
      .prepare(
        `SELECT * FROM box_sealed_leases
         WHERE server_domain = ?1 AND expires_at > ?2
           AND (max_uses IS NULL OR uses_consumed < max_uses)
         ORDER BY deposited_at DESC`,
      )
      .bind(serverDomain, now)
      .all<BoxSealedLeaseRow>();
    return (r.results ?? []).map(rowToBoxSealedLease);
  }
}

export class D1PendingRePairStorage implements PendingRePairStorage {
  constructor(private readonly db: D1Database) {}

  async initiate(rec: PendingRePairRecord) {
    const key = rec.username.toLowerCase();
    try {
      // v1.2 — grace_seconds + totp_required + totp_proof_consumed are
      // captured explicitly so a row crossing the cascade boundary
      // keeps its original grace (the migration default of 86_400
      // matches v1.1 behavior; Phase 2 widens to 604_800 for single-
      // device callers). alerts_fired_bitmap defaults to 1 (bit 0 =
      // T+0 fired-on-initiate) when callers stamp it; otherwise the
      // column DEFAULT 0 takes over and the cron scheduler will fire
      // the T+0 alert + OR-in the bit on its next pass.
      await this.db
        .prepare(
          `INSERT INTO pending_re_pairs
             (username, new_irk_pub_hex, old_irk_pub_hex,
              initiated_at, completes_at, objected_at,
              grace_seconds, totp_required, totp_proof_consumed,
              alerts_fired_bitmap)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .bind(
          key,
          rec.newIrkPubHex,
          rec.oldIrkPubHex,
          rec.initiatedAt,
          rec.completesAt,
          rec.graceSeconds ?? 86_400,
          rec.totpRequired ? 1 : 0,
          rec.totpProofConsumed ? 1 : 0,
          rec.alertsFiredBitmap ?? 0,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      // PK conflict: an existing pending row blocks initiation.
      return { ok: false as const, reason: "re-pair already pending" };
    }
  }

  async get(username: string) {
    const r = await this.db
      .prepare("SELECT * FROM pending_re_pairs WHERE username = ?")
      .bind(username.toLowerCase())
      .first<RawPendingRePairRow>();
    if (!r) return undefined;
    return rawPendingRePairToRecord(r);
  }

  async object(username: string, at: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE pending_re_pairs SET objected_at = ? WHERE username = ? AND objected_at IS NULL")
      .bind(at, username.toLowerCase())
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }

  async delete(username: string): Promise<boolean> {
    const r = await this.db
      .prepare("DELETE FROM pending_re_pairs WHERE username = ?")
      .bind(username.toLowerCase())
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }

  async listActive(limit = 100): Promise<PendingRePairRecord[]> {
    // Phase 2's alert scheduler only cares about rows that haven't
    // been objected to — an objected row's grace is moot. Caller
    // (schedulePendingRePairAlerts) further filters by alert-due-at
    // time vs. its internal now() against the row's initiatedAt
    // + threshold offsets.
    const r = await this.db
      .prepare(
        "SELECT * FROM pending_re_pairs WHERE objected_at IS NULL ORDER BY initiated_at ASC LIMIT ?",
      )
      .bind(limit)
      .all<RawPendingRePairRow>();
    return (r.results ?? []).map(rawPendingRePairToRecord);
  }

  async orInAlertsFiredBit(username: string, bit: number): Promise<number> {
    // bit is a power-of-2 offset (1, 2, 4, 8, 16). SQLite supports
    // the bitwise-OR operator (`|`) inside UPDATE expressions, so
    // the OR-in is atomic at the database without a read-modify-write
    // round-trip. Reading the post-state needs a follow-up SELECT —
    // D1 does not yet support `RETURNING`.
    await this.db
      .prepare(
        "UPDATE pending_re_pairs SET alerts_fired_bitmap = alerts_fired_bitmap | ? WHERE username = ?",
      )
      .bind(bit, username.toLowerCase())
      .run();
    const after = await this.db
      .prepare("SELECT alerts_fired_bitmap FROM pending_re_pairs WHERE username = ?")
      .bind(username.toLowerCase())
      .first<{ alerts_fired_bitmap: number | null }>();
    return after?.alerts_fired_bitmap ?? 0;
  }
}

interface RawPendingRePairRow {
  username: string;
  new_irk_pub_hex: string;
  old_irk_pub_hex: string;
  initiated_at: number;
  completes_at: number;
  objected_at: number | null;
  grace_seconds?: number | null;
  totp_required?: number | null;
  totp_proof_consumed?: number | null;
  alerts_fired_bitmap?: number | null;
}

function rawPendingRePairToRecord(r: RawPendingRePairRow): PendingRePairRecord {
  return {
    username: r.username,
    newIrkPubHex: r.new_irk_pub_hex,
    oldIrkPubHex: r.old_irk_pub_hex,
    initiatedAt: r.initiated_at,
    completesAt: r.completes_at,
    ...(r.objected_at != null ? { objectedAt: r.objected_at } : {}),
    graceSeconds: r.grace_seconds ?? 86_400,
    totpRequired: r.totp_required === 1,
    totpProofConsumed: r.totp_proof_consumed === 1,
    alertsFiredBitmap: r.alerts_fired_bitmap ?? 0,
  };
}

export class D1WebauthnRecoveryStorage implements WebauthnRecoveryStorage {
  constructor(private readonly db: D1Database) {}

  async upsert(rec: WebauthnRecoveryRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO webauthn_recovery_records
           (username, credential_id_hex, wrapped_umk_b64, irk_pub_hex,
            fetch_token_hash, prf_salt_hash, wrapped_acme_account_key_b64,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(username) DO UPDATE SET
           credential_id_hex = excluded.credential_id_hex,
           wrapped_umk_b64 = excluded.wrapped_umk_b64,
           irk_pub_hex = excluded.irk_pub_hex,
           fetch_token_hash = excluded.fetch_token_hash,
           prf_salt_hash = excluded.prf_salt_hash,
           wrapped_acme_account_key_b64 = excluded.wrapped_acme_account_key_b64,
           updated_at = excluded.updated_at`,
      )
      .bind(
        rec.username.toLowerCase(),
        rec.credentialIdHex,
        rec.wrappedUmkB64,
        rec.irkPubHex,
        rec.fetchTokenHashHex ?? null,
        rec.prfSaltHashHex ?? null,
        rec.wrappedAcmeAccountKeyB64 ?? null,
        rec.createdAt,
        rec.updatedAt,
      )
      .run();
  }

  async get(username: string): Promise<WebauthnRecoveryRecord | undefined> {
    const r = await this.db
      .prepare("SELECT * FROM webauthn_recovery_records WHERE username = ?")
      .bind(username.toLowerCase())
      .first<{
        username: string;
        credential_id_hex: string;
        wrapped_umk_b64: string;
        irk_pub_hex: string;
        fetch_token_hash: string | null;
        prf_salt_hash: string | null;
        wrapped_acme_account_key_b64: string | null;
        created_at: number;
        updated_at: number;
      }>();
    if (!r) return undefined;
    return {
      username: r.username,
      credentialIdHex: r.credential_id_hex,
      wrappedUmkB64: r.wrapped_umk_b64,
      irkPubHex: r.irk_pub_hex,
      ...(r.fetch_token_hash ? { fetchTokenHashHex: r.fetch_token_hash } : {}),
      ...(r.prf_salt_hash ? { prfSaltHashHex: r.prf_salt_hash } : {}),
      ...(r.wrapped_acme_account_key_b64
        ? { wrappedAcmeAccountKeyB64: r.wrapped_acme_account_key_b64 }
        : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async delete(username: string): Promise<boolean> {
    const r = await this.db
      .prepare("DELETE FROM webauthn_recovery_records WHERE username = ?")
      .bind(username.toLowerCase())
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
}

export class D1MarketplaceStorage implements MarketplaceStorage {
  constructor(private readonly db: D1Database) {}

  async upsert(rec: MarketplaceListingRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO marketplace_listings (
           creator, slug, name, tagline, description_md, category, tags_csv,
           canonical_url, manifest_hash_hex, screenshot_keys_json, status,
           scan_grade, scan_report_key, scan_completed_at, featured_until,
           rank_score, install_count, public_distribution, listed_at, updated_at,
           irk_signature_hex
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(creator, slug) DO UPDATE SET
           name=excluded.name,
           tagline=excluded.tagline,
           description_md=excluded.description_md,
           category=excluded.category,
           tags_csv=excluded.tags_csv,
           canonical_url=excluded.canonical_url,
           manifest_hash_hex=excluded.manifest_hash_hex,
           screenshot_keys_json=excluded.screenshot_keys_json,
           status=excluded.status,
           public_distribution=excluded.public_distribution,
           updated_at=excluded.updated_at,
           irk_signature_hex=excluded.irk_signature_hex`,
      )
      .bind(
        rec.creator, rec.slug, rec.name, rec.tagline, rec.descriptionMd,
        rec.category, rec.tagsCsv, rec.canonicalUrl, rec.manifestHashHex,
        rec.screenshotKeysJson, rec.status,
        rec.scanGrade ?? null, rec.scanReportKey ?? null, rec.scanCompletedAt ?? null,
        rec.featuredUntil ?? null,
        rec.rankScore, rec.installCount, rec.publicDistribution ? 1 : 0,
        rec.listedAt, rec.updatedAt, rec.irkSignatureHex,
      )
      .run();
  }

  async get(creator: string, slug: string): Promise<MarketplaceListingRecord | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM marketplace_listings WHERE creator = ? AND slug = ?`)
      .bind(creator, slug)
      .first<RawMarketplaceRow>();
    return row ? rowToRecord(row) : undefined;
  }

  async search(q: MarketplaceSearchQuery): Promise<MarketplaceListingRecord[]> {
    const limit = Math.min(q.limit ?? 30, 100);
    const offset = q.offset ?? 0;
    const wheres: string[] = [`status = 'listed'`];
    const args: unknown[] = [];
    if (q.category) {
      wheres.push(`category = ?`);
      args.push(q.category);
    }
    if (q.verifiedOnly) {
      wheres.push(`scan_grade IS NOT NULL`);
    }
    if (q.text) {
      wheres.push(`(name LIKE ? OR tagline LIKE ? OR tags_csv LIKE ?)`);
      const like = `%${q.text.toLowerCase()}%`;
      args.push(like, like, like);
    }
    const order =
      q.sort === "newest" ? "listed_at DESC" :
      q.sort === "name" ? "name ASC" :
      "rank_score DESC, install_count DESC";
    const sql = `SELECT * FROM marketplace_listings WHERE ${wheres.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`;
    args.push(limit, offset);
    const result = await this.db.prepare(sql).bind(...args).all<RawMarketplaceRow>();
    return (result.results ?? []).map(rowToRecord);
  }

  async remove(creator: string, slug: string): Promise<void> {
    await this.db
      .prepare(`UPDATE marketplace_listings SET status = 'removed', updated_at = ? WHERE creator = ? AND slug = ?`)
      .bind(Date.now(), creator, slug)
      .run();
  }

  async recordInstall(creator: string, slug: string): Promise<void> {
    await this.db
      .prepare(`UPDATE marketplace_listings SET install_count = install_count + 1, updated_at = ? WHERE creator = ? AND slug = ?`)
      .bind(Date.now(), creator, slug)
      .run();
  }
  async setScanResult(
    creator: string,
    slug: string,
    grade: "A" | "B" | "C" | "D" | "F",
    reportKey: string,
    completedAt: number,
  ): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE marketplace_listings
           SET scan_grade = ?, scan_report_key = ?, scan_completed_at = ?, updated_at = ?
         WHERE creator = ? AND slug = ?`,
      )
      .bind(grade, reportKey, completedAt, Date.now(), creator, slug)
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async listNeedingScan(staleBeforeMs: number): Promise<MarketplaceListingRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM marketplace_listings
           WHERE status = 'listed'
             AND (scan_completed_at IS NULL OR scan_completed_at < ?)
         ORDER BY scan_completed_at ASC NULLS FIRST, listed_at ASC`,
      )
      .bind(staleBeforeMs)
      .all<RawMarketplaceRow>();
    return (result.results ?? []).map(rowToRecord);
  }
}

interface RawMarketplaceRow {
  creator: string; slug: string; name: string; tagline: string;
  description_md: string; category: string; tags_csv: string;
  canonical_url: string; manifest_hash_hex: string; screenshot_keys_json: string;
  status: string; scan_grade: string | null; scan_report_key: string | null;
  scan_completed_at: number | null; featured_until: number | null;
  rank_score: number; install_count: number; public_distribution: number;
  listed_at: number; updated_at: number; irk_signature_hex: string;
}

function rowToRecord(r: RawMarketplaceRow): MarketplaceListingRecord {
  return {
    creator: r.creator,
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    descriptionMd: r.description_md,
    category: r.category,
    tagsCsv: r.tags_csv,
    canonicalUrl: r.canonical_url,
    manifestHashHex: r.manifest_hash_hex,
    screenshotKeysJson: r.screenshot_keys_json,
    status: r.status as "listed" | "private" | "removed",
    scanGrade: (r.scan_grade ?? undefined) as "A" | "B" | "C" | "D" | "F" | undefined,
    scanReportKey: r.scan_report_key ?? undefined,
    scanCompletedAt: r.scan_completed_at ?? undefined,
    featuredUntil: r.featured_until ?? undefined,
    rankScore: r.rank_score,
    installCount: r.install_count,
    publicDistribution: r.public_distribution !== 0,
    listedAt: r.listed_at,
    updatedAt: r.updated_at,
    irkSignatureHex: r.irk_signature_hex,
  };
}

export class D1PushTokenStorage implements PushTokenStorage {
  constructor(private readonly db: D1Database) {}
  async put(rec: PushTokenRecord): Promise<void> {
    // v1.2 — quarantine_until is written on insert (default 0 =
    // trusted-from-birth, matching the SQL column default and the
    // post-migration pre-existing rows). ON CONFLICT does NOT
    // overwrite quarantine_until on re-put: a benign push_token
    // refresh must not silently clear a 14-day quarantine. Phase 2's
    // device-admit handler bumps quarantine_until via a dedicated
    // UPDATE.
    await this.db.prepare(
      `INSERT INTO push_tokens (token_id, username, platform, provider_token, push_x25519_pub_hex, registration_signature_hex, label, registered_at, last_seen_at, quarantine_until, quarantine_alerts_fired_bitmap)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(token_id) DO UPDATE SET
         provider_token=excluded.provider_token,
         push_x25519_pub_hex=excluded.push_x25519_pub_hex,
         registration_signature_hex=excluded.registration_signature_hex,
         label=excluded.label,
         last_seen_at=excluded.last_seen_at`,
    ).bind(
      rec.tokenId, rec.username, rec.platform, rec.providerToken,
      rec.pushX25519PubHex, rec.registrationSignatureHex,
      rec.label,
      rec.registeredAt, rec.lastSeenAt,
      rec.quarantineUntil ?? 0,
      rec.quarantineAlertsFiredBitmap ?? 0,
    ).run();
  }
  async get(tokenId: string): Promise<PushTokenRecord | undefined> {
    const r = await this.db.prepare(`SELECT * FROM push_tokens WHERE token_id = ?`).bind(tokenId).first<RawPushRow>();
    return r ? pushRowToRecord(r) : undefined;
  }
  async listByUser(username: string): Promise<PushTokenRecord[]> {
    const r = await this.db.prepare(`SELECT * FROM push_tokens WHERE username = ?`).bind(username).all<RawPushRow>();
    return (r.results ?? []).map(pushRowToRecord);
  }
  async remove(tokenId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM push_tokens WHERE token_id = ?`).bind(tokenId).run();
  }
  async touchLastSeen(tokenId: string, at: number): Promise<void> {
    await this.db.prepare(`UPDATE push_tokens SET last_seen_at = ? WHERE token_id = ?`).bind(at, tokenId).run();
  }
  async setQuarantineUntil(tokenId: string, untilMs: number): Promise<boolean> {
    // Direct UPDATE — D1 reports affected-row count via meta.changes.
    // We deliberately don't constrain on the existing value: callers
    // (re-pair completion handler, future device-add path) want
    // last-writer-wins semantics so a longer quarantine extends the
    // window, not just replaces it. If clamp-only behavior is ever
    // wanted, callers can read-modify-write at the call site.
    const r = await this.db
      .prepare(`UPDATE push_tokens SET quarantine_until = ? WHERE token_id = ?`)
      .bind(untilMs, tokenId)
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async listQuarantined(now: number, limit = 100): Promise<PushTokenRecord[]> {
    const r = await this.db
      .prepare(
        `SELECT * FROM push_tokens WHERE quarantine_until > ? ORDER BY registered_at ASC LIMIT ?`,
      )
      .bind(now, Math.max(0, limit))
      .all<RawPushRow>();
    return (r.results ?? []).map(pushRowToRecord);
  }
  async orInQuarantineAlertBit(tokenId: string, bit: number): Promise<number> {
    // SQLite bitwise-OR in a single UPDATE keeps the OR atomic at the
    // database — concurrent cron ticks can't lose a bit. RETURNING
    // gives the post-write value without a second SELECT.
    const row = await this.db
      .prepare(
        `UPDATE push_tokens
         SET quarantine_alerts_fired_bitmap = quarantine_alerts_fired_bitmap | ?
         WHERE token_id = ?
         RETURNING quarantine_alerts_fired_bitmap AS bm`,
      )
      .bind(bit, tokenId)
      .first<{ bm: number }>();
    return row?.bm ?? 0;
  }
}

interface RawPushRow {
  token_id: string; username: string; platform: string; provider_token: string;
  push_x25519_pub_hex: string; registration_signature_hex: string;
  label: string | null;
  registered_at: number; last_seen_at: number;
  // v1.2 — nullable so a SELECT against a pre-migration database
  // decodes safely; rowToRecord defaults absence to 0.
  quarantine_until?: number | null;
  // Phase 3b — nullable for the same pre-migration safety.
  quarantine_alerts_fired_bitmap?: number | null;
}
function pushRowToRecord(r: RawPushRow): PushTokenRecord {
  return {
    tokenId: r.token_id,
    username: r.username,
    platform: r.platform as "apns" | "fcm" | "webpush",
    providerToken: r.provider_token,
    pushX25519PubHex: r.push_x25519_pub_hex,
    registrationSignatureHex: r.registration_signature_hex,
    label: r.label ?? "",
    registeredAt: r.registered_at,
    lastSeenAt: r.last_seen_at,
    quarantineUntil: r.quarantine_until ?? 0,
    quarantineAlertsFiredBitmap: r.quarantine_alerts_fired_bitmap ?? 0,
  };
}

export class D1LlmPromoStorage implements LlmPromoStorage {
  constructor(private readonly db: D1Database) {}
  async getDaily(u: string, d: number): Promise<LlmPromoUsageRecord | undefined> {
    const r = await this.db.prepare(`SELECT * FROM llm_promo_usage WHERE username = ? AND day = ?`).bind(u, d).first<{
      username: string; day: number; daily_count: number; daily_input_tokens: number; daily_output_tokens: number;
    }>();
    return r ? { username: r.username, day: r.day, dailyCount: r.daily_count, dailyInputTokens: r.daily_input_tokens, dailyOutputTokens: r.daily_output_tokens } : undefined;
  }
  async bumpDaily(u: string, d: number, i: number, o: number): Promise<LlmPromoUsageRecord> {
    await this.db.prepare(
      `INSERT INTO llm_promo_usage (username, day, daily_count, daily_input_tokens, daily_output_tokens)
       VALUES (?,?,1,?,?)
       ON CONFLICT(username, day) DO UPDATE SET
         daily_count = daily_count + 1,
         daily_input_tokens = daily_input_tokens + excluded.daily_input_tokens,
         daily_output_tokens = daily_output_tokens + excluded.daily_output_tokens`,
    ).bind(u, d, i, o).run();
    return (await this.getDaily(u, d))!;
  }
  async getLifetime(u: string): Promise<LlmPromoLifetimeRecord | undefined> {
    const r = await this.db.prepare(`SELECT * FROM llm_promo_lifetime WHERE username = ?`).bind(u).first<{
      username: string; lifetime_count: number; lifetime_input_tokens: number; lifetime_output_tokens: number; override_json: string | null; updated_at: number;
    }>();
    return r ? {
      username: r.username,
      lifetimeCount: r.lifetime_count,
      lifetimeInputTokens: r.lifetime_input_tokens,
      lifetimeOutputTokens: r.lifetime_output_tokens,
      overrideJson: r.override_json ?? undefined,
      updatedAt: r.updated_at,
    } : undefined;
  }
  async bumpLifetime(u: string, i: number, o: number, now: number): Promise<LlmPromoLifetimeRecord> {
    await this.db.prepare(
      `INSERT INTO llm_promo_lifetime (username, lifetime_count, lifetime_input_tokens, lifetime_output_tokens, updated_at)
       VALUES (?,1,?,?,?)
       ON CONFLICT(username) DO UPDATE SET
         lifetime_count = lifetime_count + 1,
         lifetime_input_tokens = lifetime_input_tokens + excluded.lifetime_input_tokens,
         lifetime_output_tokens = lifetime_output_tokens + excluded.lifetime_output_tokens,
         updated_at = excluded.updated_at`,
    ).bind(u, i, o, now).run();
    return (await this.getLifetime(u))!;
  }
}

export class D1TierStorage implements TierStorage {
  constructor(private readonly db: D1Database) {}
  async get(u: string): Promise<TierSubscriptionRecord | undefined> {
    const r = await this.db.prepare(`SELECT * FROM tier_subscriptions WHERE username = ?`).bind(u).first<{
      username: string; tier: string; stripe_customer_id: string | null; stripe_subscription_id: string | null;
      current_period_end: number | null; irk_receipt_hex: string | null; irk_signature_hex: string | null;
      updated_at: number;
    }>();
    return r ? {
      username: r.username,
      tier: r.tier as "free" | "hobby" | "maker",
      stripeCustomerId: r.stripe_customer_id ?? undefined,
      stripeSubscriptionId: r.stripe_subscription_id ?? undefined,
      currentPeriodEnd: r.current_period_end ?? undefined,
      irkReceiptHex: r.irk_receipt_hex ?? undefined,
      irkSignatureHex: r.irk_signature_hex ?? undefined,
      updatedAt: r.updated_at,
    } : undefined;
  }
  async put(rec: TierSubscriptionRecord): Promise<void> {
    await this.db.prepare(
      `INSERT INTO tier_subscriptions (username, tier, stripe_customer_id, stripe_subscription_id, current_period_end, irk_receipt_hex, irk_signature_hex, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(username) DO UPDATE SET
         tier = excluded.tier,
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         current_period_end = excluded.current_period_end,
         irk_receipt_hex = excluded.irk_receipt_hex,
         irk_signature_hex = excluded.irk_signature_hex,
         updated_at = excluded.updated_at`,
    ).bind(
      rec.username, rec.tier, rec.stripeCustomerId ?? null, rec.stripeSubscriptionId ?? null,
      rec.currentPeriodEnd ?? null, rec.irkReceiptHex ?? null, rec.irkSignatureHex ?? null,
      rec.updatedAt,
    ).run();
  }
}

/** Public-egress metering counter (migration 0051). Standalone — constructed
 *  on demand (like D1NonceStore), not part of the D1Storage aggregate. */
export class D1UsageStorage implements UsageStorage {
  constructor(private readonly db: D1Database) {}

  async addEgress(username: string, period: string, bytes: number, now: number): Promise<number> {
    const delta = Math.max(0, Math.floor(bytes));
    await this.db
      .prepare(
        `INSERT INTO usage_counters (username, period, bytes_egress, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(username, period) DO UPDATE SET
           bytes_egress = bytes_egress + excluded.bytes_egress,
           updated_at   = excluded.updated_at`,
      )
      .bind(username, period, delta, now)
      .run();
    const r = await this.get(username, period);
    return r?.bytesEgress ?? 0;
  }

  async get(username: string, period: string): Promise<UsageCounterRecord | undefined> {
    const r = await this.db
      .prepare(`SELECT * FROM usage_counters WHERE username = ? AND period = ?`)
      .bind(username, period)
      .first<{ username: string; period: string; bytes_egress: number; updated_at: number }>();
    return r
      ? { username: r.username, period: r.period, bytesEgress: r.bytes_egress, updatedAt: r.updated_at }
      : undefined;
  }
}

/** Prepaid Pro vouchers (migration 0052). Standalone — constructed on demand,
 *  not part of the D1Storage aggregate. */
export class D1VoucherStorage implements VoucherStorage {
  constructor(private readonly db: D1Database) {}

  async create(rec: VoucherRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.db
        .prepare(
          `INSERT INTO vouchers (code_hash, tier, duration_days, created_at) VALUES (?,?,?,?)`,
        )
        .bind(rec.codeHash, rec.tier, rec.durationDays, rec.createdAt)
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/unique constraint|constraint failed/i.test(msg)) {
        return { ok: false as const, reason: "voucher code already exists" };
      }
      throw e;
    }
  }

  async get(codeHash: string): Promise<VoucherRecord | undefined> {
    const r = await this.db
      .prepare(`SELECT * FROM vouchers WHERE code_hash = ?`)
      .bind(codeHash)
      .first<{
        code_hash: string;
        tier: string;
        duration_days: number;
        created_at: number;
        redeemed_at: number | null;
        redeemed_by: string | null;
      }>();
    return r
      ? {
          codeHash: r.code_hash,
          tier: r.tier as VoucherRecord["tier"],
          durationDays: r.duration_days,
          createdAt: r.created_at,
          redeemedAt: r.redeemed_at ?? undefined,
          redeemedBy: r.redeemed_by ?? undefined,
        }
      : undefined;
  }

  async redeem(codeHash: string, username: string, now: number): Promise<boolean> {
    // Atomic single-use: the WHERE redeemed_at IS NULL means only the first
    // concurrent redemption changes a row.
    const r = await this.db
      .prepare(
        `UPDATE vouchers SET redeemed_at = ?, redeemed_by = ? WHERE code_hash = ? AND redeemed_at IS NULL`,
      )
      .bind(now, username, codeHash)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
}

export class D1EntitlementRevocationStorage implements EntitlementRevocationStorage {
  constructor(private readonly db: D1Database) {}
  async putIfNewer(rec: EntitlementRevocationListRecord) {
    const existing = await this.get(rec.username);
    if (existing && rec.issuedAt <= existing.issuedAt) {
      return { stored: existing, accepted: false };
    }
    await this.db
      .prepare(
        `INSERT INTO entitlement_revocation_lists
            (username, cert_ids_json, irk_signature_hex, issued_at, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(username) DO UPDATE SET
           cert_ids_json     = excluded.cert_ids_json,
           irk_signature_hex = excluded.irk_signature_hex,
           issued_at         = excluded.issued_at,
           updated_at        = excluded.updated_at`,
      )
      .bind(rec.username, rec.certIdsJson, rec.irkSignatureHex, rec.issuedAt, rec.updatedAt)
      .run();
    return { stored: { ...rec }, accepted: true };
  }
  async get(username: string) {
    const r = await this.db
      .prepare(
        `SELECT username, cert_ids_json, irk_signature_hex, issued_at, updated_at
           FROM entitlement_revocation_lists
          WHERE username = ?`,
      )
      .bind(username)
      .first<{
        username: string;
        cert_ids_json: string;
        irk_signature_hex: string;
        issued_at: number;
        updated_at: number;
      }>();
    if (!r) return undefined;
    return {
      username: r.username,
      certIdsJson: r.cert_ids_json,
      irkSignatureHex: r.irk_signature_hex,
      issuedAt: r.issued_at,
      updatedAt: r.updated_at,
    };
  }
}

export class D1UserIdentityRecordStorage implements UserIdentityRecordStorage {
  constructor(private readonly db: D1Database) {}

  async putIfNewer(rec: UserIdentityRecord) {
    const existing = await this.get(rec.usernameHash);
    if (existing && rec.blobVersion <= existing.blobVersion) {
      return { stored: existing, accepted: false };
    }
    await this.db
      .prepare(
        `INSERT INTO user_identity_records
            (username_hash, encrypted_blob, authorized_signers_json, blob_version, signature_hex, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(username_hash) DO UPDATE SET
           encrypted_blob          = excluded.encrypted_blob,
           authorized_signers_json = excluded.authorized_signers_json,
           blob_version            = excluded.blob_version,
           signature_hex           = excluded.signature_hex,
           updated_at              = excluded.updated_at`,
      )
      .bind(
        rec.usernameHash,
        rec.encryptedBlob,
        JSON.stringify(rec.authorizedSigners),
        rec.blobVersion,
        rec.signatureHex,
        rec.updatedAt,
      )
      .run();
    return {
      stored: {
        ...rec,
        encryptedBlob: new Uint8Array(rec.encryptedBlob),
        authorizedSigners: [...rec.authorizedSigners],
      },
      accepted: true,
    };
  }

  async get(usernameHash: string): Promise<UserIdentityRecord | undefined> {
    const r = await this.db
      .prepare(
        `SELECT username_hash, encrypted_blob, authorized_signers_json,
                blob_version, signature_hex, updated_at
           FROM user_identity_records WHERE username_hash = ?`,
      )
      .bind(usernameHash)
      .first<{
        username_hash: string;
        encrypted_blob: ArrayBuffer | Uint8Array;
        authorized_signers_json: string;
        blob_version: number;
        signature_hex: string;
        updated_at: number;
      }>();
    if (!r) return undefined;
    const raw = r.encrypted_blob;
    const blob = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw);
    let signers: string[] = [];
    try {
      const parsed = JSON.parse(r.authorized_signers_json);
      if (Array.isArray(parsed)) signers = parsed.filter((s) => typeof s === "string");
    } catch {
      // empty list — defensive; corrupt JSON shouldn't crash a fetch
    }
    return {
      usernameHash: r.username_hash,
      encryptedBlob: blob,
      authorizedSigners: signers,
      blobVersion: r.blob_version,
      signatureHex: r.signature_hex,
      updatedAt: r.updated_at,
    };
  }
}

export class D1DaemonStatusStorage implements DaemonStatusStorage {
  constructor(private db: D1Database) {}
  async put(rec: DaemonStatusRecord) {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO daemon_status
         (server_domain, cert_sha256, cert_valid_until, cert_issuer,
          services_served_json, last_reported, report_json, signature_hex)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        rec.serverDomain.toLowerCase(),
        rec.certSha256,
        rec.certValidUntil,
        rec.certIssuer,
        rec.servicesServedJson,
        rec.lastReported,
        rec.reportJson ?? null,
        rec.signatureHex ?? null,
      )
      .run();
  }
  async get(serverDomain: string) {
    const r = await this.db
      .prepare(`SELECT * FROM daemon_status WHERE server_domain = ?1`)
      .bind(serverDomain.toLowerCase())
      .first<{
        server_domain: string;
        cert_sha256: string | null;
        cert_valid_until: number | null;
        cert_issuer: string | null;
        services_served_json: string;
        last_reported: number;
        report_json: string | null;
        signature_hex: string | null;
      }>();
    if (!r) return undefined;
    return {
      serverDomain: r.server_domain,
      certSha256: r.cert_sha256,
      certValidUntil: r.cert_valid_until,
      certIssuer: r.cert_issuer,
      servicesServedJson: r.services_served_json,
      lastReported: r.last_reported,
      reportJson: r.report_json ?? null,
      signatureHex: r.signature_hex ?? null,
    };
  }
  async listForUser(username: string) {
    // SQLite LIKE with a placeholder for the username segment.
    // server_domain shape: "<server>.<username>.flagship.services"
    const pattern = `%.${username.toLowerCase()}.flagship.services`;
    const r = await this.db
      .prepare(`SELECT * FROM daemon_status WHERE server_domain LIKE ?1`)
      .bind(pattern)
      .all<{
        server_domain: string;
        cert_sha256: string | null;
        cert_valid_until: number | null;
        cert_issuer: string | null;
        services_served_json: string;
        last_reported: number;
        report_json: string | null;
        signature_hex: string | null;
      }>();
    return (r.results ?? []).map((row) => ({
      serverDomain: row.server_domain,
      certSha256: row.cert_sha256,
      certValidUntil: row.cert_valid_until,
      certIssuer: row.cert_issuer,
      servicesServedJson: row.services_served_json,
      lastReported: row.last_reported,
      reportJson: row.report_json ?? null,
      signatureHex: row.signature_hex ?? null,
    }));
  }
}

interface CustomDomainOrderRow {
  service_id: string;
  user_id: string;
  fqdn: string;
  status: string;
  pod_canonical?: string | null;
  last_changed: number;
  fail_count: number;
  created_at: number;
  updated_at: number;
}
function rowToCustomDomainOrder(r: CustomDomainOrderRow): CustomDomainOrderRecord {
  return {
    serviceId: r.service_id,
    userId: r.user_id,
    fqdn: r.fqdn,
    status: r.status as CustomDomainOrderRecord["status"],
    podCanonical: r.pod_canonical ?? undefined,
    lastChanged: r.last_changed,
    failCount: r.fail_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class D1CustomDomainOrderStorage implements CustomDomainOrderStorage {
  constructor(private db: D1Database) {}
  async get(userId: string, serviceId: string) {
    const r = await this.db
      .prepare("SELECT * FROM custom_domain_orders WHERE user_id = ? AND service_id = ?")
      .bind(userId.toLowerCase(), serviceId)
      .first<CustomDomainOrderRow>();
    return r ? rowToCustomDomainOrder(r) : undefined;
  }
  async upsert(rec: CustomDomainOrderRecord) {
    const uid = rec.userId.toLowerCase();
    // Destructive replace: ON CONFLICT overwrites every field — a new
    // request irreversibly supersedes any prior order for the pair.
    await this.db
      .prepare(
        "INSERT INTO custom_domain_orders " +
          "(service_id, user_id, fqdn, status, pod_canonical, last_changed, fail_count, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(service_id, user_id) DO UPDATE SET " +
          "fqdn=excluded.fqdn, status=excluded.status, " +
          "pod_canonical=excluded.pod_canonical, " +
          "last_changed=excluded.last_changed, fail_count=excluded.fail_count, " +
          "updated_at=excluded.updated_at",
      )
      .bind(
        rec.serviceId, uid, rec.fqdn, rec.status, rec.podCanonical ?? null,
        rec.lastChanged, rec.failCount, rec.createdAt, rec.updatedAt,
      )
      .run();
    return { ...rec, userId: uid };
  }
  async setStatus(
    userId: string,
    serviceId: string,
    fqdn: string,
    status: CustomDomainOrderRecord["status"],
    at: number,
  ) {
    // CAS on fqdn so a status write from a stale verifier can't clobber
    // a row a newer request already replaced.
    const failBump = status === "failed" ? 1 : 0;
    const r = await this.db
      .prepare(
        "UPDATE custom_domain_orders SET status = ?, updated_at = ?, " +
          "fail_count = fail_count + ? " +
          "WHERE user_id = ? AND service_id = ? AND fqdn = ?",
      )
      .bind(status, at, failBump, userId.toLowerCase(), serviceId, fqdn)
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async listActive() {
    return this.listByStatus("active");
  }
  async listByStatus(status: CustomDomainOrderRecord["status"]) {
    const r = await this.db
      .prepare("SELECT * FROM custom_domain_orders WHERE status = ?")
      .bind(status)
      .all<CustomDomainOrderRow>();
    return r.results.map(rowToCustomDomainOrder);
  }
}

export class D1DemoLlmLedgerStorage implements DemoLlmLedgerStorage {
  constructor(private db: D1Database) {}
  async append(username: string, grantedAt: number, tokens: number, pruneBefore: number) {
    await this.db
      .prepare("INSERT INTO demo_llm_ledger (username, granted_at, tokens) VALUES (?, ?, ?)")
      .bind(username, grantedAt, tokens)
      .run();
    await this.db
      .prepare("DELETE FROM demo_llm_ledger WHERE username = ? AND granted_at < ?")
      .bind(username, pruneBefore)
      .run();
  }
  async sumSince(username: string, sinceMs: number) {
    const r = await this.db
      .prepare("SELECT COALESCE(SUM(tokens), 0) AS total FROM demo_llm_ledger WHERE username = ? AND granted_at >= ?")
      .bind(username, sinceMs)
      .first<{ total: number }>();
    return r?.total ?? 0;
  }
}

interface InstallPolicyFanoutRow {
  server_domain: string;
  username: string;
  registered_at: number;
  fanout_count: number;
  notified_at: number;
}

export class D1InstallPolicyFanoutStorage
  implements InstallPolicyFanoutStorage
{
  constructor(private db: D1Database) {}
  async recordOnce(rec: InstallPolicyFanoutRecord) {
    // INSERT OR IGNORE on the server_domain PK: a retry of a one-shot
    // registration is a no-op insert ⇒ meta.changes === 0 ⇒ the
    // caller must NOT re-notify the device family.
    const r = await this.db
      .prepare(
        "INSERT OR IGNORE INTO install_policy_fanout " +
          "(server_domain, username, registered_at, fanout_count, notified_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        rec.serverDomain,
        rec.username,
        rec.registeredAt,
        rec.fanoutCount,
        rec.notifiedAt,
      )
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
  async get(serverDomain: string) {
    const r = await this.db
      .prepare("SELECT * FROM install_policy_fanout WHERE server_domain = ?")
      .bind(serverDomain)
      .first<InstallPolicyFanoutRow>();
    return r
      ? {
          serverDomain: r.server_domain,
          username: r.username,
          registeredAt: r.registered_at,
          fanoutCount: r.fanout_count,
          notifiedAt: r.notified_at,
        }
      : undefined;
  }
}

interface DemoUserRow {
  username: string;
  display: string;
  snapshot_id: string | null;
  iso_r2_key: string | null;
  ttl_idle_minutes: number;
  region: string;
  size: string;
  active_server_id: string | null;
  active_server_ip: string | null;
  image: string | null;
  active_server_fqdn: string | null;
  last_activity_at: number;
  state: string;
  created_at: number;
  provision_phase: string | null;
  provision_phase_at: number | null;
  provision_last_error: string | null;
}

function rowToDemoUser(r: DemoUserRow): DemoUserRecord {
  return {
    username: r.username,
    display: r.display,
    snapshotId: r.snapshot_id,
    isoR2Key: r.iso_r2_key,
    ttlIdleMinutes: r.ttl_idle_minutes,
    region: r.region,
    size: r.size,
    activeServerId: r.active_server_id,
    activeServerIp: r.active_server_ip ?? null,
    image: r.image ?? null,
    activeServerFqdn: r.active_server_fqdn,
    lastActivityAt: r.last_activity_at,
    state: r.state as DemoUserState,
    createdAt: r.created_at,
    // Pre-0035 rows (or rows queried before the migration applied) read
    // these columns as undefined; coalesce to null so the record shape
    // is stable regardless of when the migration landed.
    provisionPhase: r.provision_phase ?? null,
    provisionPhaseAt: r.provision_phase_at ?? null,
    provisionLastError: r.provision_last_error ?? null,
  };
}

export class D1DemoUsersStorage implements DemoUsersStorage {
  constructor(private db: D1Database) {}
  async insert(rec: DemoUserRecord) {
    const u = rec.username.toLowerCase();
    try {
      await this.db
        .prepare(
          "INSERT INTO demo_users " +
            "(username, display, snapshot_id, iso_r2_key, ttl_idle_minutes, " +
            "region, size, active_server_id, active_server_ip, image, " +
            "active_server_fqdn, " +
            "last_activity_at, state, created_at, " +
            "provision_phase, provision_phase_at, provision_last_error) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          u,
          rec.display,
          rec.snapshotId,
          rec.isoR2Key,
          rec.ttlIdleMinutes,
          rec.region,
          rec.size,
          rec.activeServerId,
          rec.activeServerIp ?? null,
          rec.image ?? null,
          rec.activeServerFqdn,
          rec.lastActivityAt,
          rec.state,
          rec.createdAt,
          rec.provisionPhase ?? null,
          rec.provisionPhaseAt ?? null,
          rec.provisionLastError ?? null,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // PK collision = clean idempotency signal. The handler decides
      // whether to surface 409 or treat it as a re-insert.
      return { ok: false as const, reason: msg };
    }
  }
  async get(username: string) {
    const r = await this.db
      .prepare("SELECT * FROM demo_users WHERE username = ?")
      .bind(username.toLowerCase())
      .first<DemoUserRow>();
    return r ? rowToDemoUser(r) : undefined;
  }
  async list() {
    const r = await this.db
      .prepare("SELECT * FROM demo_users ORDER BY created_at DESC")
      .all<DemoUserRow>();
    return (r.results ?? []).map(rowToDemoUser);
  }
  async update(username: string, patch: Partial<DemoUserRecord>) {
    const setClauses: string[] = [];
    const binds: unknown[] = [];
    const map: Record<string, string> = {
      display: "display",
      snapshotId: "snapshot_id",
      isoR2Key: "iso_r2_key",
      ttlIdleMinutes: "ttl_idle_minutes",
      region: "region",
      size: "size",
      activeServerId: "active_server_id",
      activeServerIp: "active_server_ip",
      image: "image",
      activeServerFqdn: "active_server_fqdn",
      lastActivityAt: "last_activity_at",
      state: "state",
      provisionPhase: "provision_phase",
      provisionPhaseAt: "provision_phase_at",
      provisionLastError: "provision_last_error",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "username" || k === "createdAt") continue;
      const col = map[k];
      if (!col) continue;
      setClauses.push(`${col} = ?`);
      binds.push(v as unknown);
    }
    if (setClauses.length === 0) return;
    binds.push(username.toLowerCase());
    await this.db
      .prepare(`UPDATE demo_users SET ${setClauses.join(", ")} WHERE username = ?`)
      .bind(...binds)
      .run();
  }
  async delete(username: string) {
    await this.db
      .prepare("DELETE FROM demo_users WHERE username = ?")
      .bind(username.toLowerCase())
      .run();
  }
  async transition(
    username: string,
    from: DemoUserState,
    to: DemoUserState,
    patch?: Partial<DemoUserRecord>,
  ) {
    // CAS in one UPDATE so two concurrent /connect handlers can't both
    // win the none→provisioning race (docs/sample-users.md §4.4).
    const map: Record<string, string> = {
      display: "display",
      snapshotId: "snapshot_id",
      isoR2Key: "iso_r2_key",
      ttlIdleMinutes: "ttl_idle_minutes",
      region: "region",
      size: "size",
      activeServerId: "active_server_id",
      activeServerIp: "active_server_ip",
      image: "image",
      activeServerFqdn: "active_server_fqdn",
      lastActivityAt: "last_activity_at",
      provisionPhase: "provision_phase",
      provisionPhaseAt: "provision_phase_at",
      provisionLastError: "provision_last_error",
    };
    const setClauses: string[] = ["state = ?"];
    const binds: unknown[] = [to];
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (k === "username" || k === "createdAt" || k === "state") continue;
        const col = map[k];
        if (!col) continue;
        setClauses.push(`${col} = ?`);
        binds.push(v as unknown);
      }
    }
    const u = username.toLowerCase();
    binds.push(u, from);
    const res = await this.db
      .prepare(
        `UPDATE demo_users SET ${setClauses.join(", ")} ` +
          "WHERE username = ? AND state = ?",
      )
      .bind(...binds)
      .run();
    const meta = (res as { meta?: { changes?: number } }).meta;
    if (meta?.changes !== undefined && meta.changes === 0) return null;
    // Re-read the row so the caller sees the merged record.
    const after = await this.get(u);
    return after ?? null;
  }
  async findIdle(cutoffMs: number) {
    const r = await this.db
      .prepare(
        "SELECT * FROM demo_users " +
          "WHERE state IN ('up', 'provisioning', 'idle-pending-teardown') " +
          "AND last_activity_at < ? " +
          "ORDER BY last_activity_at ASC LIMIT 50",
      )
      .bind(cutoffMs)
      .all<DemoUserRow>();
    return (r.results ?? []).map(rowToDemoUser);
  }
  async countActive() {
    const r = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM demo_users " +
          "WHERE state IN ('provisioning', 'up', 'idle-pending-teardown')",
      )
      .first<{ n: number }>();
    return r?.n ?? 0;
  }
  async setProvisionPhase(
    username: string,
    phase: string,
    error: string | null,
    at: number,
  ) {
    const u = username.toLowerCase();
    const res = await this.db
      .prepare(
        "UPDATE demo_users SET provision_phase = ?, provision_phase_at = ?, " +
          "provision_last_error = ? WHERE username = ?",
      )
      .bind(phase, at, error, u)
      .run();
    const meta = (res as { meta?: { changes?: number } }).meta;
    if (meta?.changes !== undefined && meta.changes === 0) return null;
    const after = await this.get(u);
    return after ?? null;
  }
}

interface DeviceCapabilityGrantRow {
  grant_id: string;
  username: string;
  device_label: string;
  device_pub_hex: string;
  scopes_json: string;
  issued_at: number;
  expires_at: number;
  signature_hex: string;
  revoked_at: number | null;
}
function rowToDeviceCapabilityGrant(
  r: DeviceCapabilityGrantRow,
): DeviceCapabilityGrantRecord {
  return {
    grantId: r.grant_id,
    username: r.username,
    deviceLabel: r.device_label,
    devicePubHex: r.device_pub_hex,
    scopesJson: r.scopes_json,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    signatureHex: r.signature_hex,
    revokedAt: r.revoked_at,
  };
}

export class D1DeviceCapabilityGrantStorage
  implements DeviceCapabilityGrantStorage
{
  constructor(private readonly db: D1Database) {}
  async put(rec: DeviceCapabilityGrantRecord) {
    // The unique partial index `idx_dcg_username_label_active`
    // enforces "at most one ACTIVE grant per (username, device_label)"
    // at the DB level — re-issuance MUST revoke the old row first.
    // We catch the surfaced UNIQUE-constraint message rather than
    // pre-checking, both to avoid the read-then-write race and to keep
    // the InMemory / D1 reason strings byte-identical.
    try {
      await this.db
        .prepare(
          `INSERT INTO device_capability_grants
            (grant_id, username, device_label, device_pub_hex,
             scopes_json, issued_at, expires_at, signature_hex, revoked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          rec.grantId,
          rec.username.toLowerCase(),
          rec.deviceLabel.toLowerCase(),
          rec.devicePubHex.toLowerCase(),
          rec.scopesJson,
          rec.issuedAt,
          rec.expiresAt,
          rec.signatureHex,
          rec.revokedAt,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE/i.test(msg)) {
        return {
          ok: false as const,
          reason: "duplicate active grant for (username, device_label)",
        };
      }
      throw e;
    }
  }
  async get(grantId: string) {
    const r = await this.db
      .prepare(
        `SELECT * FROM device_capability_grants WHERE grant_id = ?1`,
      )
      .bind(grantId)
      .first<DeviceCapabilityGrantRow>();
    return r ? rowToDeviceCapabilityGrant(r) : undefined;
  }
  async listForUser(username: string) {
    const r = await this.db
      .prepare(
        `SELECT * FROM device_capability_grants
         WHERE username = ?1
         ORDER BY issued_at DESC`,
      )
      .bind(username.toLowerCase())
      .all<DeviceCapabilityGrantRow>();
    return (r.results ?? []).map(rowToDeviceCapabilityGrant);
  }
  async getActiveForUserLabel(username: string, deviceLabel: string) {
    const r = await this.db
      .prepare(
        `SELECT * FROM device_capability_grants
         WHERE username = ?1 AND device_label = ?2 AND revoked_at IS NULL`,
      )
      .bind(username.toLowerCase(), deviceLabel.toLowerCase())
      .all<DeviceCapabilityGrantRow>();
    const rows = r.results ?? [];
    if (rows.length > 1) {
      // Defensive — the unique partial index should make this
      // unreachable. Fail loudly so a misconfigured DB is impossible
      // to silently keep using.
      throw new Error(
        `getActiveForUserLabel: more than one active grant for ` +
          `${username}/${deviceLabel}`,
      );
    }
    return rows[0] ? rowToDeviceCapabilityGrant(rows[0]) : undefined;
  }
  async getByDevicePub(devicePubHex: string) {
    // Most-recent ACTIVE row for the pubkey. ORDER BY issued_at DESC
    // + LIMIT 1 picks the right one when a device has been re-labeled
    // and the old grant tombstoned; the partial-active filter excludes
    // tombstones outright.
    const r = await this.db
      .prepare(
        `SELECT * FROM device_capability_grants
         WHERE device_pub_hex = ?1 AND revoked_at IS NULL
         ORDER BY issued_at DESC
         LIMIT 1`,
      )
      .bind(devicePubHex.toLowerCase())
      .first<DeviceCapabilityGrantRow>();
    return r ? rowToDeviceCapabilityGrant(r) : undefined;
  }
  async revoke(grantId: string, revokedAt: number) {
    const r = await this.db
      .prepare(
        `UPDATE device_capability_grants SET revoked_at = ?1 WHERE grant_id = ?2`,
      )
      .bind(revokedAt, grantId)
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    if (meta?.changes !== undefined && meta.changes === 0) {
      throw new Error("unknown grantId");
    }
  }
}

export class D1Storage implements Storage {
  usernames: UsernameStorage;
  schemaVersion: SchemaVersionStorage;
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
  deviceCapabilityGrants: DeviceCapabilityGrantStorage;
  watchDelegates: WatchDelegateStorage;
  mintReservations: MintReservationStorage;
  acmeAccountKeyGrants: AcmeAccountKeyGrantStorage;
  acmeAccountKeyDelivery: AcmeAccountKeyDeliveryStorage;
  ctAlerts: CtAlertStorage;
  trustExceptions: TrustExceptionStorage;
  namespace: NamespaceStorage;
  constructor(db: D1Database) {
    this.usernames = new D1UsernameStorage(db);
    this.schemaVersion = new D1SchemaVersionStorage(db);
    this.usernameAliases = new D1UsernameAliasStorage(db);
    this.daemonStatus = new D1DaemonStatusStorage(db);
    this.authCodes = new D1AuthCodeStorage(db);
    this.servers = new D1ServerStorage(db);
    this.routing = new D1RoutingStorage(db);
    this.installEvents = new D1InstallEventStorage(db);
    this.provisionStatus = new D1ProvisionStatusStorage(db);
    this.auditEvents = new D1AuditEventStorage(db);
    this.luksKeys = new D1LuksKeyStorage(db);
    this.autoUnlockLeases = new D1AutoUnlockLeaseStorage(db);
    this.secretMailbox = new D1SecretMailboxStorage(db);
    this.boxSealedLeases = new D1BoxSealedLeaseStorage(db);
    this.pendingRePairs = new D1PendingRePairStorage(db);
    this.webauthnRecovery = new D1WebauthnRecoveryStorage(db);
    this.marketplace = new D1MarketplaceStorage(db);
    this.pushTokens = new D1PushTokenStorage(db);
    this.llmPromo = new D1LlmPromoStorage(db);
    this.tiers = new D1TierStorage(db);
    this.entitlementRevocations = new D1EntitlementRevocationStorage(db);
    this.userIdentity = new D1UserIdentityRecordStorage(db);
    this.userServiceAliases = new D1UserServiceAliasStorage(db);
    this.voiciLinks = new D1VoiciLinkStorage(db);
    this.customDomainOrders = new D1CustomDomainOrderStorage(db);
    this.demoLlmLedger = new D1DemoLlmLedgerStorage(db);
    this.installPolicyFanout = new D1InstallPolicyFanoutStorage(db);
    this.demoUsers = new D1DemoUsersStorage(db);
    this.deviceCapabilityGrants = new D1DeviceCapabilityGrantStorage(db);
    this.watchDelegates = new D1WatchDelegateStorage(db);
    this.mintReservations = new D1MintReservationStorage(db);
    this.acmeAccountKeyGrants = new D1AcmeAccountKeyGrantStorage(db);
    this.acmeAccountKeyDelivery = new D1AcmeAccountKeyDeliveryStorage(db);
    this.ctAlerts = new D1CtAlertStorage(db);
    this.trustExceptions = new D1TrustExceptionStorage(db);
    this.namespace = new D1NamespaceStorage(db);
  }
}

/** D1 SchemaVersionStorage (OPS-2) — the migration ledger (migration
 *  0049). `record` INSERTs and treats a PRIMARY-KEY collision as
 *  "already recorded" (returns false, original appliedAt preserved). */
export class D1SchemaVersionStorage implements SchemaVersionStorage {
  constructor(private readonly db: D1Database) {}
  async record(version: string, at: number): Promise<boolean> {
    try {
      await this.db
        .prepare(
          `INSERT INTO schema_version (version, applied_at) VALUES (?1, ?2)`,
        )
        .bind(version, at)
        .run();
      return true;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(msg)) return false;
      throw e;
    }
  }
  async list(): Promise<SchemaVersionRecord[]> {
    const r = await this.db
      .prepare(
        `SELECT version, applied_at FROM schema_version ORDER BY version ASC`,
      )
      .all<{ version: string; applied_at: number }>();
    return (r.results ?? []).map((row) => ({
      version: row.version,
      appliedAt: row.applied_at,
    }));
  }
  async has(version: string): Promise<boolean> {
    const r = await this.db
      .prepare(`SELECT 1 FROM schema_version WHERE version = ?1 LIMIT 1`)
      .bind(version)
      .first();
    return !!r;
  }
}

/** D1 CtAlertStorage — owner-push dedup ledger for the CT watcher.
 *  claimAlertSlot uses INSERT ... and treats a UNIQUE/PRIMARY-KEY
 *  collision as "already alerted" (returns false). Migration 0047. */
export class D1CtAlertStorage implements CtAlertStorage {
  constructor(private readonly db: D1Database) {}
  async claimAlertSlot(username: string, certSha256: string, now: number) {
    try {
      await this.db
        .prepare(
          `INSERT INTO ct_alerts (username, cert_sha256, alerted_at)
           VALUES (?1, ?2, ?3)`,
        )
        .bind(username.toLowerCase(), certSha256.toLowerCase(), now)
        .run();
      return true;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(msg)) return false;
      throw e;
    }
  }
  async has(username: string, certSha256: string) {
    const r = await this.db
      .prepare(
        `SELECT 1 FROM ct_alerts WHERE username = ?1 AND cert_sha256 = ?2 LIMIT 1`,
      )
      .bind(username.toLowerCase(), certSha256.toLowerCase())
      .first();
    return !!r;
  }
}

interface TrustExceptionRow {
  username: string;
  cert_hash: string;
  cert_class: string;
  granted_at: number;
  granted_by_device_pub: string;
  envelope_json: string;
  stored_at: number;
}
function rowToTrustException(r: TrustExceptionRow): TrustExceptionRecord {
  return {
    username: r.username,
    certHash: r.cert_hash,
    certClass: r.cert_class,
    grantedAt: r.granted_at,
    grantedByDevicePub: r.granted_by_device_pub,
    envelopeJson: r.envelope_json,
    storedAt: r.stored_at,
  };
}

/** D1 TrustExceptionStorage — owner-signed per-cert maintainer-trust
 *  overrides, synced through `.com`. PRIMARY KEY (username, cert_hash);
 *  `put` is a REPLACE (last-writer; replay-safe). */
export class D1TrustExceptionStorage implements TrustExceptionStorage {
  constructor(private readonly db: D1Database) {}
  async put(
    username: string,
    exc: {
      kind: string;
      certClass: string;
      certHash: string;
      grantedAt: number;
      grantedByDevicePub: string;
      signatures: { pubkey: string; sig: string }[];
    },
    now: number = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO trust_exceptions
           (username, cert_hash, cert_class, granted_at,
            granted_by_device_pub, envelope_json, stored_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(username, cert_hash) DO UPDATE SET
           cert_class = excluded.cert_class,
           granted_at = excluded.granted_at,
           granted_by_device_pub = excluded.granted_by_device_pub,
           envelope_json = excluded.envelope_json,
           stored_at = excluded.stored_at`,
      )
      .bind(
        username.toLowerCase(),
        exc.certHash.toLowerCase(),
        exc.certClass,
        exc.grantedAt,
        exc.grantedByDevicePub.toLowerCase(),
        JSON.stringify(exc),
        now,
      )
      .run();
  }
  async listForUser(username: string): Promise<TrustExceptionRecord[]> {
    const rs = await this.db
      .prepare(
        `SELECT username, cert_hash, cert_class, granted_at,
                granted_by_device_pub, envelope_json, stored_at
           FROM trust_exceptions WHERE username = ?1
           ORDER BY granted_at DESC`,
      )
      .bind(username.toLowerCase())
      .all<TrustExceptionRow>();
    return (rs.results ?? []).map(rowToTrustException);
  }
  async get(
    username: string,
    certHash: string,
  ): Promise<TrustExceptionRecord | undefined> {
    const r = await this.db
      .prepare(
        `SELECT username, cert_hash, cert_class, granted_at,
                granted_by_device_pub, envelope_json, stored_at
           FROM trust_exceptions WHERE username = ?1 AND cert_hash = ?2 LIMIT 1`,
      )
      .bind(username.toLowerCase(), certHash.toLowerCase())
      .first<TrustExceptionRow>();
    return r ? rowToTrustException(r) : undefined;
  }
}

interface WatchDelegateRow {
  grant_id: string;
  username: string;
  delegate_pub_hex: string;
  scopes_json: string;
  issued_at: number;
  expires_at: number;
  signature_hex: string;
  revoked_at: number | null;
}
function rowToWatchDelegate(r: WatchDelegateRow): WatchDelegateRecord {
  return {
    grantId: r.grant_id,
    username: r.username,
    delegatePubHex: r.delegate_pub_hex,
    scopesJson: r.scopes_json,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    signatureHex: r.signature_hex,
    revokedAt: r.revoked_at,
  };
}

/** D1 WatchDelegateStorage — opt-in Watch quick-approve delegate keys.
 *  Mirrors D1DeviceCapabilityGrantStorage; one active delegate per user is
 *  enforced by the unique partial index `idx_wd_username_active`. */
export class D1WatchDelegateStorage implements WatchDelegateStorage {
  constructor(private readonly db: D1Database) {}
  async put(rec: WatchDelegateRecord) {
    try {
      await this.db
        .prepare(
          `INSERT INTO watch_delegates
            (grant_id, username, delegate_pub_hex, scopes_json,
             issued_at, expires_at, signature_hex, revoked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(
          rec.grantId,
          rec.username.toLowerCase(),
          rec.delegatePubHex.toLowerCase(),
          rec.scopesJson,
          rec.issuedAt,
          rec.expiresAt,
          rec.signatureHex,
          rec.revokedAt,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE/i.test(msg)) {
        return { ok: false as const, reason: "duplicate active watch delegate for user" };
      }
      throw e;
    }
  }
  async get(grantId: string) {
    const r = await this.db
      .prepare(`SELECT * FROM watch_delegates WHERE grant_id = ?1`)
      .bind(grantId)
      .first<WatchDelegateRow>();
    return r ? rowToWatchDelegate(r) : undefined;
  }
  async listForUser(username: string) {
    const r = await this.db
      .prepare(`SELECT * FROM watch_delegates WHERE username = ?1 ORDER BY issued_at DESC`)
      .bind(username.toLowerCase())
      .all<WatchDelegateRow>();
    return (r.results ?? []).map(rowToWatchDelegate);
  }
  async getActiveForUser(username: string) {
    const r = await this.db
      .prepare(`SELECT * FROM watch_delegates WHERE username = ?1 AND revoked_at IS NULL`)
      .bind(username.toLowerCase())
      .all<WatchDelegateRow>();
    const rows = r.results ?? [];
    if (rows.length > 1) {
      throw new Error(`getActiveForUser: more than one active watch delegate for ${username}`);
    }
    return rows[0] ? rowToWatchDelegate(rows[0]) : undefined;
  }
  async getActiveByDelegatePub(delegatePubHex: string) {
    const r = await this.db
      .prepare(
        `SELECT * FROM watch_delegates
         WHERE delegate_pub_hex = ?1 AND revoked_at IS NULL
         ORDER BY issued_at DESC LIMIT 1`,
      )
      .bind(delegatePubHex.toLowerCase())
      .first<WatchDelegateRow>();
    return r ? rowToWatchDelegate(r) : undefined;
  }
  async revoke(grantId: string, revokedAt: number) {
    const res = await this.db
      .prepare(`UPDATE watch_delegates SET revoked_at = ?2 WHERE grant_id = ?1`)
      .bind(grantId, revokedAt)
      .run();
    const changes = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
    if (changes === 0) throw new Error("unknown grantId");
  }
}

interface MintReservationRow {
  username: string;
  holder_pub_hex: string;
  acquired_at: number;
  expires_at: number;
}

function rowToMintReservation(r: MintReservationRow): MintReservationRecord {
  return {
    username: r.username,
    holderPubHex: r.holder_pub_hex,
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
  };
}

/**
 * D1 MintReservationStorage — the dead-lead-safe CAS lease (per-user-cert).
 * Acquire is a single SQLite conditional upsert: it writes IFF there's no
 * row, the existing row is EXPIRED, or you already hold it (the `ON CONFLICT
 * … WHERE` clause). D1's single-writer serialization makes that atomic, so
 * two minters racing can't both win. We read the row back to report who holds
 * it now.
 */
export class D1MintReservationStorage implements MintReservationStorage {
  constructor(private readonly db: D1Database) {}

  async tryAcquire(args: {
    username: string;
    holderPubHex: string;
    expiresAt: number;
    now: number;
  }) {
    const u = args.username.toLowerCase();
    const holder = args.holderPubHex.toLowerCase();
    await this.db
      .prepare(
        `INSERT INTO mint_reservations (username, holder_pub_hex, acquired_at, expires_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(username) DO UPDATE SET
           holder_pub_hex = excluded.holder_pub_hex,
           acquired_at    = excluded.acquired_at,
           expires_at     = excluded.expires_at
         WHERE mint_reservations.expires_at <= ?5
            OR mint_reservations.holder_pub_hex = excluded.holder_pub_hex`,
      )
      .bind(u, holder, args.now, args.expiresAt, args.now)
      .run();
    const row = await this.db
      .prepare(`SELECT * FROM mint_reservations WHERE username = ?1`)
      .bind(u)
      .first<MintReservationRow>();
    const rec = rowToMintReservation(row!);
    return { acquired: rec.holderPubHex === holder, holder: rec };
  }

  async get(username: string) {
    const r = await this.db
      .prepare(`SELECT * FROM mint_reservations WHERE username = ?1`)
      .bind(username.toLowerCase())
      .first<MintReservationRow>();
    return r ? rowToMintReservation(r) : undefined;
  }

  async release(username: string, holderPubHex: string) {
    await this.db
      .prepare(`DELETE FROM mint_reservations WHERE username = ?1 AND holder_pub_hex = ?2`)
      .bind(username.toLowerCase(), holderPubHex.toLowerCase())
      .run();
  }
}

interface AcmeAccountKeyGrantRow {
  grant_id: string;
  username: string;
  account_key_id: string;
  recipient_pub_hex: string;
  sealed_account_key_hex: string;
  issued_at: number;
  expires_at: number;
  signature_hex: string;
  revoked_at: number | null;
}
function rowToAcmeAccountKeyGrant(r: AcmeAccountKeyGrantRow): AcmeAccountKeyGrantRecord {
  return {
    grantId: r.grant_id,
    username: r.username,
    accountKeyId: r.account_key_id,
    recipientPubHex: r.recipient_pub_hex,
    sealedAccountKeyHex: r.sealed_account_key_hex,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    signatureHex: r.signature_hex,
    revokedAt: r.revoked_at,
  };
}

/** D1 AcmeAccountKeyGrantStorage — sealed ACME account keys handed to admin
 *  devices (per-user-cert design). MANY active grants per user coexist (one per
 *  admin device), so there is NO unique-active index; `put` only rejects a
 *  duplicate grant_id (the PRIMARY KEY). `revokeByAccountKeyId` tombstones every
 *  active copy of a rotated key in one statement. */
export class D1AcmeAccountKeyGrantStorage implements AcmeAccountKeyGrantStorage {
  constructor(private readonly db: D1Database) {}
  async put(rec: AcmeAccountKeyGrantRecord) {
    try {
      await this.db
        .prepare(
          `INSERT INTO acme_account_key_grants
            (grant_id, username, account_key_id, recipient_pub_hex,
             sealed_account_key_hex, issued_at, expires_at, signature_hex, revoked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          rec.grantId,
          rec.username.toLowerCase(),
          rec.accountKeyId,
          rec.recipientPubHex.toLowerCase(),
          rec.sealedAccountKeyHex,
          rec.issuedAt,
          rec.expiresAt,
          rec.signatureHex,
          rec.revokedAt,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
        return { ok: false as const, reason: "duplicate acme account key grant id" };
      }
      throw e;
    }
  }
  async get(grantId: string) {
    const r = await this.db
      .prepare(`SELECT * FROM acme_account_key_grants WHERE grant_id = ?1`)
      .bind(grantId)
      .first<AcmeAccountKeyGrantRow>();
    return r ? rowToAcmeAccountKeyGrant(r) : undefined;
  }
  async listForUser(username: string) {
    const r = await this.db
      .prepare(`SELECT * FROM acme_account_key_grants WHERE username = ?1 ORDER BY issued_at DESC`)
      .bind(username.toLowerCase())
      .all<AcmeAccountKeyGrantRow>();
    return (r.results ?? []).map(rowToAcmeAccountKeyGrant);
  }
  async getActiveForUser(username: string) {
    const r = await this.db
      .prepare(
        `SELECT * FROM acme_account_key_grants
         WHERE username = ?1 AND revoked_at IS NULL
         ORDER BY issued_at DESC`,
      )
      .bind(username.toLowerCase())
      .all<AcmeAccountKeyGrantRow>();
    return (r.results ?? []).map(rowToAcmeAccountKeyGrant);
  }
  async getActiveByRecipient(recipientPubHex: string) {
    const r = await this.db
      .prepare(
        `SELECT * FROM acme_account_key_grants
         WHERE recipient_pub_hex = ?1 AND revoked_at IS NULL
         ORDER BY issued_at DESC`,
      )
      .bind(recipientPubHex.toLowerCase())
      .all<AcmeAccountKeyGrantRow>();
    return (r.results ?? []).map(rowToAcmeAccountKeyGrant);
  }
  async revoke(grantId: string, revokedAt: number) {
    const res = await this.db
      .prepare(`UPDATE acme_account_key_grants SET revoked_at = ?2 WHERE grant_id = ?1`)
      .bind(grantId, revokedAt)
      .run();
    const changes = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
    if (changes === 0) throw new Error("unknown grantId");
  }
  async revokeByAccountKeyId(accountKeyId: string, revokedAt: number) {
    const res = await this.db
      .prepare(
        `UPDATE acme_account_key_grants SET revoked_at = ?2
         WHERE account_key_id = ?1 AND revoked_at IS NULL`,
      )
      .bind(accountKeyId, revokedAt)
      .run();
    return (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
  }
}

interface AcmeAccountKeyDeliveryRow {
  server_domain: string;
  account_key_id: string;
  sealed_account_key_hex: string;
  recipient_pub_hex: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}
function rowToAcmeAccountKeyDelivery(
  r: AcmeAccountKeyDeliveryRow,
): AcmeAccountKeyDeliveryRecord {
  return {
    serverDomain: r.server_domain,
    accountKeyId: r.account_key_id,
    sealedAccountKeyHex: r.sealed_account_key_hex,
    recipientPubHex: r.recipient_pub_hex,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

/** D1 AcmeAccountKeyDeliveryStorage — seal-to-box delivery of the shared ACME
 *  account key (#28 Option B). ONE slot per server_domain (PK); `put` is an
 *  upsert (a fresh deposit supersedes the prior seal). `deleteByAccountKeyId`
 *  drops every slot of a rotated key in one statement (the rotation hook).
 *  Mirrors D1BoxSealedLeaseStorage; `.com` holds ciphertext only (I1). */
export class D1AcmeAccountKeyDeliveryStorage
  implements AcmeAccountKeyDeliveryStorage
{
  constructor(private readonly db: D1Database) {}

  async put(rec: AcmeAccountKeyDeliveryRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO acme_account_key_delivery
           (server_domain, account_key_id, sealed_account_key_hex,
            recipient_pub_hex, issued_at, expires_at, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(server_domain) DO UPDATE SET
           account_key_id = excluded.account_key_id,
           sealed_account_key_hex = excluded.sealed_account_key_hex,
           recipient_pub_hex = excluded.recipient_pub_hex,
           issued_at = excluded.issued_at,
           expires_at = excluded.expires_at,
           revoked_at = excluded.revoked_at`,
      )
      .bind(
        rec.serverDomain,
        rec.accountKeyId,
        rec.sealedAccountKeyHex,
        rec.recipientPubHex.toLowerCase(),
        rec.issuedAt,
        rec.expiresAt,
        rec.revokedAt,
      )
      .run();
  }

  async getByDomain(serverDomain: string): Promise<AcmeAccountKeyDeliveryRecord | undefined> {
    const r = await this.db
      .prepare(`SELECT * FROM acme_account_key_delivery WHERE server_domain = ?1`)
      .bind(serverDomain)
      .first<AcmeAccountKeyDeliveryRow>();
    return r ? rowToAcmeAccountKeyDelivery(r) : undefined;
  }

  async deleteByDomain(serverDomain: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM acme_account_key_delivery WHERE server_domain = ?1`)
      .bind(serverDomain)
      .run();
  }

  async deleteByAccountKeyId(accountKeyId: string): Promise<number> {
    const res = await this.db
      .prepare(`DELETE FROM acme_account_key_delivery WHERE account_key_id = ?1`)
      .bind(accountKeyId)
      .run();
    return (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
  }
}

interface NameClaimRow {
  username: string;
  label: string;
  kind: string;
  ref_id: string;
  claimed_at: number;
}
function rowToNameClaim(r: NameClaimRow): NameClaimRecord {
  return {
    username: r.username,
    label: r.label,
    kind: r.kind as NameClaimKind,
    refId: r.ref_id,
    claimedAt: r.claimed_at,
  };
}

/** D1 NamespaceStorage — the merged per-user leftmost-label uniqueness
 *  invariant (§3.4; per-user-cert design). The unique index
 *  `idx_name_claims_username_label` enforces "at most one claim per
 *  (username, label)" at the DB level. `claim` first reads the existing
 *  row: an identical (kind, ref_id) is idempotent (ok, original claimed_at
 *  preserved); otherwise it INSERTs and translates a surfaced UNIQUE
 *  violation — the read-then-insert race where a DIFFERENT claim landed
 *  in between — into the shared `"name taken"` reason. Both columns are
 *  stored lower-cased so the index key is the case-insensitive pair. */
export class D1NamespaceStorage implements NamespaceStorage {
  constructor(private readonly db: D1Database) {}
  async claim(rec: NameClaimRecord) {
    const existing = await this.resolve(rec.username, rec.label);
    if (existing) {
      if (existing.kind === rec.kind && existing.refId === rec.refId) {
        return { ok: true as const };
      }
      return { ok: false as const, reason: "name taken" };
    }
    try {
      await this.db
        .prepare(
          `INSERT INTO name_claims (username, label, kind, ref_id, claimed_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          rec.username.toLowerCase(),
          rec.label.toLowerCase(),
          rec.kind,
          rec.refId,
          rec.claimedAt,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE/i.test(msg)) {
        // A concurrent claim raced in between the resolve and the insert.
        // Re-resolve so an identical (kind, refId) still reads as
        // idempotent; anything else is the collision.
        const now = await this.resolve(rec.username, rec.label);
        if (now && now.kind === rec.kind && now.refId === rec.refId) {
          return { ok: true as const };
        }
        return { ok: false as const, reason: "name taken" };
      }
      throw e;
    }
  }
  async release(username: string, label: string) {
    await this.db
      .prepare(`DELETE FROM name_claims WHERE username = ?1 AND label = ?2`)
      .bind(username.toLowerCase(), label.toLowerCase())
      .run();
  }
  async resolve(username: string, label: string) {
    const r = await this.db
      .prepare(`SELECT * FROM name_claims WHERE username = ?1 AND label = ?2`)
      .bind(username.toLowerCase(), label.toLowerCase())
      .first<NameClaimRow>();
    return r ? rowToNameClaim(r) : undefined;
  }
  async listForUser(username: string) {
    const r = await this.db
      .prepare(`SELECT * FROM name_claims WHERE username = ?1 ORDER BY claimed_at ASC`)
      .bind(username.toLowerCase())
      .all<NameClaimRow>();
    return (r.results ?? []).map(rowToNameClaim);
  }
}
