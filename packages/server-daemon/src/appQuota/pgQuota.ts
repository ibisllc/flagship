/**
 * Per-app database size limits (docs/app-runtimes.md §5.3). Postgres has no
 * quota, so the box measures each app database and, at its limit, takes the
 * role's write privileges away: INSERT and UPDATE on every table, CREATE on
 * its schemas and database, TEMPORARY. Reads, DELETE and TRUNCATE keep
 * working, so the app can make room. What it took is recorded and given
 * back, exactly, once the database is under its limit again.
 *
 * The app role owns its database and could grant itself those privileges
 * back; an app that keeps growing while blocked is stopped (NOLOGIN, its
 * sessions ended) until it's back under. The box's own work (backups, the
 * owner's signed database writes, copies) runs as the admin and is never
 * affected.
 *
 * "Under its limit" counts the room Postgres can reuse: rows an app deletes
 * leave space the next INSERT takes without growing the files, and
 * `pg_database_size` only falls after a VACUUM FULL. The free space map
 * (pg_freespacemap, in a schema of the admin's, only while blocked) says
 * how much that is.
 */
import { Client as PgClient } from "pg";

export interface PgRevocation {
  tables: Array<{ oid: number; privs: Array<"INSERT" | "UPDATE">; fromPublic?: boolean }>;
  /** Each schema whose CREATE was taken, and from whom (the role, the schema's owner role, PUBLIC). */
  schemas: Array<{ name: string; from: string[] }>;
  databaseCreate: boolean;
  temporary: boolean;
  /** Large-object writes (`LO_WRITE_FUNCTIONS`), and from whom: they bypass table privileges. */
  largeObjects?: string[];
}

export function emptyRevocation(): PgRevocation {
  return { tables: [], schemas: [], databaseCreate: false, temporary: false };
}

export interface PgQuotaAdmin {
  /** pg_database_size of each named database that exists. */
  sizes(dbs: readonly string[]): Promise<Map<string, number>>;
  /** Bytes Postgres can reuse inside a database (its free space map). */
  freeBytes(db: string): Promise<number>;
  /** Take the role's writes away (again: also on tables made since). Returns everything taken so far. */
  block(db: string, role: string, prev: PgRevocation): Promise<PgRevocation>;
  /** Give back exactly what `block` took (tables since dropped are skipped). */
  unblock(db: string, role: string, revoked: PgRevocation): Promise<void>;
  /** NOLOGIN (and end its sessions) or LOGIN again. */
  setLogin(role: string, canLogin: boolean): Promise<void>;
  /** A plain VACUUM, so deleted rows' room shows in the free space map. */
  vacuum(db: string): Promise<void>;
  /** The per-role limits every app role has (`APP_ROLE_LIMITS`); set again at boot on older roles. */
  applyRoleLimits(role: string): Promise<void>;
}

/**
 * What one app may take of the shared Postgres (docs/app-runtimes.md §5.3):
 * connections, how long one statement or an idle transaction may run, and
 * temp files (temp_file_limit is superuser-set, so the app can't raise it;
 * the timeouts are defaults it may change for itself). The box's own
 * connections as the role (migrations) lift the timeouts.
 */
export const APP_ROLE_LIMITS = {
  connectionLimit: 20,
  statementTimeout: "30s",
  idleInTransactionSessionTimeout: "60s",
  tempFileLimit: "1GB",
} as const;

/** The statements that give `role` its limits (role creation, and at boot). */
export function roleLimitStatements(role: string): string[] {
  const r = ident(role);
  const l = APP_ROLE_LIMITS;
  return [
    `ALTER ROLE ${r} CONNECTION LIMIT ${l.connectionLimit}`,
    `ALTER ROLE ${r} SET statement_timeout = '${l.statementTimeout}'`,
    `ALTER ROLE ${r} SET idle_in_transaction_session_timeout = '${l.idleInTransactionSessionTimeout}'`,
    `ALTER ROLE ${r} SET temp_file_limit = '${l.tempFileLimit}'`,
  ];
}

/**
 * Large objects live in the database's own pg_largeobject, so its size
 * counts them, but writing one needs only EXECUTE on these functions (PUBLIC
 * has it), not a table privilege: while a database is blocked they're
 * revoked in it too. Truncating and unlinking stay allowed.
 */
