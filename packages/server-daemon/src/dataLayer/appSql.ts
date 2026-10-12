/**
 * Bounded SQL against ONE app database, as that app's own role (never the
 * admin): the owner's Database section (dataLayer/ownerDb.ts, live data) and
 * the AI's `query_db` / `list_tables` tools (buildmodes/staging.ts, the
 * staging copy's dev database). docs/app-apis.md §6.
 *
 * Every call opens its own connection with the app role's URL (host forced
 * to 127.0.0.1, where Postgres listens), runs inside one transaction with
 * `SET LOCAL statement_timeout`, and closes. Values come back as Postgres
 * prints them (text), except booleans and small numbers.
 *
 * Read-only queries are a single statement over the extended protocol (it
 * refuses a second statement, so `COMMIT; DELETE …` can't end the READ ONLY
 * transaction), and a row query runs through a cursor so the box fetches at
 * most `maxRows + 1` rows however large the table is.
 */

export interface SqlColumn {
  name: string;
  type: string;
}

export interface SqlResult {
  /** The first word of the statement's tag (`SELECT`, `UPDATE`, `CREATE` …). */
  command: string;
  columns: SqlColumn[];
  rows: unknown[][];
  /** Rows the statement returned or changed, as Postgres reported it (≤ maxRows for a cursor). */
  rowCount: number | null;
  /** More rows existed than were returned. */
  truncated: boolean;
}

export interface TableInfo {
  /** `table` in the public schema, else `schema.table`. */
  name: string;
  kind: "table" | "view";
  /** The planner's estimate; exact for a small table never analyzed; null when unknown. */
  rows: number | null;
  bytes: number;
  columns: Array<SqlColumn & { nullable: boolean }>;
}

export interface TableRows {
  columns: SqlColumn[];
  rows: unknown[][];
  total: number;
}

/** A Postgres error with its SQLSTATE, as the console reports it. */
export class AppSqlError extends Error {
  constructor(
    message: string,
    readonly sqlState: string | null,
    readonly position: number | null = null,
  ) {
    super(message);
    this.name = "AppSqlError";
  }
  /** A write attempted in a READ ONLY transaction. */
  get readOnlyViolation(): boolean {
    return this.sqlState === "25006";
  }
  get timedOut(): boolean {
    return this.sqlState === "57014";
  }
}

export interface QueryArgs {
  pgUrl: string;
  sql: string;
  readOnly: boolean;
  maxRows: number;
  timeoutMs: number;
  /** Allow several `;`-separated statements (simple protocol). Never with readOnly. */
  multiStatement?: boolean;
}

/** What the console and the staging tools need from the database. */
export interface AppSqlRunner {
  query(a: QueryArgs): Promise<SqlResult>;
  listTables(a: { pgUrl: string; timeoutMs: number; columns?: boolean }): Promise<TableInfo[]>;
  tableRows(a: { pgUrl: string; table: string; offset: number; limit: number; timeoutMs: number }): Promise<TableRows>;
  /** The whole table as CSV, refusing past `maxBytes`. */
  exportCsv(a: { pgUrl: string; table: string; timeoutMs: number; maxBytes: number }): Promise<string>;
}

// ── the subset of node-postgres this module uses ──────────────────────

interface PgField {
  name: string;
  dataTypeID: number;
}
interface PgResult {
  command: string;
  rowCount: number | null;
  fields: PgField[];
  rows: unknown[][];
}
interface PgQueryConfig {
  text: string;
  values?: unknown[];
  rowMode?: "array";
  queryMode?: "extended";
}
export interface PgClientLike {
  query(cfg: PgQueryConfig): Promise<PgResult | PgResult[]>;
  end(): Promise<void>;
}

export type PgConnect = (a: { pgUrl: string; timeoutMs: number }) => Promise<PgClientLike>;

const CURSOR = "flagship_console";
const SAVEPOINT = "flagship_console_cursor";
/** A never-analyzed table this small is counted exactly. */
const EXACT_COUNT_MAX_BYTES = 8 * 1024 * 1024;
const CSV_BATCH_ROWS = 2000;

