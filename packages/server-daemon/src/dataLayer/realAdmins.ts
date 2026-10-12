import { Client as PgClient } from "pg";
import type { FilesAdmin, PostgresAdmin } from "./admin.js";
import type { CommandRunner } from "../serviceRunner.js";
import { isFilesVolume } from "./naming.js";

/**
 * Real admin implementations: the box's Postgres (brought up by
 * `installer/data-services/docker-compose.yml`) and the per-app files
 * volumes (dockerd). Each is stateless (connects per call), which is fine:
 * the daemon provisions in bursts at install/uninstall, never per request.
 *
 * Unit-tested through their interface contracts (the InMemory fakes cover
 * DataProvisioner); the real ones are exercised on a box with real Docker.
 */

// ──────────────────────────────────────────────────────────────────────
// Postgres
// ──────────────────────────────────────────────────────────────────────

export interface RealPostgresAdminOptions {
  /** Connection URL for the admin/superuser. e.g. `postgresql://flagship_admin:<pw>@127.0.0.1:5432/postgres`. */
  adminUrl: string;
  /** Per-call connect timeout (ms). Default 5000. */
  connectTimeoutMs?: number;
}

export class RealPostgresAdmin implements PostgresAdmin {
  constructor(private readonly opts: RealPostgresAdminOptions) {}

