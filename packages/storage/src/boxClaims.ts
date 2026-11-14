/**
 * Retail box claims at `.com` (migration 0134; docs/retail-box-setup.md §4 step 8, §15.1):
 * the box key a phone pre-registered under an AuthCode, and the blind remote-claim mailbox.
 */
import type { D1Database } from "./d1.js";

export interface BoxClaimKeyRecord {
  serial: string;
  username: string;
  serverDomain: string;
  stkPubHex: string;
  signerPubHex: string;
  issuedAt: number;
  recordedAt: number;
}

export type BoxClaimMailboxDir = "to-box" | "to-phone";

export interface BoxClaimMailboxLimits {
  /** A mailbox lives this long from its first message. */
  ttlMs: number;
  maxPerDir: number;
}

export interface BoxClaimStorage {
  getKey(serial: string): Promise<BoxClaimKeyRecord | null>;
  /** Stores `rec` unless the serial already has a key; returns the stored row either way. */
  putKeyOnce(rec: BoxClaimKeyRecord): Promise<BoxClaimKeyRecord>;
  postMessage(
    mailboxId: string,
    dir: BoxClaimMailboxDir,
    body: string,
    now: number,
    limits: BoxClaimMailboxLimits,
  ): Promise<{ ok: true; seq: number } | { ok: false; reason: "full" }>;
  readMessages(mailboxId: string, dir: BoxClaimMailboxDir, after: number, now: number): Promise<Array<{ seq: number; body: string }>>;
  sweep(now: number): Promise<number>;
}

interface KeyRow {
  serial: string;
  username: string;
  server_domain: string;
  stk_pub_hex: string;
  signer_pub_hex: string;
  issued_at: number;
  recorded_at: number;
}

const fromRow = (r: KeyRow): BoxClaimKeyRecord => ({
  serial: r.serial,
  username: r.username,
  serverDomain: r.server_domain,
  stkPubHex: r.stk_pub_hex,
  signerPubHex: r.signer_pub_hex,
  issuedAt: r.issued_at,
  recordedAt: r.recorded_at,
});

export class D1BoxClaimStorage implements BoxClaimStorage {
  constructor(private readonly db: D1Database) {}

  async getKey(serial: string) {
    const r = await this.db.prepare("SELECT * FROM box_claim_keys WHERE serial = ?1").bind(serial).first<KeyRow>();
    return r ? fromRow(r) : null;
  }

  async putKeyOnce(rec: BoxClaimKeyRecord) {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO box_claim_keys (serial, username, server_domain, stk_pub_hex, signer_pub_hex, issued_at, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(rec.serial, rec.username, rec.serverDomain, rec.stkPubHex.toLowerCase(), rec.signerPubHex.toLowerCase(), rec.issuedAt, rec.recordedAt)
      .run();
    return (await this.getKey(rec.serial))!;
  }

  async postMessage(mailboxId: string, dir: BoxClaimMailboxDir, body: string, now: number, limits: BoxClaimMailboxLimits) {
    await this.db.prepare("DELETE FROM box_claim_mailbox WHERE mailbox_id = ?1 AND expires_at <= ?2").bind(mailboxId, now).run();
    const r = await this.db
      .prepare(
        `INSERT INTO box_claim_mailbox (mailbox_id, dir, seq, body, created_at, expires_at)
         SELECT ?1, ?2, COALESCE(MAX(seq), 0) + 1, ?3, ?4,
                COALESCE((SELECT MIN(expires_at) FROM box_claim_mailbox WHERE mailbox_id = ?1), ?5)
         FROM box_claim_mailbox WHERE mailbox_id = ?1 AND dir = ?2
         HAVING COUNT(*) < ?6
         RETURNING seq`,
      )
      .bind(mailboxId, dir, body, now, now + limits.ttlMs, limits.maxPerDir)
      .first<{ seq: number }>();
    return r ? { ok: true as const, seq: r.seq } : { ok: false as const, reason: "full" as const };
  }

  async readMessages(mailboxId: string, dir: BoxClaimMailboxDir, after: number, now: number) {
    const r = await this.db
      .prepare("SELECT seq, body FROM box_claim_mailbox WHERE mailbox_id = ?1 AND dir = ?2 AND seq > ?3 AND expires_at > ?4 ORDER BY seq LIMIT 64")
      .bind(mailboxId, dir, after, now)
      .all<{ seq: number; body: string }>();
    return r.results ?? [];
  }

  async sweep(now: number) {
    const r = await this.db.prepare("DELETE FROM box_claim_mailbox WHERE expires_at <= ?1").bind(now).run();
    return r.meta?.changes ?? 0;
  }
}

export class InMemoryBoxClaimStorage implements BoxClaimStorage {
  private readonly keys = new Map<string, BoxClaimKeyRecord>();
  private readonly mail: Array<{ mailboxId: string; dir: BoxClaimMailboxDir; seq: number; body: string; expiresAt: number }> = [];

  async getKey(serial: string) {
    const r = this.keys.get(serial);
    return r ? { ...r } : null;
  }

  async putKeyOnce(rec: BoxClaimKeyRecord) {
    if (!this.keys.has(rec.serial)) this.keys.set(rec.serial, { ...rec, stkPubHex: rec.stkPubHex.toLowerCase(), signerPubHex: rec.signerPubHex.toLowerCase() });
    return { ...this.keys.get(rec.serial)! };
  }

  async postMessage(mailboxId: string, dir: BoxClaimMailboxDir, body: string, now: number, limits: BoxClaimMailboxLimits) {
    for (let i = this.mail.length - 1; i >= 0; i--) if (this.mail[i]!.mailboxId === mailboxId && this.mail[i]!.expiresAt <= now) this.mail.splice(i, 1);
    const box = this.mail.filter((m) => m.mailboxId === mailboxId);
    const mine = box.filter((m) => m.dir === dir);
    if (mine.length >= limits.maxPerDir) return { ok: false as const, reason: "full" as const };
    const seq = mine.reduce((a, m) => Math.max(a, m.seq), 0) + 1;
    const expiresAt = box.length ? Math.min(...box.map((m) => m.expiresAt)) : now + limits.ttlMs;
    this.mail.push({ mailboxId, dir, seq, body, expiresAt });
    return { ok: true as const, seq };
  }

  async readMessages(mailboxId: string, dir: BoxClaimMailboxDir, after: number, now: number) {
    return this.mail
      .filter((m) => m.mailboxId === mailboxId && m.dir === dir && m.seq > after && m.expiresAt > now)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, 64)
      .map((m) => ({ seq: m.seq, body: m.body }));
  }

  async sweep(now: number) {
    const before = this.mail.length;
    for (let i = this.mail.length - 1; i >= 0; i--) if (this.mail[i]!.expiresAt <= now) this.mail.splice(i, 1);
    return before - this.mail.length;
  }
}