/** The app role's URL, pointed at the loopback Postgres the box runs. */
export function loopbackPgUrl(pgUrl: string): string {
  const url = new URL(pgUrl);
  url.hostname = "127.0.0.1";
  return url.toString();
}

/** Text for everything but booleans and the small number types. */
const TEXT_TYPES = {
  getTypeParser(oid: number): (v: string) => unknown {
    switch (oid) {
      case 16:
        return (v) => v === "t";
      case 21:
      case 23:
      case 26:
      case 700:
      case 701:
        return (v) => Number(v);
      default:
        return (v) => v;
    }
  },
};

export const realPgConnect: PgConnect = async ({ pgUrl, timeoutMs }) => {
  const { Client } = await import("pg");
  const c = new Client({
    connectionString: loopbackPgUrl(pgUrl),
    connectionTimeoutMillis: 5000,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs + 5000,
    application_name: "flagship-console",
    types: TEXT_TYPES,
  });
  await c.connect();
  return c as unknown as PgClientLike;
};

function last(r: PgResult | PgResult[]): PgResult {
  return Array.isArray(r) ? r[r.length - 1]! : r;
}

function asSqlError(e: unknown): AppSqlError {
  if (e instanceof AppSqlError) return e;
  const pe = e as { message?: string; code?: unknown; position?: unknown };
  const code = typeof pe.code === "string" && /^[0-9A-Z]{5}$/.test(pe.code) ? pe.code : null;
  const pos = typeof pe.position === "string" ? Number(pe.position) : null;
  let message = pe.message ?? String(e);
  if (code === "57014") message = "the statement ran too long and was cancelled";
  return new AppSqlError(message, code, pos != null && Number.isFinite(pos) ? pos : null);
}

/** Drop trailing `;` and blanks, so the statement can sit inside DECLARE. */
export function trimStatement(sql: string): string {
  return sql.replace(/[\s;]+$/, "");
}

function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "").replace(/^--[^\n]*(\n|$)/, "").replace(/^\/\*[\s\S]*?\*\//, "");
    if (s === before) return s;
  }
}

/** Whether a statement starts like a query that returns rows (comments skipped). */
export function looksLikeRowQuery(sql: string): boolean {
  return /^\(*\s*(select|with|values|table)\b/i.test(stripLeadingComments(sql));
}

/** `"schema"."table"` for a resolved table. */
function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

async function typeNames(c: PgClientLike, fields: PgField[]): Promise<SqlColumn[]> {
  const oids = [...new Set(fields.map((f) => f.dataTypeID))];
  const names = new Map<number, string>();
  if (oids.length > 0) {
    const r = last(
      await c.query({
        text: "SELECT oid::int, pg_catalog.format_type(oid, NULL) FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])",
        values: [oids],
        rowMode: "array",
      }),
    );
    for (const row of r.rows) names.set(Number(row[0]), String(row[1]));
  }
  return fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? String(f.dataTypeID) }));
}

async function inTransaction<T>(
  c: PgClientLike,
  a: { readOnly: boolean; timeoutMs: number },
  fn: () => Promise<T>,
): Promise<T> {
  const ms = Math.max(1, Math.floor(a.timeoutMs));
  await c.query({ text: a.readOnly ? "BEGIN READ ONLY" : "BEGIN" });
  try {
    await c.query({ text: `SET LOCAL statement_timeout = ${ms}` });
    const out = await fn();
    await c.query({ text: a.readOnly ? "ROLLBACK" : "COMMIT" });
    return out;
  } catch (e) {
    await c.query({ text: "ROLLBACK" }).catch(() => {});
    throw e instanceof NoSuchTableError || e instanceof ExportTooLargeError ? e : asSqlError(e);
  }
}

