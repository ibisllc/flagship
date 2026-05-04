/**
 * Admin interfaces for each store. Real implementations connect to the
 * running system containers; in-memory implementations satisfy the same
 * contract for tests and offline orchestration.
 */

export interface PostgresAdmin {
  createRoleAndDb(args: { db: string; role: string; password: string }): Promise<void>;
  dropRoleAndDb(args: { db: string; role: string }): Promise<void>;
  /** For the data dashboard. Returns table names in the per-app database. */
  listTables(db: string): Promise<string[]>;
  /** Bounded query for the visualizer. Caller is trusted (paired session); we still cap. */
  query(args: { db: string; sql: string; maxRows: number }): Promise<{ columns: string[]; rows: unknown[][] }>;
}

export interface MinioAdmin {
  createBucketAndKey(args: { bucket: string; accessKey: string; secretKey: string }): Promise<void>;
  dropBucketAndKey(args: { bucket: string; accessKey: string }): Promise<void>;
  listObjects(bucket: string, prefix: string, max: number): Promise<{ key: string; size: number }[]>;
}

export interface RedisAdmin {
  createAclUser(args: { user: string; password: string; prefix: string }): Promise<void>;
  dropAclUser(user: string): Promise<void>;
  listKeys(prefix: string, max: number): Promise<string[]>;
}

/**
 * In-memory fakes for tests and offline orchestration. They model just
 * enough state to verify provision / deprovision / dashboard behavior
 * without spinning real containers.
 */

export class InMemoryPostgresAdmin implements PostgresAdmin {
  databases = new Map<string, { role: string; tables: Map<string, unknown[][]> }>();
  async createRoleAndDb(args: { db: string; role: string; password: string }): Promise<void> {
    if (this.databases.has(args.db)) throw new Error(`db ${args.db} already exists`);
    void args.password;
    this.databases.set(args.db, { role: args.role, tables: new Map() });
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
}

export class InMemoryMinioAdmin implements MinioAdmin {
  buckets = new Map<string, { accessKey: string; objects: Map<string, Uint8Array> }>();
  async createBucketAndKey(args: { bucket: string; accessKey: string; secretKey: string }): Promise<void> {
    if (this.buckets.has(args.bucket)) throw new Error(`bucket ${args.bucket} already exists`);
    void args.secretKey;
    this.buckets.set(args.bucket, { accessKey: args.accessKey, objects: new Map() });
  }
  async dropBucketAndKey(args: { bucket: string; accessKey: string }): Promise<void> {
    void args.accessKey;
    this.buckets.delete(args.bucket);
  }
  async listObjects(bucket: string, prefix: string, max: number): Promise<{ key: string; size: number }[]> {
    const b = this.buckets.get(bucket);
    if (!b) return [];
    return [...b.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .slice(0, max)
      .map(([k, v]) => ({ key: k, size: v.length }));
  }
}

export class InMemoryRedisAdmin implements RedisAdmin {
  users = new Map<string, { prefix: string }>();
  data = new Map<string, string>();
  async createAclUser(args: { user: string; password: string; prefix: string }): Promise<void> {
    if (this.users.has(args.user)) throw new Error(`user ${args.user} already exists`);
    void args.password;
    this.users.set(args.user, { prefix: args.prefix });
  }
  async dropAclUser(user: string): Promise<void> {
    this.users.delete(user);
  }
  async listKeys(prefix: string, max: number): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).slice(0, max);
  }
}
