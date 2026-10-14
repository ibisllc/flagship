// A MeterStore on a synchronous SQLite driver: node:sqlite (Node 22.13+),
// better-sqlite3, or anything with the same prepare/get/exec surface (Bun's
// bun:sqlite as well). The driver is duck-typed, so this package has no
// dependencies of its own.

import {
  meterSchemaSql,
  meterTableNames,
  type MeterBatchEntry,
  type MeterBatchResult,
  type MeterCounter,
  type MeterStore,
  type MeterTables,
} from "@ibisllc/billing-metering";

export interface SqliteStatementLike {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): unknown;
}

export interface SqliteMeterStoreOptions {
  /** Table names. Default `meter_counters` / `meter_batches`. */
  tables?: MeterTables;
}

interface CounterRow {
  account: string;
  resource: string;
  period: string;
  amount: number | bigint;
  updated_at: number | bigint;
}

/** Counters and idempotent batches in two SQLite tables (`meterSchemaSql`).
 *
 *  Every call runs synchronously on the driver, so within one process calls
 *  never interleave; `addBatch` is one `BEGIN IMMEDIATE` transaction, which
 *  also keeps several processes sharing one file correct (set a
 *  `busy_timeout` so they wait for each other instead of failing). Don't call
 *  it while your own transaction is open on the same connection. */
export class SqliteMeterStore implements MeterStore {
  private readonly t: Required<MeterTables>;
  private readonly stmts = new Map<string, SqliteStatementLike>();

  constructor(
    private readonly db: SqliteDatabaseLike,
    opts: SqliteMeterStoreOptions = {},
  ) {
    this.t = meterTableNames(opts.tables);
  }

  /** Create the tables if they are missing. Safe on every start. */
  migrate(): void {
    this.db.exec(meterSchemaSql(this.t));
  }

  private stmt(sql: string): SqliteStatementLike {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private addNow(account: string, resource: string, period: string, amount: number, now: number): number {
    const r = this.stmt(
      `INSERT INTO ${this.t.counters} (account, resource, period, amount, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account, resource, period) DO UPDATE SET
         amount     = ${this.t.counters}.amount + excluded.amount,
         updated_at = excluded.updated_at
       RETURNING amount`,
    ).get(account, resource, period, whole(amount), now) as { amount: number | bigint };
    return Number(r.amount);
  }

  async add(account: string, resource: string, period: string, amount: number, now: number): Promise<number> {
    return this.addNow(account, resource, period, amount, now);
  }

  async get(account: string, resource: string, period: string): Promise<MeterCounter | undefined> {
    const r = this.stmt(
      `SELECT account, resource, period, amount, updated_at FROM ${this.t.counters}
       WHERE account = ? AND resource = ? AND period = ?`,
    ).get(account, resource, period) as CounterRow | undefined;
    return r
      ? { account: r.account, resource: r.resource, period: r.period, amount: Number(r.amount), updatedAt: Number(r.updated_at) }
      : undefined;
  }

  /** One transaction: prune up to 32 expired ids, claim the id (or re-claim
   *  an expired one), and add every entry only if the claim succeeded. */
  async addBatch(batchId: string, entries: MeterBatchEntry[], now: number, keepUntil: number): Promise<MeterBatchResult> {
    const { batches } = this.t;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmt(
        `DELETE FROM ${batches} WHERE batch_id IN
           (SELECT batch_id FROM ${batches} WHERE keep_until < ? AND batch_id <> ? LIMIT 32)`,
      ).run(now, batchId);
      const claimed = this.stmt(
        `INSERT INTO ${batches} (batch_id, claim, keep_until) VALUES (?, ?, ?)
         ON CONFLICT (batch_id) DO UPDATE SET claim = excluded.claim, keep_until = excluded.keep_until
           WHERE ${batches}.keep_until < ?
         RETURNING batch_id`,
      ).get(batchId, CLAIM, keepUntil, now);
      if (!claimed) {
        this.db.exec("COMMIT");
        return { duplicate: true };
      }
      const totals = entries.map((e) => this.addNow(e.account, e.resource, e.period, e.amount, now));
      this.db.exec("COMMIT");
      return { duplicate: false, totals };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

// The transaction already makes the claim exclusive, so the claim column
// (which the D1 store needs) holds a constant here.
const CLAIM = "local";

function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
