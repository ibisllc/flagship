// A MeterStore on PostgreSQL through any client with node-postgres's
// `query(text, values) → { rows }`: a pg.Pool (recommended), a pg.Client,
// PGlite, or a wrapper around postgres.js / Neon / Vercel. Duck-typed, so
// this package has no dependencies of its own.

import {
  meterSchemaSql,
  meterTableNames,
  type MeterBatchEntry,
  type MeterBatchResult,
  type MeterCounter,
  type MeterStore,
  type MeterTables,
} from "@ibisllc/billing-metering";

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PostgresMeterStoreOptions {
  /** Table names. Default `meter_counters` / `meter_batches`. */
  tables?: MeterTables;
  /** A schema to qualify the tables with (a plain identifier). Default: the
   *  connection's search_path. */
  schema?: string;
}

interface CounterRow {
  account: string;
  resource: string;
  period: string;
  amount: string | number | bigint;
  updated_at: string | number | bigint;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Counters and idempotent batches in two PostgreSQL tables
 *  (`meterSchemaSql`). Every operation, `addBatch` included, is ONE
 *  statement, so it is atomic on any connection (a pool needs no checkout)
 *  and costs one round trip. */
export class PostgresMeterStore implements MeterStore {
  private readonly counters: string;
  private readonly batches: string;
  private readonly ddl: string;

  constructor(
    private readonly db: PgQueryable,
    opts: PostgresMeterStoreOptions = {},
  ) {
    const t = meterTableNames(opts.tables);
    if (opts.schema !== undefined && !IDENT_RE.test(opts.schema)) {
      throw new RangeError(`schema must be a plain SQL identifier: ${opts.schema}`);
    }
    const q = opts.schema ? `${opts.schema}.` : "";
    this.counters = q + t.counters;
    this.batches = q + t.batches;
    this.ddl = meterSchemaSql(t)
      .replace(/(CREATE TABLE IF NOT EXISTS |ON )(\w+)/g, (_, kw: string, name: string) => kw + q + name);
  }

  /** Create the tables if they are missing. Safe on every start. */
  async migrate(): Promise<void> {
    for (const s of this.ddl.split(";").map((x) => x.trim()).filter(Boolean)) await this.db.query(s);
  }

  async add(account: string, resource: string, period: string, amount: number, now: number): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO ${this.counters} AS c (account, resource, period, amount, updated_at)
       VALUES ($1, $2, $3, $4::bigint, $5::bigint)
       ON CONFLICT (account, resource, period) DO UPDATE SET
         amount     = c.amount + EXCLUDED.amount,
         updated_at = EXCLUDED.updated_at
       RETURNING amount`,
      [account, resource, period, whole(amount), Math.floor(now)],
    );
    return Number((rows[0] as { amount: string }).amount);
  }

  async get(account: string, resource: string, period: string): Promise<MeterCounter | undefined> {
    const { rows } = await this.db.query(
      `SELECT account, resource, period, amount, updated_at FROM ${this.counters}
       WHERE account = $1 AND resource = $2 AND period = $3`,
      [account, resource, period],
    );
    const r = rows[0] as CounterRow | undefined;
    return r
      ? { account: r.account, resource: r.resource, period: r.period, amount: Number(r.amount), updatedAt: Number(r.updated_at) }
      : undefined;
  }

  /** One statement: prune up to 32 expired ids, claim the id (or re-claim an
   *  expired one) and, only if that claimed it, upsert every counter.
   *  Concurrent sends of one id serialise on the id's row, and the loser
   *  sees the winner's claim and adds nothing. */
  async addBatch(batchId: string, entries: MeterBatchEntry[], now: number, keepUntil: number): Promise<MeterBatchResult> {
    // One upsert row per distinct counter (Postgres can't touch a row twice
    // in one statement); running totals are rebuilt below.
    const keys = new Map<string, { account: string; resource: string; period: string; amount: number }>();
    const amounts = entries.map((e) => whole(e.amount));
    entries.forEach((e, i) => {
      const k = JSON.stringify([e.account, e.resource, e.period]);
      const m = keys.get(k);
      if (m) m.amount += amounts[i]!;
      else keys.set(k, { account: e.account, resource: e.resource, period: e.period, amount: amounts[i]! });
    });
    // Sorted, so concurrent batches lock shared counters in one order and
    // can't deadlock each other.
    const merged = [...keys.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, m]) => m);
    const { rows } = await this.db.query(
      `WITH pruned AS (
         DELETE FROM ${this.batches} WHERE batch_id IN
           (SELECT batch_id FROM ${this.batches} WHERE keep_until < $2::bigint AND batch_id <> $1 LIMIT 32)
       ), claimed AS (
         INSERT INTO ${this.batches} AS b (batch_id, claim, keep_until) VALUES ($1, $3, $4::bigint)
         ON CONFLICT (batch_id) DO UPDATE SET claim = EXCLUDED.claim, keep_until = EXCLUDED.keep_until
           WHERE b.keep_until < $2::bigint
         RETURNING batch_id
       ), added AS (
         INSERT INTO ${this.counters} AS c (account, resource, period, amount, updated_at)
         SELECT e.account, e.resource, e.period, e.amount, $2::bigint
         FROM unnest($5::text[], $6::text[], $7::text[], $8::bigint[]) AS e (account, resource, period, amount)
         WHERE EXISTS (SELECT 1 FROM claimed)
         ON CONFLICT (account, resource, period) DO UPDATE SET
           amount     = c.amount + EXCLUDED.amount,
           updated_at = EXCLUDED.updated_at
         RETURNING account, resource, period, amount
       )
       SELECT 'claim' AS kind, NULL AS account, NULL AS resource, NULL AS period, NULL AS amount FROM claimed
       UNION ALL
       SELECT 'add', account, resource, period, amount::text FROM added`,
      [
        batchId,
        Math.floor(now),
        "pg",
        Math.floor(keepUntil),
        merged.map((m) => m.account),
        merged.map((m) => m.resource),
        merged.map((m) => m.period),
        merged.map((m) => String(m.amount)),
      ],
    );
    const result = rows as Array<{ kind: string; account: string; resource: string; period: string; amount: string }>;
    if (!result.some((r) => r.kind === "claim")) return { duplicate: true };
    const finals = new Map<string, number>();
    for (const r of result) if (r.kind === "add") finals.set(JSON.stringify([r.account, r.resource, r.period]), Number(r.amount));
    // Walk the entries backwards from each counter's final total.
    const totals = new Array<number>(entries.length);
    const running = new Map(finals);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const k = JSON.stringify([e.account, e.resource, e.period]);
      const t = running.get(k) ?? 0;
      totals[i] = t;
      running.set(k, t - amounts[i]!);
    }
    return { duplicate: false, totals };
  }
}

function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
