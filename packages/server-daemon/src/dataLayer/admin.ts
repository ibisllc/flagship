/**
 * Admin interfaces for the data layer: the box's Postgres and the per-app
 * files volumes. Real implementations talk to the running container and to
 * dockerd; in-memory ones satisfy the same contract for tests.
 */

export interface PostgresAdmin {
  /**
   * Create the app's role and database, lock the database to that role
   * (CONNECT revoked from PUBLIC, also on `postgres` and `template1`), and
   * create `extensions` in it as the admin.
   */
  createRoleAndDb(args: { db: string; role: string; password: string; extensions?: readonly string[] }): Promise<void>;
  dropRoleAndDb(args: { db: string; role: string }): Promise<void>;
  /** For the data dashboard. Returns table names in the per-app database. */
  listTables(db: string): Promise<string[]>;
  /** Bounded query for the visualizer. Caller is trusted (paired session); we still cap. */
  query(args: { db: string; sql: string; maxRows: number }): Promise<{ columns: string[]; rows: unknown[][] }>;
  /**
   * Execute a trusted SQL script against a database (schema DDL + the
   * synthesizer's seed INSERTs). Used ONLY to populate a DEV dataspace with
   * fabricated rows; never runs untrusted input and never touches a prod db by
   * contract (the caller passes a `__dev_`-prefixed database name). Optional so
   * a minimal admin without a seeding path can omit it — `provisionDevDataspace`
   * throws a clear error when it's needed but absent.
   */
  execSql?(args: { db: string; sql: string }): Promise<void>;
  /** Databases and roles whose name starts `prefix` (the boot sweep of dev ones). */
  listNamed?(prefix: string): Promise<string[]>;
}

/** Per-app files folders: Docker named volumes, mounted at `/data`. */
export interface FilesAdmin {
  /**
   * Create the volume; throws when it already exists (a fresh app gets an
   * empty folder). `sizeBytes` is the folder's limit where the box can hold
   * one (appQuota/loopVolumes.ts).
   */
  createVolume(args: { volume: string; labels?: Record<string, string>; sizeBytes?: number }): Promise<void>;
  /** Remove the volume and everything in it; a volume already gone is fine. */
  removeVolume(volume: string): Promise<void>;
  /** Bytes the volume uses on disk, or null when the box can't tell. */
  volumeBytes(volume: string): Promise<number | null>;
  /** Volumes whose name starts `prefix` (the boot sweep of dev ones). */
  listVolumes?(prefix: string): Promise<string[]>;
}

export class InMemoryPostgresAdmin implements PostgresAdmin {
  databases = new Map<string, { role: string; tables: Map<string, unknown[][]>; extensions: string[] }>();
  async createRoleAndDb(args: { db: string; role: string; password: string; extensions?: readonly string[] }): Promise<void> {
    if (this.databases.has(args.db)) throw new Error(`db ${args.db} already exists`);
    void args.password;
    this.databases.set(args.db, { role: args.role, tables: new Map(), extensions: [...(args.extensions ?? [])] });
  }
  async dropRoleAndDb(args: { db: string; role: string }): Promise<void> {
    void args.role;
    this.databases.delete(args.db);
  }
  async listTables(db: string): Promise<string[]> {
    return [...(this.databases.get(db)?.tables.keys() ?? [])];
  }
  async query(args: { db: string; sql: string; maxRows: number }): Promise<{ columns: string[]; rows: unknown[][] }> {
    const d = this.databases.get(args.db);
    if (!d) throw new Error(`unknown db ${args.db}`);
    // Match a tiny subset for tests: SELECT * FROM <table>.
    const m = /^\s*select\s+\*\s+from\s+([a-z_][a-z0-9_]*)/i.exec(args.sql);
    if (!m) return { columns: [], rows: [] };
    const t = d.tables.get(m[1]!);
    if (!t) return { columns: [], rows: [] };
    return { columns: ["row"], rows: t.slice(0, args.maxRows).map((r) => [JSON.stringify(r)]) };
  }
  /**
   * Model a seed script: register each `INSERT INTO "<table>"` as a row in that
   * table so `listTables`/`query` reflect the seeded dev data. Ignores DDL and
   * anything else — enough to verify the dev-dataspace seeding contract.
   */
  async execSql(args: { db: string; sql: string }): Promise<void> {
    const d = this.databases.get(args.db);
    if (!d) throw new Error(`unknown db ${args.db}`);
    const re = /insert\s+into\s+"?([a-z_][a-z0-9_]*)"?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(args.sql)) !== null) {
      const table = m[1]!;
      const existing = d.tables.get(table) ?? [];
      existing.push([]);
      d.tables.set(table, existing);
    }
  }
  async listNamed(prefix: string): Promise<string[]> {
    return [...this.databases.keys()].filter((n) => n.startsWith(prefix));
  }
}

export class InMemoryFilesAdmin implements FilesAdmin {
  volumes = new Map<string, { labels: Record<string, string>; bytes: number; sizeBytes?: number }>();
  async createVolume(args: { volume: string; labels?: Record<string, string>; sizeBytes?: number }): Promise<void> {
    if (this.volumes.has(args.volume)) throw new Error(`files volume ${args.volume} already exists`);
    this.volumes.set(args.volume, {
      labels: { ...(args.labels ?? {}) },
      bytes: 0,
      ...(args.sizeBytes !== undefined ? { sizeBytes: args.sizeBytes } : {}),
    });
  }
  async removeVolume(volume: string): Promise<void> {
    this.volumes.delete(volume);
  }
  async volumeBytes(volume: string): Promise<number | null> {
    return this.volumes.get(volume)?.bytes ?? null;
  }
  async listVolumes(prefix: string): Promise<string[]> {
    return [...this.volumes.keys()].filter((v) => v.startsWith(prefix));
  }
}
