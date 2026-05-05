import type {
  AuthCodeRecord,
  AuthCodeStorage,
  BuildTicketRecord,
  BuildTicketStorage,
  RoutingRecord,
  RoutingStorage,
  ServerRecord,
  ServerStorage,
  Storage,
  UsernameRecord,
  UsernameStorage,
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

export class D1Storage implements Storage {
  usernames: UsernameStorage;
  authCodes: AuthCodeStorage;
  buildTickets: BuildTicketStorage;
  servers: ServerStorage;
  routing: RoutingStorage;
  constructor(db: D1Database) {
    this.usernames = new D1UsernameStorage(db);
    this.authCodes = new D1AuthCodeStorage(db);
    this.buildTickets = new D1BuildTicketStorage(db);
    this.servers = new D1ServerStorage(db);
    this.routing = new D1RoutingStorage(db);
  }
}