  private async withClient<T>(
    fn: (c: PgClient) => Promise<T>,
    overrideUrl?: string,
  ): Promise<T> {
    const c = new PgClient({
      connectionString: overrideUrl ?? this.opts.adminUrl,
      connectionTimeoutMillis: this.opts.connectTimeoutMs ?? 5000,
    });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => {});
    }
  }

  async createRoleAndDb(args: { db: string; role: string; password: string; extensions?: readonly string[] }): Promise<void> {
    assertSafeIdent(args.db);
    assertSafeIdent(args.role);
    for (const ext of args.extensions ?? []) assertSafeIdent(ext);
    // Postgres rejects parameter binding ($1) inside DDL. The role + db
    // identifiers come from assertSafeIdent so they're double-quoted as
    // literals; the password is escaped as a SQL string literal (single
    // quotes doubled). generateSecret currently emits base64url (no
    // single quotes / backslashes) but we don't rely on that here.
    const pwLiteral = `'${args.password.replace(/'/g, "''")}'`;
    await this.withClient(async (c) => {
      // No app may open another app's database or the shared ones: CONNECT
      // is a PUBLIC default on every database, so revoke it everywhere and
      // give it back to the one role that owns each app database.
      await c.query(`REVOKE CONNECT, TEMPORARY ON DATABASE "postgres" FROM PUBLIC`);
      await c.query(`REVOKE CONNECT, TEMPORARY ON DATABASE "template1" FROM PUBLIC`);
      await c.query(`CREATE ROLE "${args.role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${pwLiteral}`);
      await c.query(`CREATE DATABASE "${args.db}" OWNER "${args.role}"`);
      await c.query(`REVOKE ALL ON DATABASE "${args.db}" FROM PUBLIC`);
      await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${args.db}" TO "${args.role}"`);
    });
    if ((args.extensions ?? []).length === 0) return;
    // Extensions are created by the admin (most need superuser) inside the
    // app's database; their functions and types are then the app's to use.
    await this.withClient(async (c) => {
      for (const ext of args.extensions ?? []) await c.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
    }, withDatabase(this.opts.adminUrl, args.db));
  }

  async dropRoleAndDb(args: { db: string; role: string }): Promise<void> {
    assertSafeIdent(args.db);
    assertSafeIdent(args.role);
    await this.withClient(async (c) => {
      // Force-disconnect any sessions so DROP DATABASE doesn't block.
      await c.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [args.db],
      );
      await c.query(`DROP DATABASE IF EXISTS "${args.db}"`);
      await c.query(`DROP ROLE IF EXISTS "${args.role}"`);
    });
  }

  async listTables(db: string): Promise<string[]> {
    assertSafeIdent(db);
    const url = withDatabase(this.opts.adminUrl, db);
    return this.withClient(async (c) => {
      const r = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      return r.rows.map((row) => row.table_name);
    }, url);
  }

  async query(args: { db: string; sql: string; maxRows: number }): Promise<{ columns: string[]; rows: unknown[][] }> {
    assertSafeIdent(args.db);
    const url = withDatabase(this.opts.adminUrl, args.db);
    return this.withClient(async (c) => {
      // Caller is the operator (paired-session phone). Hard cap rows
      // server-side as defense in depth — whatever they wrote, we won't
      // ship more than maxRows back.
      const max = Math.max(1, Math.min(1000, Math.floor(args.maxRows)));
      const r = await c.query(args.sql);
      const columns = r.fields.map((f) => f.name);
      const rows = r.rows.slice(0, max).map((row) => columns.map((col) => (row as Record<string, unknown>)[col]));
      return { columns, rows };
    }, url);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Files (Docker named volumes)
// ──────────────────────────────────────────────────────────────────────

/** The label every files volume carries, with its dataspace (`prod` / `dev`). */
export const FILES_VOLUME_LABEL = "flagship.files";

export class RealFilesAdmin implements FilesAdmin {
  constructor(private readonly cmd: CommandRunner) {}

  private async capture(args: string[]): Promise<string> {
    if (!this.cmd.capture) throw new Error("CommandRunner.capture is not configured");
    return (await this.cmd.capture("docker", args, { timeoutMs: 60_000 })).stdout;
  }

  private async exists(volume: string): Promise<boolean> {
    try {
      await this.capture(["volume", "inspect", "-f", "{{.Name}}", volume]);
      return true;
    } catch {
      return false;
    }
  }

  async createVolume(args: { volume: string; labels?: Record<string, string> }): Promise<void> {
    assertFilesVolume(args.volume);
    if (await this.exists(args.volume)) throw new Error(`files volume ${args.volume} already exists`);
    const labels = Object.entries(args.labels ?? {}).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    await this.capture(["volume", "create", ...labels, args.volume]);
    // A fresh volume's root is root:root 0755, and an image that runs as an
    // unprivileged user (with every capability dropped) couldn't write to
    // it. Only this app's container ever mounts it, so open it to any uid.
    // (When the image has its own /data, Docker copies that in on first
    // mount, ownership included.)
    try {
      const mountpoint = (await this.capture(["volume", "inspect", "-f", "{{.Mountpoint}}", args.volume])).trim();
      if (mountpoint.startsWith("/")) await this.cmd.run("chmod", ["0777", mountpoint]);
    } catch (e) {
      await this.capture(["volume", "rm", args.volume]).catch(() => {});
      throw new Error(`couldn't prepare files volume ${args.volume}: ${(e as Error).message}`);
    }
  }

  async removeVolume(volume: string): Promise<void> {
    assertFilesVolume(volume);
    if (!(await this.exists(volume))) return;
    await this.capture(["volume", "rm", volume]);
  }

  async volumeBytes(volume: string): Promise<number | null> {
    assertFilesVolume(volume);
    try {
      const mountpoint = (await this.capture(["volume", "inspect", "-f", "{{.Mountpoint}}", volume])).trim();
      if (!mountpoint.startsWith("/")) return null;
      if (!this.cmd.capture) return null;
      // The daemon runs as root on the box, so it can read the volume's
      // directory; `du -sk` counts what it takes on disk.
      const { stdout } = await this.cmd.capture("du", ["-sk", mountpoint], { timeoutMs: 120_000 });
      const kib = Number(stdout.trim().split(/\s+/)[0]);
      return Number.isFinite(kib) ? kib * 1024 : null;
    } catch {
      return null;
    }
  }
}

export function assertFilesVolume(name: string): void {
  if (!isFilesVolume(name)) throw new Error(`not a files volume name ${JSON.stringify(name)}`);
}

// ──────────────────────────────────────────────────────────────────────
// Validation helpers (defense-in-depth — DataProvisioner already
// validates upstream, but these admins may be called directly by
// operational tooling).
// ──────────────────────────────────────────────────────────────────────

const SAFE_PG_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
export function assertSafeIdent(id: string): void {
  if (!SAFE_PG_IDENT.test(id)) {
    throw new Error(`unsafe Postgres identifier ${JSON.stringify(id)}`);
  }
}

/** Replace the database part of a Postgres connection URL. */
function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(db)}`;
  return u.toString();
}
