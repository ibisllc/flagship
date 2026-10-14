/**
 * The owner's server order (docs/server-order.md, migration 0096): the newest
 * signed order per account. `.com` verifies it before storing.
 */
import type { D1Database } from "./d1.js";

export interface ServerOrderRecord {
  username: string;
  /** The order as JSON `{user, stks, issuedAt, nonce}`. */
  orderJson: string;
  signatureHex: string;
  issuedAt: number;
}

export interface ServerOrderStorage {
  get(username: string): Promise<ServerOrderRecord | null>;
  /** Stores `rec` unless the account already holds an order at least as new. */
  putIfNewer(rec: ServerOrderRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  delete(username: string): Promise<boolean>;
}

interface ServerOrderRow {
  username: string;
  order_json: string;
  signature_hex: string;
  issued_at: number;
}

export class D1ServerOrderStorage implements ServerOrderStorage {
  constructor(private readonly db: D1Database) {}

  async get(username: string) {
    const row = await this.db
      .prepare("SELECT username, order_json, signature_hex, issued_at FROM server_orders WHERE username = ?1")
      .bind(username.toLowerCase())
      .first<ServerOrderRow>();
    return row
      ? { username: row.username, orderJson: row.order_json, signatureHex: row.signature_hex, issuedAt: row.issued_at }
      : null;
  }

  async putIfNewer(rec: ServerOrderRecord) {
    const r = await this.db
      .prepare(
        `INSERT INTO server_orders (username, order_json, signature_hex, issued_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(username) DO UPDATE SET
           order_json = excluded.order_json,
           signature_hex = excluded.signature_hex,
           issued_at = excluded.issued_at
         WHERE excluded.issued_at > server_orders.issued_at`,
      )
      .bind(rec.username.toLowerCase(), rec.orderJson, rec.signatureHex, rec.issuedAt)
      .run();
    return (r.meta?.changes ?? 0) > 0
      ? { ok: true as const }
      : { ok: false as const, reason: "a newer order is already stored" };
  }

  async delete(username: string) {
    const r = await this.db
      .prepare("DELETE FROM server_orders WHERE username = ?1")
      .bind(username.toLowerCase())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
}

export class InMemoryServerOrderStorage implements ServerOrderStorage {
  private rows = new Map<string, ServerOrderRecord>();

  async get(username: string) {
    const r = this.rows.get(username.toLowerCase());
    return r ? { ...r } : null;
  }

  async putIfNewer(rec: ServerOrderRecord) {
    const key = rec.username.toLowerCase();
    const existing = this.rows.get(key);
    if (existing && rec.issuedAt <= existing.issuedAt) {
      return { ok: false as const, reason: "a newer order is already stored" };
    }
    this.rows.set(key, { ...rec, username: key });
    return { ok: true as const };
  }

  async delete(username: string) {
    return this.rows.delete(username.toLowerCase());
  }
}
