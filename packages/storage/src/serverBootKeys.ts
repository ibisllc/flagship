/**
 * The boot key binding per server (migration 0110): the STK-signed statement
 * that names the key a box keeps on /boot for the jobs before its disk is open
 * (packages/protocol/src/bootKey.ts). `.com` verifies it against the server's
 * registered STK before storing; readers check it again against the STK the
 * server has now, so a binding left over from an older STK is never used.
 */
import type { D1Database } from "./d1.js";

export interface ServerBootKeyRecord {
  serverDomain: string;
  stkPubHex: string;
  bootKeyPubHex: string;
  issuedAt: number;
  signatureHex: string;
  storedAt: number;
}

export interface ServerBootKeyStorage {
  get(serverDomain: string): Promise<ServerBootKeyRecord | null>;
  /** Stores `rec` unless a binding for the same STK at least as new is already stored. */
  putIfNewer(rec: ServerBootKeyRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  delete(serverDomain: string): Promise<boolean>;
}

interface Row {
  server_domain: string;
  stk_pub_hex: string;
  boot_key_pub_hex: string;
  issued_at: number;
  signature_hex: string;
  stored_at: number;
}

const STALE = "a binding at least as new is already stored";

function fromRow(r: Row): ServerBootKeyRecord {
  return {
    serverDomain: r.server_domain,
    stkPubHex: r.stk_pub_hex,
    bootKeyPubHex: r.boot_key_pub_hex,
    issuedAt: r.issued_at,
    signatureHex: r.signature_hex,
    storedAt: r.stored_at,
  };
}

export class D1ServerBootKeyStorage implements ServerBootKeyStorage {
  constructor(private readonly db: D1Database) {}

  async get(serverDomain: string) {
    const r = await this.db
      .prepare("SELECT * FROM server_boot_keys WHERE server_domain = ?1")
      .bind(serverDomain.toLowerCase())
      .first<Row>();
    return r ? fromRow(r) : null;
  }

  async putIfNewer(rec: ServerBootKeyRecord) {
    // A binding from another STK (a rotation) always replaces; one from the same STK only when newer.
    const r = await this.db
      .prepare(
        `INSERT INTO server_boot_keys (server_domain, stk_pub_hex, boot_key_pub_hex, issued_at, signature_hex, stored_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(server_domain) DO UPDATE SET
           stk_pub_hex = excluded.stk_pub_hex,
           boot_key_pub_hex = excluded.boot_key_pub_hex,
           issued_at = excluded.issued_at,
           signature_hex = excluded.signature_hex,
           stored_at = excluded.stored_at
         WHERE excluded.stk_pub_hex != server_boot_keys.stk_pub_hex
            OR excluded.issued_at > server_boot_keys.issued_at`,
      )
      .bind(
        rec.serverDomain.toLowerCase(),
        rec.stkPubHex.toLowerCase(),
        rec.bootKeyPubHex.toLowerCase(),
        rec.issuedAt,
        rec.signatureHex.toLowerCase(),
        rec.storedAt,
      )
      .run();
    return (r.meta?.changes ?? 0) > 0 ? { ok: true as const } : { ok: false as const, reason: STALE };
  }

  async delete(serverDomain: string) {
    const r = await this.db
      .prepare("DELETE FROM server_boot_keys WHERE server_domain = ?1")
      .bind(serverDomain.toLowerCase())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
}

export class InMemoryServerBootKeyStorage implements ServerBootKeyStorage {
  private readonly rows = new Map<string, ServerBootKeyRecord>();

  async get(serverDomain: string) {
    const r = this.rows.get(serverDomain.toLowerCase());
    return r ? { ...r } : null;
  }

  async putIfNewer(rec: ServerBootKeyRecord) {
    const key = rec.serverDomain.toLowerCase();
    const cur = this.rows.get(key);
    const next = {
      ...rec,
      serverDomain: key,
      stkPubHex: rec.stkPubHex.toLowerCase(),
      bootKeyPubHex: rec.bootKeyPubHex.toLowerCase(),
      signatureHex: rec.signatureHex.toLowerCase(),
    };
    if (cur && cur.stkPubHex === next.stkPubHex && cur.issuedAt >= next.issuedAt) {
      return { ok: false as const, reason: STALE };
    }
    this.rows.set(key, next);
    return { ok: true as const };
  }

  async delete(serverDomain: string) {
    return this.rows.delete(serverDomain.toLowerCase());
  }
}
