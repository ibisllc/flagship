/**
 * Blind-signed vouchers (migration 0152, docs/payments-privacy-and-rails.md "As built"): the spent nullifiers (no
 * account, no address, the day only) and the sealed wallet each account's devices sync.
 */
import type { D1Database } from "./d1.js";

export interface BlindVoucherStorage {
  /** Record each nullifier as spent; true where this call spent it, false where it was already spent. */
  spend(items: ReadonlyArray<{ nullifier: string; keyId: string }>, day: string): Promise<boolean[]>;
  /** Put back nullifiers this request spent (an all-or-nothing spend that failed part way). */
  unspend(nullifiers: readonly string[]): Promise<void>;
  isSpent(nullifier: string): Promise<boolean>;
  getWallet(username: string): Promise<{ version: number; blob: string } | null>;
  /** Compare-and-set: version must be the stored one + 1 (1 for the first). */
  putWallet(username: string, version: number, blob: string, at: number): Promise<boolean>;
  deleteWallet(username: string): Promise<void>;
}

export class D1BlindVoucherStorage implements BlindVoucherStorage {
  constructor(private readonly db: D1Database) {}

  async spend(items: ReadonlyArray<{ nullifier: string; keyId: string }>, day: string): Promise<boolean[]> {
    if (items.length === 0) return [];
    // Won = the row this statement inserted came back. Not `meta.changes`: inside a D1 batch it isn't the one
    // statement's count (the live gym, 2026-11-17: of three fresh vouchers one was credited and two reported spent).
    const sql = "INSERT INTO voucher_nullifiers (nullifier, key_id, spent_day) VALUES (?1, ?2, ?3) ON CONFLICT(nullifier) DO NOTHING RETURNING nullifier";
    const res = await this.db.batch(items.map((i) => this.db.prepare(sql).bind(i.nullifier, i.keyId, day)));
    return res.map((r, n) => (r.results ?? []).some((row) => (row as { nullifier?: unknown }).nullifier === items[n]!.nullifier));
  }

  async unspend(nullifiers: readonly string[]): Promise<void> {
    if (nullifiers.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM voucher_nullifiers WHERE nullifier = ?1");
    await this.db.batch(nullifiers.map((n) => stmt.bind(n)));
  }

  async isSpent(nullifier: string): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 AS x FROM voucher_nullifiers WHERE nullifier = ?1").bind(nullifier).first<{ x: number }>()) !== null;
  }

  async getWallet(username: string) {
    const r = await this.db.prepare("SELECT version, blob FROM voucher_wallets WHERE username = ?1").bind(username).first<{ version: number; blob: string }>();
    return r ? { version: r.version, blob: r.blob } : null;
  }

  async putWallet(username: string, version: number, blob: string, at: number) {
    const r =
      version === 1
        ? await this.db.prepare("INSERT OR IGNORE INTO voucher_wallets (username, version, blob, updated_at) VALUES (?1, 1, ?2, ?3)").bind(username, blob, at).run()
        : await this.db
            .prepare("UPDATE voucher_wallets SET version = ?2, blob = ?3, updated_at = ?4 WHERE username = ?1 AND version = ?2 - 1")
            .bind(username, version, blob, at)
            .run();
    return (r.meta.changes ?? 0) === 1;
  }

  async deleteWallet(username: string) {
    await this.db.prepare("DELETE FROM voucher_wallets WHERE username = ?1").bind(username).run();
  }
}

export class InMemoryBlindVoucherStorage implements BlindVoucherStorage {
  readonly spent = new Map<string, { keyId: string; day: string }>();
  readonly wallets = new Map<string, { version: number; blob: string }>();

  async spend(items: ReadonlyArray<{ nullifier: string; keyId: string }>, day: string) {
    return items.map((i) => {
      if (this.spent.has(i.nullifier)) return false;
      this.spent.set(i.nullifier, { keyId: i.keyId, day });
      return true;
    });
  }
  async unspend(nullifiers: readonly string[]) {
    for (const n of nullifiers) this.spent.delete(n);
  }
  async isSpent(nullifier: string) {
    return this.spent.has(nullifier);
  }
  async getWallet(username: string) {
    return this.wallets.get(username) ?? null;
  }
  async putWallet(username: string, version: number, blob: string) {
    const cur = this.wallets.get(username)?.version ?? 0;
    if (version !== cur + 1) return false;
    this.wallets.set(username, { version, blob });
    return true;
  }
  async deleteWallet(username: string) {
    this.wallets.delete(username);
  }
}