export const LO_WRITE_FUNCTIONS = [
  "lo_creat(integer)",
  "lo_create(oid)",
  "lo_from_bytea(oid, bytea)",
  "lowrite(integer, bytea)",
  "lo_put(oid, bigint, bytea)",
] as const;

const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
function ident(id: string): string {
  if (!SAFE_IDENT.test(id)) throw new Error(`unsafe Postgres identifier ${JSON.stringify(id)}`);
  return `"${id}"`;
}
/** Quote any identifier (an app's own schema names). */
function quoteAny(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

const QUOTA_SCHEMA = "flagship_quota";
const APP_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema', '${QUOTA_SCHEMA}') AND n.nspname NOT LIKE 'pg\\_%'`;

export class RealPgQuota implements PgQuotaAdmin {
  constructor(private readonly opts: { adminUrl: string; connectTimeoutMs?: number }) {}

  private async withDb<T>(db: string | null, fn: (c: PgClient) => Promise<T>): Promise<T> {
    let url = this.opts.adminUrl;
    if (db !== null) {
      ident(db);
      const u = new URL(url);
      u.pathname = `/${encodeURIComponent(db)}`;
      url = u.toString();
    }
    const c = new PgClient({ connectionString: url, connectionTimeoutMillis: this.opts.connectTimeoutMs ?? 5000 });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => {});
    }
  }

  async sizes(dbs: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (dbs.length === 0) return out;
    for (const d of dbs) ident(d);
    return this.withDb(null, async (c) => {
      const r = await c.query<{ datname: string; bytes: string }>(
        `SELECT datname, pg_database_size(oid)::text AS bytes FROM pg_database WHERE datname = ANY($1::text[])`,
        [dbs],
      );
      for (const row of r.rows) out.set(row.datname, Number(row.bytes));
      return out;
    });
  }

  async freeBytes(db: string): Promise<number> {
    return this.withDb(db, async (c) => {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${QUOTA_SCHEMA}`);
      await c.query(`REVOKE ALL ON SCHEMA ${QUOTA_SCHEMA} FROM PUBLIC`);
      await c.query(`CREATE EXTENSION IF NOT EXISTS pg_freespacemap SCHEMA ${QUOTA_SCHEMA}`);
      const r = await c.query<{ bytes: string }>(
        `SELECT coalesce(sum(f.avail), 0)::text AS bytes
           FROM pg_class c
           CROSS JOIN LATERAL ${QUOTA_SCHEMA}.pg_freespace(c.oid) f
          WHERE c.relkind IN ('r', 't', 'm') AND c.relpersistence = 'p'`,
      );
      return Number(r.rows[0]?.bytes ?? 0);
    });
  }

  async block(db: string, role: string, prev: PgRevocation): Promise<PgRevocation> {
    const r = ident(role);
    const out: PgRevocation = {
      tables: prev.tables.map((t) => ({ ...t, privs: [...t.privs] })),
      schemas: prev.schemas.map((s) => ({ name: s.name, from: [...s.from] })),
      databaseCreate: prev.databaseCreate,
      temporary: prev.temporary,
      ...(prev.largeObjects ? { largeObjects: [...prev.largeObjects] } : {}),
    };
    await this.withDb(db, async (c) => {
      const rels = await c.query<{ oid: number; name: string; ins: boolean; upd: boolean }>(
        `SELECT c.oid::int AS oid, c.oid::regclass::text AS name,
                has_table_privilege($1, c.oid, 'INSERT') AS ins,
                has_table_privilege($1, c.oid, 'UPDATE') AS upd
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'v', 'f') AND ${APP_SCHEMAS}`,
        [role],
      );
      for (const t of rels.rows) {
        if (!t.ins && !t.upd) continue;
        const privs: Array<"INSERT" | "UPDATE"> = [];
        if (t.ins) privs.push("INSERT");
        if (t.upd) privs.push("UPDATE");
        await c.query(`REVOKE INSERT, UPDATE ON TABLE ${t.name} FROM ${r}`);
        const still = await c.query<{ w: boolean }>(
          `SELECT has_table_privilege($1, $2::oid, 'INSERT') OR has_table_privilege($1, $2::oid, 'UPDATE') AS w`,
          [role, t.oid],
        );
        let fromPublic = false;
        if (still.rows[0]?.w) {
          await c.query(`REVOKE INSERT, UPDATE ON TABLE ${t.name} FROM PUBLIC`);
          fromPublic = true;
        }
        const had = out.tables.find((x) => x.oid === t.oid);
        if (had) {
          for (const p of privs) if (!had.privs.includes(p)) had.privs.push(p);
          if (fromPublic) had.fromPublic = true;
        } else {
          out.tables.push({ oid: t.oid, privs, ...(fromPublic ? { fromPublic } : {}) });
        }
      }
      // `public` belongs to pg_database_owner, which the app role (owning
      // its database) is: CREATE there comes through that role, so it's
      // revoked from the schema's owner too (as a superuser does, for the owner).
      const schemas = await c.query<{ oid: number; nspname: string; owner: string }>(
        `SELECT n.oid::int AS oid, n.nspname, n.nspowner::regrole::text AS owner
           FROM pg_namespace n WHERE ${APP_SCHEMAS} AND has_schema_privilege($1, n.oid, 'CREATE')`,
        [role],
      );
      const canCreate = async (oid: number) =>
        (await c.query<{ ok: boolean }>(`SELECT has_schema_privilege($1, $2::oid, 'CREATE') AS ok`, [role, oid])).rows[0]?.ok;
      for (const s of schemas.rows) {
        const q = quoteAny(s.nspname);
        const from: string[] = [];
        await c.query(`REVOKE CREATE ON SCHEMA ${q} FROM ${r}`);
        from.push(role);
        if ((await canCreate(s.oid)) && s.owner !== role && s.owner !== `"${role}"`) {
          await c.query(`REVOKE CREATE ON SCHEMA ${q} FROM ${s.owner}`);
          from.push(s.owner);
        }
        if (await canCreate(s.oid)) {
          await c.query(`REVOKE CREATE ON SCHEMA ${q} FROM PUBLIC`);
          from.push("PUBLIC");
        }
        const had = out.schemas.find((x) => x.name === s.nspname);
        if (had) for (const f of from) if (!had.from.includes(f)) had.from.push(f);
        if (!had) out.schemas.push({ name: s.nspname, from });
      }
      const dbp = await c.query<{ cr: boolean; tmp: boolean }>(
        `SELECT has_database_privilege($1, $2, 'CREATE') AS cr, has_database_privilege($1, $2, 'TEMPORARY') AS tmp`,
        [role, db],
      );
      if (dbp.rows[0]?.cr) {
        await c.query(`REVOKE CREATE ON DATABASE ${ident(db)} FROM ${r}`);
        out.databaseCreate = true;
      }
      if (dbp.rows[0]?.tmp) {
        await c.query(`REVOKE TEMPORARY ON DATABASE ${ident(db)} FROM ${r}`);
        out.temporary = true;
      }
      const lo = await c.query<{ ok: boolean }>(
        `SELECT bool_or(has_function_privilege($1, f::regprocedure, 'EXECUTE')) AS ok FROM unnest($2::text[]) AS f`,
        [role, LO_WRITE_FUNCTIONS],
      );
      if (lo.rows[0]?.ok) {
        const from = new Set(out.largeObjects ?? []);
        const fns = LO_WRITE_FUNCTIONS.join(", ");
        await c.query(`REVOKE EXECUTE ON FUNCTION ${fns} FROM PUBLIC`);
        from.add("PUBLIC");
        const still = await c.query<{ ok: boolean }>(
          `SELECT bool_or(has_function_privilege($1, f::regprocedure, 'EXECUTE')) AS ok FROM unnest($2::text[]) AS f`,
          [role, LO_WRITE_FUNCTIONS],
        );
        if (still.rows[0]?.ok) {
          await c.query(`REVOKE EXECUTE ON FUNCTION ${fns} FROM ${r}`);
          from.add(role);
        }
        out.largeObjects = [...from];
      }
    });
    return out;
  }

  async unblock(db: string, role: string, revoked: PgRevocation): Promise<void> {
    const r = ident(role);
    await this.withDb(db, async (c) => {
      for (const t of revoked.tables) {
        const name = await c.query<{ name: string }>(`SELECT oid::regclass::text AS name FROM pg_class WHERE oid = $1::oid`, [t.oid]);
        const n = name.rows[0]?.name;
        if (!n || t.privs.length === 0) continue;
        const privs = t.privs.filter((p) => p === "INSERT" || p === "UPDATE").join(", ");
        await c.query(`GRANT ${privs} ON TABLE ${n} TO ${r}`);
        if (t.fromPublic) await c.query(`GRANT ${privs} ON TABLE ${n} TO PUBLIC`);
      }
      for (const s of revoked.schemas) {
        const exists = await c.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [s.name]);
        if (!exists.rowCount) continue;
        for (const grantee of s.from) {
          const to = grantee === role ? r : grantee === "PUBLIC" ? "PUBLIC" : grantee;
          if (!/^(PUBLIC|"[^"]+"|[a-z_][a-z0-9_$]*)$/.test(to)) continue;
          await c.query(`GRANT CREATE ON SCHEMA ${quoteAny(s.name)} TO ${to}`);
        }
      }
      if (revoked.databaseCreate) await c.query(`GRANT CREATE ON DATABASE ${ident(db)} TO ${r}`);
      if (revoked.temporary) await c.query(`GRANT TEMPORARY ON DATABASE ${ident(db)} TO ${r}`);
      for (const who of revoked.largeObjects ?? []) {
        await c.query(`GRANT EXECUTE ON FUNCTION ${LO_WRITE_FUNCTIONS.join(", ")} TO ${who === "PUBLIC" ? "PUBLIC" : ident(who)}`);
      }
      await c.query(`DROP EXTENSION IF EXISTS pg_freespacemap`);
      await c.query(`DROP SCHEMA IF EXISTS ${QUOTA_SCHEMA}`);
    });
  }

  async setLogin(role: string, canLogin: boolean): Promise<void> {
    const r = ident(role);
    await this.withDb(null, async (c) => {
      await c.query(`ALTER ROLE ${r} ${canLogin ? "LOGIN" : "NOLOGIN"}`);
      if (!canLogin) await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]);
    });
  }

  async vacuum(db: string): Promise<void> {
    await this.withDb(db, async (c) => {
      await c.query("VACUUM");
    });
  }

  async applyRoleLimits(role: string): Promise<void> {
    await this.withDb(null, async (c) => {
      for (const sql of roleLimitStatements(role)) await c.query(sql);
    });
  }
}

/** The same contract in memory, for tests of everything above it. */
export class FakePgQuota implements PgQuotaAdmin {
  readonly size = new Map<string, number>();
  readonly free = new Map<string, number>();
  readonly blocked = new Map<string, PgRevocation>();
  readonly noLogin = new Set<string>();
  readonly calls: string[] = [];
  vacuums = 0;

  async sizes(dbs: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const d of dbs) if (this.size.has(d)) out.set(d, this.size.get(d)!);
    return out;
  }
  async freeBytes(db: string): Promise<number> {
    return this.free.get(db) ?? 0;
  }
  async block(db: string, role: string, prev: PgRevocation): Promise<PgRevocation> {
    this.calls.push(`block ${db} ${role}`);
    const r = prev.tables.length ? prev : { ...emptyRevocation(), tables: [{ oid: 1, privs: ["INSERT", "UPDATE"] as Array<"INSERT" | "UPDATE"> }], temporary: true };
    this.blocked.set(db, r);
    return r;
  }
  async unblock(db: string, role: string): Promise<void> {
    this.calls.push(`unblock ${db} ${role}`);
    this.blocked.delete(db);
  }
  async setLogin(role: string, canLogin: boolean): Promise<void> {
    this.calls.push(`${canLogin ? "login" : "nologin"} ${role}`);
    if (canLogin) this.noLogin.delete(role);
    else this.noLogin.add(role);
  }
  async vacuum(): Promise<void> {
    this.vacuums++;
  }
  readonly limited = new Set<string>();
  async applyRoleLimits(role: string): Promise<void> {
    this.limited.add(role);
  }
}
