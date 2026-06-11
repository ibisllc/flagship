/**
 * Replay defense — a single-use nonce within the freshness window.
 *
 * `claim(key, expiresAt, now)` returns true the FIRST time a key is
 * seen and false on every subsequent claim until `expiresAt`. The
 * production implementation is D1-backed (so replay defense survives
 * across the many short-lived Worker isolates); an in-memory variant is
 * used by tests and as a degraded fallback.
 */

import type { D1Database } from "@flagship/storage";

export interface NonceStore {
  /**
   * Atomically record `key` as seen. Returns true iff this is the first
   * time the key was claimed (and the prior claim, if any, had expired).
   * `expiresAt` is when the row may be GC'd; `now` is the current ms.
   */
  claim(key: string, expiresAt: number, now: number): Promise<boolean>;
}

/** In-memory nonce store — tests + single-isolate fallback only. */
export class InMemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();

  async claim(key: string, expiresAt: number, now: number): Promise<boolean> {
    // Opportunistic GC of expired keys so the map can't grow unbounded.
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(key, expiresAt);
    return true;
  }
}

/**
 * D1-backed nonce store. The PRIMARY KEY on `nonce_key` makes the
 * single-use claim atomic: a duplicate INSERT fails, which we map to
 * "already claimed". Expired rows are first deleted (so a key can be
 * reused once its window passes) and pruned opportunistically.
 */
export class D1NonceStore implements NonceStore {
  constructor(private readonly db: D1Database) {}

  async claim(key: string, expiresAt: number, now: number): Promise<boolean> {
    // Drop this key if a previous claim has expired, so the window can
    // reopen. Also prune a small batch of unrelated expired rows.
    await this.db.prepare("DELETE FROM boot_nonces WHERE nonce_key = ?1 AND expires_at <= ?2").bind(key, now).run();
    await this.db.prepare("DELETE FROM boot_nonces WHERE expires_at <= ?1").bind(now).run();
    try {
      await this.db
        .prepare("INSERT INTO boot_nonces (nonce_key, expires_at) VALUES (?1, ?2)")
        .bind(key, expiresAt)
        .run();
      return true;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) return false;
      throw e;
    }
  }
}