/** Run one bounded statement on an open connection (see the module comment). */
export async function runBoundedQuery(c: PgClientLike, a: Omit<QueryArgs, "pgUrl">): Promise<SqlResult> {
  const max = Math.max(1, Math.floor(a.maxRows));
  const multi = a.multiStatement === true && !a.readOnly;
  const body = trimStatement(a.sql);
  if (body.length === 0) throw new AppSqlError("the query is empty", null);
  if (/^copy\b/i.test(stripLeadingComments(body))) {
    throw new AppSqlError("COPY isn't available here; export a table as CSV instead", null);
  }
  return inTransaction(c, a, async () => {
    if (looksLikeRowQuery(body)) {
      await c.query({ text: `SAVEPOINT ${SAVEPOINT}` });
      let declared = true;
      try {
        await c.query({ text: `DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${body}\n`, queryMode: "extended" });
      } catch (e) {
        // Not a plain row query after all (a data-modifying WITH, SELECT
        // INTO, two statements …): run it as written below.
        if (asSqlError(e).sqlState === "57014") throw e;
        declared = false;
        await c.query({ text: `ROLLBACK TO SAVEPOINT ${SAVEPOINT}` });
      }
      if (declared) {
        const r = last(await c.query({ text: `FETCH FORWARD ${max + 1} FROM ${CURSOR}`, rowMode: "array" }));
        const rows = r.rows.slice(0, max);
        return {
          command: "SELECT",
          columns: await typeNames(c, r.fields),
          rows,
          rowCount: rows.length,
          truncated: r.rows.length > max,
        };
      }
    }
    const r = last(await c.query({ text: a.sql, rowMode: "array", ...(multi ? {} : { queryMode: "extended" as const }) }));
    const rows = (r.rows ?? []).slice(0, max);
    return {
      command: r.command ?? "",
      columns: r.fields?.length ? await typeNames(c, r.fields) : [],
      rows,
      rowCount: r.rowCount ?? null,
      truncated: (r.rows?.length ?? 0) > max,
    };
  });
}

const TABLES_SQL = `
SELECT n.nspname, c.relname, c.relkind::text, c.reltuples::float8, pg_catalog.pg_total_relation_size(c.oid)::float8
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
  AND NOT c.relispartition
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
ORDER BY (n.nspname <> 'public'), n.nspname, c.relname`;

const COLUMNS_SQL = `
SELECT n.nspname, c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), NOT a.attnotnull
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
ORDER BY n.nspname, c.relname, a.attnum`;

function displayName(schema: string, table: string): string {
  return schema === "public" ? table : `${schema}.${table}`;
}

export async function listTablesOn(c: PgClientLike, a: { timeoutMs: number; columns?: boolean }): Promise<TableInfo[]> {
  return inTransaction(c, { readOnly: true, timeoutMs: a.timeoutMs }, async () => {
    const t = last(await c.query({ text: TABLES_SQL, rowMode: "array" }));
    const out: TableInfo[] = [];
    const byKey = new Map<string, TableInfo>();
    for (const row of t.rows) {
      const [schema, table, relkind, reltuples, bytes] = row as [string, string, string, number | string, number | string];
      const kind = relkind === "v" ? "view" : "table";
      const estimate = Number(reltuples);
      const size = Number(bytes);
      let rows: number | null = kind === "view" ? null : estimate >= 0 ? Math.round(estimate) : null;
      if (rows === null && kind === "table" && relkind !== "f" && size <= EXACT_COUNT_MAX_BYTES) {
        const n = last(
          await c.query({ text: `SELECT count(*) FROM ${quoteIdent(schema)}.${quoteIdent(table)}`, rowMode: "array" }),
        );
        rows = Number(n.rows[0]?.[0] ?? 0);
      }
      const info: TableInfo = { name: displayName(schema, table), kind, rows, bytes: size, columns: [] };
      out.push(info);
      byKey.set(`${schema}\u0000${table}`, info);
    }
    if (a.columns !== false) {
      const cols = last(await c.query({ text: COLUMNS_SQL, rowMode: "array" }));
      for (const row of cols.rows) {
        const [schema, table, name, type, nullable] = row as [string, string, string, string, boolean];
        byKey.get(`${schema}\u0000${table}`)?.columns.push({ name, type, nullable: nullable === true });
      }
    }
    return out;
  });
}

/**
 * Find a table by the name `listTables` gave it (`table` in public, or
 * `schema.table`), in the catalog; null when there is none. The caller
 * never interpolates the name it was sent, only the catalog's.
 */
