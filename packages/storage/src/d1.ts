import type {
  AutoUnlockLeaseRecord,
  AutoUnlockLeaseStorage,
  PendingRePairRecord,
  PendingRePairStorage,
  PendingUnlockApprovalRecord,
  PendingUnlockApprovalStorage,
  WebauthnRecoveryRecord,
  WebauthnRecoveryStorage,
  EntitlementRevocationListRecord,
  EntitlementRevocationStorage,
  AuthCodeRecord,
  AuthCodeStorage,
  BuildTicketRecord,
  BuildTicketStorage,
  InstallEvent,
  InstallEventStorage,
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
  UnlockKeyDeposit,
  UserIdentityRecord,
  UserIdentityRecordStorage,
  UsernameRecord,
  UsernameAliasRecord,
  UsernameAliasStorage,
  UsernameStorage,
  DaemonStatusRecord,
  DaemonStatusStorage,
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
interface BuildTicketRow {
  code: string;
  blob_json: string;
  blob_signature_hex: string;
  username: string;
  server_domain: string;
  created_at: number;
  expires_at: number;
  status: string;
  redeemed_at: number | null;
  redemptions: number;
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
  return { username: r.username, irkPubHex: r.irk_pub_hex, claimedAt: r.claimed_at };
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
function rowToBuildTicket(r: BuildTicketRow): BuildTicketRecord {
  return {
    code: r.code,
    blobJson: r.blob_json,
    blobSignatureHex: r.blob_signature_hex,
    username: r.username,
    serverDomain: r.server_domain,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    status: r.status as BuildTicketRecord["status"],
    redeemedAt: r.redeemed_at ?? undefined,
    redemptions: r.redemptions,
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
    await this.db
      .prepare(
        "INSERT INTO usernames (username, irk_pub_hex, claimed_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(username) DO UPDATE SET claimed_at = excluded.claimed_at",
      )
      .bind(norm, rec.irkPubHex, rec.claimedAt)
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
}

export class D1BuildTicketStorage implements BuildTicketStorage {
  constructor(private db: D1Database) {}
  async put(rec: BuildTicketRecord) {
    try {
      await this.db
        .prepare(
          `INSERT INTO build_tickets (
            code, blob_json, blob_signature_hex, username, server_domain,
            created_at, expires_at, status, redemptions
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          rec.code,
          rec.blobJson,
          rec.blobSignatureHex,
          rec.username,
          rec.serverDomain,
          rec.createdAt,
          rec.expiresAt,
          rec.status,
          rec.redemptions,
        )
        .run();
      return { ok: true as const };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE/i.test(msg)) {
        return { ok: false as const, reason: "code collision" };
      }
      throw e;
    }
  }
  async get(code: string) {
    const r = await this.db
      .prepare("SELECT * FROM build_tickets WHERE code = ?")
      .bind(code)
      .first<BuildTicketRow>();
    return r ? rowToBuildTicket(r) : undefined;
  }
  async refresh(code: string, expiresAt: number) {
    const r = await this.db
      .prepare(
        "UPDATE build_tickets SET expires_at = ? WHERE code = ? AND status != 'revoked'",
      )
      .bind(expiresAt, code)
      .run();
    if (r.meta.changes && r.meta.changes > 0) return { ok: true as const };
    const cur = await this.get(code);
    if (!cur) return { ok: false as const, reason: "unknown code" };
    if (cur.status === "revoked") return { ok: false as const, reason: "revoked" };
    return { ok: true as const };
  }
  async markRedeemed(code: string, now: number) {
    await this.db
      .prepare(
        `UPDATE build_tickets
         SET status = 'redeemed', redeemed_at = ?, redemptions = redemptions + 1
         WHERE code = ?`,
      )
      .bind(now, code)
      .run();
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
  async putUnlock(rec: UnlockKeyDeposit): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO unlock_key_deposits (server_domain, unlock_key_hex, deposited_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(server_domain) DO UPDATE SET
           unlock_key_hex = excluded.unlock_key_hex,
           deposited_at = excluded.deposited_at,
           expires_at = excluded.expires_at`,
      )
      .bind(rec.serverDomain, rec.unlockKeyHex, rec.depositedAt, rec.expiresAt)
      .run();
  }
  async consumeUnlock(serverDomain: string, now: number): Promise<UnlockKeyDeposit | undefined> {
    // SELECT, then DELETE — D1 doesn't support RETURNING in all contexts;
    // since the consume is one-shot per boot we accept the small race in
    // the (single-server) production case. Two simultaneous boot stages
    // would each try to consume and only one would win.
    const r = await this.db
      .prepare("SELECT * FROM unlock_key_deposits WHERE server_domain = ?")
      .bind(serverDomain)
      .first<{ server_domain: string; unlock_key_hex: string; deposited_at: number; expires_at: number }>();
    if (!r) return undefined;
    await this.db
      .prepare("DELETE FROM unlock_key_deposits WHERE server_domain = ?")
      .bind(serverDomain)
      .run();
    if (r.expires_at <= now) return undefined;
    return {
      serverDomain: r.server_domain,
      unlockKeyHex: r.unlock_key_hex,
      depositedAt: r.deposited_at,
      expiresAt: r.expires_at,
    };
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
    // Pick the freshest non-expired row. Like the legacy consumeUnlock,
    // there's a small race when two boot stages call simultaneously —
    // single-server production case where this can't happen, so we
    // accept it. GC of expired rows happens here too so the table
    // doesn't grow unbounded.
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

export class D1PendingUnlockApprovalStorage implements PendingUnlockApprovalStorage {
  constructor(private readonly db: D1Database) {}

  async upsertWithDedup(
    serverDomain: string,
    requestId: string,
    now: number,
    pushDedupMs: number,
  ): Promise<{ requestId: string; shouldPush: boolean }> {
    const existing = await this.db
      .prepare("SELECT * FROM pending_unlock_approvals WHERE server_domain = ?")
      .bind(serverDomain)
      .first<{ server_domain: string; request_id: string; requested_at: number; last_push_at: number }>();
    if (!existing) {
      await this.db
        .prepare(
          `INSERT INTO pending_unlock_approvals
             (server_domain, request_id, requested_at, last_push_at)
           VALUES (?, ?, ?, 0)`,
        )
        .bind(serverDomain, requestId, now)
        .run();
      return { requestId, shouldPush: true };
    }
    const shouldPush = now - existing.last_push_at > pushDedupMs;
    return { requestId: existing.request_id, shouldPush };
  }

  async touchLastPushAt(serverDomain: string, at: number): Promise<void> {
    await this.db
      .prepare("UPDATE pending_unlock_approvals SET last_push_at = ? WHERE server_domain = ?")
      .bind(at, serverDomain)
      .run();
  }

  async get(serverDomain: string): Promise<PendingUnlockApprovalRecord | undefined> {
    const r = await this.db
      .prepare("SELECT * FROM pending_unlock_approvals WHERE server_domain = ?")
      .bind(serverDomain)
      .first<{ server_domain: string; request_id: string; requested_at: number; last_push_at: number }>();
    if (!r) return undefined;
    return {
      serverDomain: r.server_domain,
      requestId: r.request_id,
      requestedAt: r.requested_at,
      lastPushAt: r.last_push_at,
    };
  }

  async delete(serverDomain: string): Promise<boolean> {
    const r = await this.db
      .prepare("DELETE FROM pending_unlock_approvals WHERE server_domain = ?")
      .bind(serverDomain)
      .run();
    const meta = (r as { meta?: { changes?: number } }).meta;
    return meta?.changes === undefined ? true : meta.changes > 0;
  }
}

export class D1PendingRePairStorage implements PendingRePairStorage {
  constructor(private readonly db: D1Database) {}

  async initiate(rec: PendingRePairRecord) {
    const key = rec.username.toLowerCase();
    try {
      await this.db
        .prepare(
          `INSERT INTO pending_re_pairs
             (username, new_irk_pub_hex, old_irk_pub_hex, initiated_at, completes_at, objected_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .bind(key, rec.newIrkPubHex, rec.oldIrkPubHex, rec.initiatedAt, rec.completesAt)
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
      .first<{
        username: string;
        new_irk_pub_hex: string;
        old_irk_pub_hex: string;
        initiated_at: number;
        completes_at: number;
        objected_at: number | null;
      }>();
    if (!r) return undefined;
    return {
      username: r.username,
      newIrkPubHex: r.new_irk_pub_hex,
      oldIrkPubHex: r.old_irk_pub_hex,
      initiatedAt: r.initiated_at,
      completesAt: r.completes_at,
      ...(r.objected_at != null ? { objectedAt: r.objected_at } : {}),
    };
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
}

export class D1WebauthnRecoveryStorage implements WebauthnRecoveryStorage {
  constructor(private readonly db: D1Database) {}

  async upsert(rec: WebauthnRecoveryRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO webauthn_recovery_records
           (username, credential_id_hex, wrapped_umk_b64, irk_pub_hex,
            fetch_token_hash, prf_salt_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(username) DO UPDATE SET
           credential_id_hex = excluded.credential_id_hex,
           wrapped_umk_b64 = excluded.wrapped_umk_b64,
           irk_pub_hex = excluded.irk_pub_hex,
           fetch_token_hash = excluded.fetch_token_hash,
           prf_salt_hash = excluded.prf_salt_hash,
           updated_at = excluded.updated_at`,
      )
      .bind(
        rec.username.toLowerCase(),
        rec.credentialIdHex,
        rec.wrappedUmkB64,
        rec.irkPubHex,
        rec.fetchTokenHashHex ?? null,
        rec.prfSaltHashHex ?? null,
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
    await this.db.prepare(
      `INSERT INTO push_tokens (token_id, username, platform, provider_token, push_x25519_pub_hex, registration_signature_hex, registered_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(token_id) DO UPDATE SET
         provider_token=excluded.provider_token,
         push_x25519_pub_hex=excluded.push_x25519_pub_hex,
         registration_signature_hex=excluded.registration_signature_hex,
         last_seen_at=excluded.last_seen_at`,
    ).bind(
      rec.tokenId, rec.username, rec.platform, rec.providerToken,
      rec.pushX25519PubHex, rec.registrationSignatureHex,
      rec.registeredAt, rec.lastSeenAt,
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
}

interface RawPushRow {
  token_id: string; username: string; platform: string; provider_token: string;
  push_x25519_pub_hex: string; registration_signature_hex: string;
  registered_at: number; last_seen_at: number;
}
function pushRowToRecord(r: RawPushRow): PushTokenRecord {
  return {
    tokenId: r.token_id,
    username: r.username,
    platform: r.platform as "apns" | "fcm" | "webpush",
    providerToken: r.provider_token,
    pushX25519PubHex: r.push_x25519_pub_hex,
    registrationSignatureHex: r.registration_signature_hex,
    registeredAt: r.registered_at,
    lastSeenAt: r.last_seen_at,
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
          apps_served_json, last_reported)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(
        rec.serverDomain.toLowerCase(),
        rec.certSha256,
        rec.certValidUntil,
        rec.certIssuer,
        rec.appsServedJson,
        rec.lastReported,
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
        apps_served_json: string;
        last_reported: number;
      }>();
    if (!r) return undefined;
    return {
      serverDomain: r.server_domain,
      certSha256: r.cert_sha256,
      certValidUntil: r.cert_valid_until,
      certIssuer: r.cert_issuer,
      appsServedJson: r.apps_served_json,
      lastReported: r.last_reported,
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
        apps_served_json: string;
        last_reported: number;
      }>();
    return (r.results ?? []).map((row) => ({
      serverDomain: row.server_domain,
      certSha256: row.cert_sha256,
      certValidUntil: row.cert_valid_until,
      certIssuer: row.cert_issuer,
      appsServedJson: row.apps_served_json,
      lastReported: row.last_reported,
    }));
  }
}

export class D1Storage implements Storage {
  usernames: UsernameStorage;
  usernameAliases: UsernameAliasStorage;
  daemonStatus: DaemonStatusStorage;
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
  constructor(db: D1Database) {
    this.usernames = new D1UsernameStorage(db);
    this.usernameAliases = new D1UsernameAliasStorage(db);
    this.daemonStatus = new D1DaemonStatusStorage(db);
    this.authCodes = new D1AuthCodeStorage(db);
    this.buildTickets = new D1BuildTicketStorage(db);
    this.servers = new D1ServerStorage(db);
    this.routing = new D1RoutingStorage(db);
    this.installEvents = new D1InstallEventStorage(db);
    this.luksKeys = new D1LuksKeyStorage(db);
    this.autoUnlockLeases = new D1AutoUnlockLeaseStorage(db);
    this.pendingUnlockApprovals = new D1PendingUnlockApprovalStorage(db);
    this.pendingRePairs = new D1PendingRePairStorage(db);
    this.webauthnRecovery = new D1WebauthnRecoveryStorage(db);
    this.marketplace = new D1MarketplaceStorage(db);
    this.pushTokens = new D1PushTokenStorage(db);
    this.llmPromo = new D1LlmPromoStorage(db);
    this.tiers = new D1TierStorage(db);
    this.entitlementRevocations = new D1EntitlementRevocationStorage(db);
    this.userIdentity = new D1UserIdentityRecordStorage(db);
  }
}
