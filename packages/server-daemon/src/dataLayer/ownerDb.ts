/**
 * The owner's Database section: an app's LIVE data, over the owner's paired
 * session only (docs/app-apis.md §6). Never reachable through MCP or by any
 * build tool: the AI's tools only ever see the staging copy's sample data
 * (buildmodes/staging.ts).
 *
 *   GET  /api/screens/services/:id/db                                → { stores:[{store, tables:[{name, kind, rows, bytes}]}] }
 *   GET  /api/screens/services/:id/db/:store/tables/:table?offset&limit → { columns:[{name, type}], rows, total }
 *   GET  /api/screens/services/:id/db/:store/tables/:table/export.csv  → text/csv
 *   POST /api/screens/services/:id/db/:store/query  { sql }           → { command, columns, rows, rowCount, truncated }  (READ ONLY)
 *   POST …/query  { sql, grant:{serverDomain, serviceId, store, sqlSha256, issuedAt}, signature }  → the same, read-write
 *
 * Everything runs as the app's own Postgres role (from its stored
 * credentials, never the admin), with a 15 s statement timeout and at most
 * 1000 rows returned. A write needs the owner's signed
 * `flagship/app-db-write/v1` order, checked under the box's sensitive-order
 * authority like every other signed order, at most 10 minutes old, and good
 * for one use. Companion sessions get 403 (screensHttp denies them before
 * this handler runs).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appDbSqlSha256, parseAppDbWriteGrant, verifyAppDbWriteGrant } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { SensitiveAuthority } from "../egress/approvals.js";
import { hexToBytes } from "../egress/accessStore.js";
import type { AppDataCredentials } from "./provisioner.js";
import { AppSqlError, ExportTooLargeError, NoSuchTableError, type AppSqlRunner } from "./appSql.js";

export const OWNER_DB_TIMEOUT_MS = 15_000;
export const OWNER_DB_MAX_ROWS = 1000;
export const OWNER_DB_DEFAULT_LIMIT = 100;
export const OWNER_DB_MAX_SQL_BYTES = 256 * 1024;
export const OWNER_DB_EXPORT_MAX_BYTES = 64 * 1024 * 1024;
export const DB_WRITE_MAX_SKEW_MS = 10 * 60_000;

const J = { "content-type": "application/json" } as const;
const DB_RE = /^\/api\/screens\/services\/([^/]+)\/db$/;
const TABLE_RE = /^\/api\/screens\/services\/([^/]+)\/db\/([^/]+)\/tables\/([^/]+)$/;
const EXPORT_RE = /^\/api\/screens\/services\/([^/]+)\/db\/([^/]+)\/tables\/([^/]+)\/export\.csv$/;
const QUERY_RE = /^\/api\/screens\/services\/([^/]+)\/db\/([^/]+)\/query$/;

export function isAppDbPath(path: string): boolean {
  return DB_RE.test(path) || TABLE_RE.test(path) || EXPORT_RE.test(path) || QUERY_RE.test(path);
}

/**
 * Each signed write order works once. The key is the order itself (service,
 * store, statement hash, issuedAt); it is remembered past the freshness
 * window, on disk when a path is given, so a restart can't reopen it.
 */
