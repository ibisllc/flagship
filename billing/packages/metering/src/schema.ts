// The portable SQL schema for a MeterStore (SQLite 3.35+, Cloudflare D1,
// PostgreSQL). schema/meter_counters.sql and schema/meter_batches.sql are the
// same DDL with the default table names and the statements documented.

/** Table names a SQL store uses. Defaults: `meter_counters`, `meter_batches`. */
export interface MeterTables {
  counters?: string;
  batches?: string;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,51}$/;

/** Resolve and validate table names: plain SQL identifiers (safe to
 *  interpolate) of at most 52 characters, so the index name fits in 63. */
export function meterTableNames(t: MeterTables = {}): Required<MeterTables> {
  const counters = t.counters ?? "meter_counters";
  const batches = t.batches ?? "meter_batches";
  for (const n of [counters, batches]) {
    if (!IDENT_RE.test(n)) throw new RangeError(`table name must be a plain SQL identifier: ${n}`);
  }
  if (counters === batches) throw new RangeError("counters and batches need different tables");
  return { counters, batches };
}

/** CREATE TABLE IF NOT EXISTS statements for both tables, portable across
 *  SQLite (incl. D1) and PostgreSQL. Safe to run on every start. */
export function meterSchemaSql(t: MeterTables = {}): string {
  const { counters, batches } = meterTableNames(t);
  return `CREATE TABLE IF NOT EXISTS ${counters} (
  account    TEXT   NOT NULL,
  resource   TEXT   NOT NULL,
  period     TEXT   NOT NULL,
  amount     BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (account, resource, period)
);

CREATE TABLE IF NOT EXISTS ${batches} (
  batch_id   TEXT   NOT NULL PRIMARY KEY,
  claim      TEXT   NOT NULL,
  keep_until BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS ${batches}_keep_until ON ${batches} (keep_until);
`;
}
