// A MeterStore on Cloudflare D1 (or anything with D1's prepare/bind/batch
// surface). The binding is duck-typed, so this package needs no Workers
// types and builds anywhere.

import {
  meterSchemaSql,
  meterTableNames,
  type MeterBatchEntry,
  type MeterBatchResult,
  type MeterCounter,
  type MeterStore,
  type MeterTables,
} from "@ibisllc/billing-metering";

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  /** Runs the statements as one transaction (D1's `batch`). */
  batch(statements: D1PreparedStatementLike[]): Promise<Array<{ results?: unknown[] }>>;
}

export interface D1MeterStoreOptions {
  /** Table names. Default `meter_counters` / `meter_batches`. */
  tables?: MeterTables;
}

/** The D1 schema (CREATE TABLE IF NOT EXISTS), for a migration file or
 *  `D1MeterStore.migrate`. */
export function d1MeterSchema(tables?: MeterTables): string {
  return meterSchemaSql(tables);
}

/** Counters and idempotent batches in two D1 tables (`meterSchemaSql`).
 *  `add` and `get` are one statement each; `addBatch` is one `batch()`, so
 *  one transaction and one round trip whatever the batch size. */
export class D1MeterStore implements MeterStore {
  private readonly t: Required<MeterTables>;

  constructor(
    private readonly db: D1DatabaseLike,
    opts: D1MeterStoreOptions = {},
  ) {
    this.t = meterTableNames(opts.tables);
  }

  /** Create the tables if they are missing (one batch). Most D1 projects
   *  ship `d1MeterSchema()` as a migration instead. */
  async migrate(): Promise<void> {
    const statements = meterSchemaSql(this.t)
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => this.db.prepare(s));
    await this.db.batch(statements);
  }

  async add(account: string, resource: string, period: string, amount: number, now: number): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO ${this.t.counters} (account, resource, period, amount, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(account, resource, period) DO UPDATE SET
           amount     = ${this.t.counters}.amount + excluded.amount,
           updated_at = excluded.updated_at
         RETURNING amount`,
      )
      .bind(account, resource, period, whole(amount), now)
      .first<{ amount: number }>();
    return Number(r?.amount ?? 0);
  }

  async get(account: string, resource: string, period: string): Promise<MeterCounter | undefined> {
    const r = await this.db
      .prepare(
        `SELECT account, resource, period, amount, updated_at FROM ${this.t.counters}
         WHERE account = ? AND resource = ? AND period = ?`,
      )
      .bind(account, resource, period)
      .first<{ account: string; resource: string; period: string; amount: number; updated_at: number }>();
    return r
      ? { account: r.account, resource: r.resource, period: r.period, amount: Number(r.amount), updatedAt: Number(r.updated_at) }
      : undefined;
  }

  /** One D1 batch, i.e. one transaction: prune a few expired ids, claim this
   *  id with a fresh token (or re-claim it if its record expired), then add
   *  each entry only if this call holds the claim. A retried id finds the
   *  earlier claim, so its adds change nothing. */
  async addBatch(batchId: string, entries: MeterBatchEntry[], now: number, keepUntil: number): Promise<MeterBatchResult> {
    const { counters, batches } = this.t;
    const claim = crypto.randomUUID();
    const res = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM ${batches} WHERE batch_id IN
             (SELECT batch_id FROM ${batches} WHERE keep_until < ? AND batch_id <> ? LIMIT 32)`,
        )
        .bind(now, batchId),
      this.db
        .prepare(
          `INSERT INTO ${batches} (batch_id, claim, keep_until) VALUES (?,?,?)
           ON CONFLICT(batch_id) DO UPDATE SET claim = excluded.claim, keep_until = excluded.keep_until
             WHERE ${batches}.keep_until < ?
           RETURNING batch_id`,
        )
        .bind(batchId, claim, keepUntil, now),
      ...entries.map((e) =>
        this.db
          .prepare(
            `INSERT INTO ${counters} (account, resource, period, amount, updated_at)
             SELECT ?,?,?,?,?
             WHERE EXISTS (SELECT 1 FROM ${batches} WHERE batch_id = ? AND claim = ?)
             ON CONFLICT(account, resource, period) DO UPDATE SET
               amount     = ${counters}.amount + excluded.amount,
               updated_at = excluded.updated_at
             RETURNING amount`,
          )
          .bind(e.account, e.resource, e.period, whole(e.amount), now, batchId, claim),
      ),
    ]);
    if ((res[1]?.results?.length ?? 0) === 0) return { duplicate: true };
    return {
      duplicate: false,
      totals: entries.map((_, i) => Number((res[i + 2]?.results?.[0] as { amount: number } | undefined)?.amount ?? 0)),
    };
  }
}

function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