export class DbWriteLedger {
  private used = new Map<string, number>();
  private loading: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string | null,
    private readonly now: () => number = () => Date.now(),
    private readonly keepMs = 2 * DB_WRITE_MAX_SKEW_MS + 60_000,
  ) {}

  private load(): Promise<void> {
    this.loading ??= (async () => {
      if (!this.path) return;
      try {
        const raw = JSON.parse(await readFile(this.path, "utf8")) as { used?: Record<string, unknown> };
        for (const [k, t] of Object.entries(raw.used ?? {})) if (typeof t === "number") this.used.set(k, t);
      } catch {
        /* none yet */
      }
    })();
    return this.loading;
  }

  /** True the first time `key` is claimed (within the keep window). */
  async claim(key: string): Promise<boolean> {
    await this.load();
    const t = this.now();
    for (const [k, at] of this.used) if (at < t - this.keepMs) this.used.delete(k);
    if (this.used.has(key)) return false;
    this.used.set(key, t);
    await this.save();
    return true;
  }

  private save(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    const body = JSON.stringify({ used: Object.fromEntries(this.used) });
    const next = this.chain.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, body, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export interface OwnerDbHttpOptions extends SensitiveAuthority {
  /** The box FQDN every write order must name. */
  serverDomain: string;
  /** An installed service's data credentials; null when it isn't installed. */
  app: (serviceId: string) => { data: AppDataCredentials | null } | null;
  sql: AppSqlRunner;
  ledger?: DbWriteLedger;
  now?: () => number;
  log?: (m: string) => void;
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function intParam(q: URLSearchParams, name: string, dflt: number): number | null {
  const v = q.get(name);
  if (v === null || v === "") return dflt;
  if (!/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

function csvFilename(table: string): string {
  const safe = table.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "table";
  return `${safe}.csv`;
}

export function buildOwnerDbHttp(opts: OwnerDbHttpOptions) {
  const now = opts.now ?? (() => Date.now());
  const ledger = opts.ledger ?? new DbWriteLedger(null, now);
  const log = opts.log ?? (() => {});
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  const err = (status: number, error: string, extra: Record<string, unknown> = {}): HttpResponse =>
    json(status, { error, ...extra });
  const authority = {
    ownerIrkPub: opts.ownerIrkPub,
    ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
    username: opts.username,
    ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
  };

  function sqlFailure(e: unknown): HttpResponse {
    if (e instanceof NoSuchTableError) return err(404, e.message);
    if (e instanceof ExportTooLargeError) return err(413, e.message);
    if (e instanceof AppSqlError) {
      if (e.sqlState === "08006") return err(503, e.message);
      return err(400, e.message, {
        sqlState: e.sqlState,
        ...(e.position != null ? { position: e.position } : {}),
        ...(e.readOnlyViolation ? { needsGrant: true } : {}),
      });
    }
    return err(500, (e as Error).message ?? "database error");
  }

  async function postQuery(serviceId: string, store: string, pgUrl: string, req: HttpRequest): Promise<HttpResponse> {
    if (req.body.length > OWNER_DB_MAX_SQL_BYTES + 4096) return err(413, "the statement is too long");
    let body: { sql?: unknown; grant?: unknown; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8")) as typeof body;
    } catch {
      return err(400, "invalid json");
    }
    if (typeof body?.sql !== "string" || body.sql.trim().length === 0) return err(400, "sql required");
    const sql = body.sql;
    if (Buffer.byteLength(sql, "utf8") > OWNER_DB_MAX_SQL_BYTES) return err(413, "the statement is too long");
    let write = false;
    if (body.grant !== undefined || body.signature !== undefined) {
      const grant = parseAppDbWriteGrant(body.grant);
      if (!grant) return err(400, "malformed grant");
      if (typeof body.signature !== "string") return err(400, "signature required");
      const sig = hexToBytes(body.signature);
      if (!sig || sig.length !== 64) return err(400, "invalid signature hex");
      if (grant.serviceId !== serviceId) return err(400, "the order is for a different app");
      if (grant.store !== store) return err(400, "the order is for a different store");
      if (grant.serverDomain !== opts.serverDomain) return err(403, "the order is for a different server");
      if (grant.sqlSha256 !== appDbSqlSha256(sql)) return err(403, "the statement is not the one that was signed");
      if (Math.abs(now() - grant.issuedAt) > DB_WRITE_MAX_SKEW_MS) return err(403, "the order is stale: sign it again");
      if (!authorizeSensitiveOrder({ ...authority, order: grant, signature: sig, verify: verifyAppDbWriteGrant })) {
        return err(403, "invalid signature");
      }
      if (!(await ledger.claim(`${grant.serviceId}|${grant.store}|${grant.sqlSha256}|${grant.issuedAt}`))) {
        return err(409, "this signed order was already used: sign it again");
      }
      write = true;
    }
    try {
      const r = await opts.sql.query({
        pgUrl,
        sql,
        readOnly: !write,
        multiStatement: write,
        maxRows: OWNER_DB_MAX_ROWS,
        timeoutMs: OWNER_DB_TIMEOUT_MS,
      });
      if (write) log(`[db] ${serviceId}/${store}: signed statement ran (${r.command || "ok"})`);
      return json(200, r);
    } catch (e) {
      return sqlFailure(e);
    }
  }

  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    const m = DB_RE.exec(path) ?? EXPORT_RE.exec(path) ?? TABLE_RE.exec(path) ?? QUERY_RE.exec(path);
    if (!m) return null;
    const serviceId = decode(m[1]!);
    if (serviceId === null) return err(400, "bad service id");
    const app = opts.app(serviceId);
    if (!app) return err(404, "no such service");
    const stores = app.data?.postgres ?? {};

    if (DB_RE.test(path)) {
      if (method !== "GET") return err(405, "method not allowed");
      const out: Array<{ store: string; tables: Array<{ name: string; kind: string; rows: number | null; bytes: number }> }> = [];
      for (const [store, cred] of Object.entries(stores)) {
        try {
          const tables = await opts.sql.listTables({ pgUrl: cred.url, timeoutMs: OWNER_DB_TIMEOUT_MS, columns: false });
          out.push({ store, tables: tables.map((t) => ({ name: t.name, kind: t.kind, rows: t.rows, bytes: t.bytes })) });
        } catch (e) {
          return sqlFailure(e);
        }
      }
      return json(200, { stores: out });
    }

    const store = decode(m[2]!);
    if (store === null) return err(400, "bad store");
    const cred = Object.prototype.hasOwnProperty.call(stores, store) ? stores[store] : undefined;
    if (!cred) return err(404, "no such store");

    if (QUERY_RE.test(path)) {
      if (method !== "POST") return err(405, "method not allowed");
      return postQuery(serviceId, store, cred.url, req);
    }

    const table = decode(m[3]!);
    if (table === null || table.length === 0 || table.length > 200) return err(400, "bad table");
    if (method !== "GET") return err(405, "method not allowed");

    if (EXPORT_RE.test(path)) {
      try {
        const csv = await opts.sql.exportCsv({
          pgUrl: cred.url,
          table,
          timeoutMs: OWNER_DB_TIMEOUT_MS,
          maxBytes: OWNER_DB_EXPORT_MAX_BYTES,
        });
        return {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${csvFilename(table)}"`,
            "cache-control": "no-store",
          },
          body: csv,
        };
      } catch (e) {
        return sqlFailure(e);
      }
    }

    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const offset = intParam(q, "offset", 0);
    const limit = intParam(q, "limit", OWNER_DB_DEFAULT_LIMIT);
    if (offset === null || limit === null) return err(400, "offset and limit must be whole numbers");
    try {
      const r = await opts.sql.tableRows({
        pgUrl: cred.url,
        table,
        offset,
        limit: Math.min(limit, OWNER_DB_MAX_ROWS),
        timeoutMs: OWNER_DB_TIMEOUT_MS,
      });
      return json(200, r);
    } catch (e) {
      return sqlFailure(e);
    }
  };
}