async function resolveTable(c: PgClientLike, name: string): Promise<{ schema: string; table: string } | null> {
  const candidates: Array<[string, string]> = [["public", name]];
  const dot = name.indexOf(".");
  if (dot > 0) candidates.push([name.slice(0, dot), name.slice(dot + 1)]);
  for (const [schema, table] of candidates) {
    const r = last(
      await c.query({
        text:
          "SELECT n.nspname, c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
          "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') " +
          "AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
        values: [schema, table],
        rowMode: "array",
      }),
    );
    const row = r.rows[0];
    if (row) return { schema: String(row[0]), table: String(row[1]) };
  }
  return null;
}

export class NoSuchTableError extends Error {
  constructor(name: string) {
    super(`no table named ${JSON.stringify(name)}`);
    this.name = "NoSuchTableError";
  }
}

export async function tableRowsOn(
  c: PgClientLike,
  a: { table: string; offset: number; limit: number; timeoutMs: number },
): Promise<TableRows> {
  return inTransaction(c, { readOnly: true, timeoutMs: a.timeoutMs }, async () => {
    const t = await resolveTable(c, a.table);
    if (!t) throw new NoSuchTableError(a.table);
    const from = `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
    const limit = Math.max(0, Math.floor(a.limit));
    const offset = Math.max(0, Math.floor(a.offset));
    const r = last(await c.query({ text: `SELECT * FROM ${from} LIMIT ${limit} OFFSET ${offset}`, rowMode: "array" }));
    const n = last(await c.query({ text: `SELECT count(*) FROM ${from}`, rowMode: "array" }));
    return { columns: await typeNames(c, r.fields), rows: r.rows, total: Number(n.rows[0]?.[0] ?? 0) };
  });
}

/** One CSV field (RFC 4180): quoted when it holds a comma, quote, CR or LF. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class ExportTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the table is larger than ${Math.round(maxBytes / (1024 * 1024))} MB as CSV; export it in parts with a query`);
    this.name = "ExportTooLargeError";
  }
}

export async function exportCsvOn(
  c: PgClientLike,
  a: { table: string; timeoutMs: number; maxBytes: number },
): Promise<string> {
  return inTransaction(c, { readOnly: true, timeoutMs: a.timeoutMs }, async () => {
    const t = await resolveTable(c, a.table);
    if (!t) throw new NoSuchTableError(a.table);
    await c.query({ text: `DECLARE ${CURSOR} NO SCROLL CURSOR FOR SELECT * FROM ${quoteIdent(t.schema)}.${quoteIdent(t.table)}` });
    const parts: string[] = [];
    let bytes = 0;
    let header = false;
    for (;;) {
      const r = last(await c.query({ text: `FETCH FORWARD ${CSV_BATCH_ROWS} FROM ${CURSOR}`, rowMode: "array" }));
      if (!header) {
        const line = `${r.fields.map((f) => csvField(f.name)).join(",")}\r\n`;
        parts.push(line);
        bytes += Buffer.byteLength(line);
        header = true;
      }
      for (const row of r.rows) {
        const line = `${row.map(csvField).join(",")}\r\n`;
        bytes += Buffer.byteLength(line);
        if (bytes > a.maxBytes) throw new ExportTooLargeError(a.maxBytes);
        parts.push(line);
      }
      if (r.rows.length < CSV_BATCH_ROWS) break;
    }
    return parts.join("");
  });
}

async function withConnection<T>(connect: PgConnect, a: { pgUrl: string; timeoutMs: number }, fn: (c: PgClientLike) => Promise<T>): Promise<T> {
  let c: PgClientLike;
  try {
    c = await connect(a);
  } catch (e) {
    throw new AppSqlError(`couldn't connect to the app's database: ${(e as Error).message}`, "08006");
  }
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

/** The runner over real connections (or a test's fake `connect`). */
export function appSqlRunner(connect: PgConnect = realPgConnect): AppSqlRunner {
  return {
    query: (a) => withConnection(connect, a, (c) => runBoundedQuery(c, a)),
    listTables: (a) => withConnection(connect, a, (c) => listTablesOn(c, a)),
    tableRows: (a) => withConnection(connect, a, (c) => tableRowsOn(c, a)),
    exportCsv: (a) => withConnection(connect, a, (c) => exportCsvOn(c, a)),
  };
}

/** A cell as the AI's tools show it: text capped at `maxChars`. */
export function compactCell(v: unknown, maxChars: number): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "number") return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}
