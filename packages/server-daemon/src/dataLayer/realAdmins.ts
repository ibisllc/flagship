import { Client as PgClient } from "pg";
import { Redis as IORedis } from "ioredis";
import { Client as MinioClient } from "minio";
import type { MinioAdmin, PostgresAdmin, RedisAdmin } from "./admin.js";

/**
 * Real admin implementations that talk to the data services brought up
 * by `installer/data-services/docker-compose.yml`. Each admin is
 * stateless (opens connections per-call) — fine because the daemon
 * only does provisioning bursts at app install/uninstall, not in the
 * hot request path.
 *
 * All three are unit-tested only via their interface contracts (the
 * InMemory* fakes in admin.ts cover the DataProvisioner integration);
 * end-to-end coverage is the live smoke at scripts/smoke-app-install.ts.
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

  async createRoleAndDb(args: { db: string; role: string; password: string }): Promise<void> {
    assertSafeIdent(args.db);
    assertSafeIdent(args.role);
    await this.withClient(async (c) => {
      // Roles + databases must be created with literal identifiers (no
      // parameter binding allowed). All inputs are validated through
      // assertSafeIdent so we control the entire identifier set.
      await c.query(`CREATE ROLE "${args.role}" LOGIN PASSWORD $1`, [args.password]);
      await c.query(`CREATE DATABASE "${args.db}" OWNER "${args.role}"`);
      await c.query(`REVOKE CONNECT ON DATABASE "${args.db}" FROM PUBLIC`);
      await c.query(`GRANT CONNECT ON DATABASE "${args.db}" TO "${args.role}"`);
    });
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
// Redis
// ──────────────────────────────────────────────────────────────────────

export interface RealRedisAdminOptions {
  /** e.g. `redis://default:<pw>@127.0.0.1:6379/0` */
  adminUrl: string;
}

export class RealRedisAdmin implements RedisAdmin {
  constructor(private readonly opts: RealRedisAdminOptions) {}

  private connect(): IORedis {
    // ioredis accepts a URL string or options; the default-export route
    // varies by version, so we use the named class directly.
    const r = new IORedis(this.opts.adminUrl, { lazyConnect: false, maxRetriesPerRequest: 1 });
    return r;
  }

  async createAclUser(args: { user: string; password: string; prefix: string }): Promise<void> {
    assertRedisUserName(args.user);
    assertRedisPrefix(args.prefix);
    const r = this.connect();
    try {
      // Allow only keys matching the prefix; allow common command groups.
      // The `~prefix*` clause restricts every command to keys starting
      // with the namespace. Pub/Sub channels are limited to the same
      // prefix via `&prefix*`.
      await r.acl(
        "SETUSER",
        args.user,
        "on",
        `>${args.password}`,
        "resetkeys",
        `~${args.prefix}*`,
        "resetchannels",
        `&${args.prefix}*`,
        "+@all",
        "-@dangerous",
      );
    } finally {
      r.disconnect();
    }
  }

  async dropAclUser(user: string): Promise<void> {
    assertRedisUserName(user);
    const r = this.connect();
    try {
      await r.acl("DELUSER", user);
    } finally {
      r.disconnect();
    }
  }

  async listKeys(prefix: string, max: number): Promise<string[]> {
    assertRedisPrefix(prefix);
    const cap = Math.max(1, Math.min(1000, Math.floor(max)));
    const r = this.connect();
    const out: string[] = [];
    try {
      let cursor = "0";
      do {
        const [next, batch] = await r.scan(cursor, "MATCH", `${prefix}*`, "COUNT", "100");
        for (const k of batch) {
          if (out.length >= cap) return out;
          out.push(k);
        }
        cursor = next;
      } while (cursor !== "0");
    } finally {
      r.disconnect();
    }
    return out;
  }
}

// ──────────────────────────────────────────────────────────────────────
// MinIO
// ──────────────────────────────────────────────────────────────────────

export interface RealMinioAdminOptions {
  /** Endpoint host (no protocol). e.g. `127.0.0.1`. */
  endPoint: string;
  /** Endpoint port. Default 9000. */
  port?: number;
  /** Use HTTPS? Default false (loopback-only deployment). */
  useSSL?: boolean;
  /** Root user (admin). */
  rootUser: string;
  /** Root password. */
  rootPassword: string;
}

export class RealMinioAdmin implements MinioAdmin {
  private readonly opts: RealMinioAdminOptions;
  constructor(opts: RealMinioAdminOptions) {
    this.opts = opts;
  }

  private client(): MinioClient {
    return new MinioClient({
      endPoint: this.opts.endPoint,
      port: this.opts.port ?? 9000,
      useSSL: this.opts.useSSL ?? false,
      accessKey: this.opts.rootUser,
      secretKey: this.opts.rootPassword,
    });
  }

  async createBucketAndKey(args: { bucket: string; accessKey: string; secretKey: string }): Promise<void> {
    assertS3Name(args.bucket);
    assertS3Name(args.accessKey);
    const c = this.client();
    if (!(await c.bucketExists(args.bucket))) {
      await c.makeBucket(args.bucket, "us-east-1");
    }
    // Create a service account scoped to this single bucket. The MinIO
    // Admin API exposes `addServiceAccount` on the standard SDK only
    // in some versions; if it's missing, fall back to the mc CLI shim
    // below. The compose stack ships modern minio so the SDK path is
    // expected to work in production.
    const adminAny = c as unknown as {
      addServiceAccount?: (args: {
        accessKey: string;
        secretKey: string;
        targetUser: string;
        policy?: string;
      }) => Promise<unknown>;
    };
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:*"],
          Resource: [`arn:aws:s3:::${args.bucket}`, `arn:aws:s3:::${args.bucket}/*`],
        },
      ],
    });
    if (typeof adminAny.addServiceAccount === "function") {
      await adminAny.addServiceAccount({
        accessKey: args.accessKey,
        secretKey: args.secretKey,
        targetUser: this.opts.rootUser,
        policy,
      });
      return;
    }
    throw new Error(
      "MinIO SDK does not expose addServiceAccount in this version — install a newer minio package or wire the mc CLI",
    );
  }

  async dropBucketAndKey(args: { bucket: string; accessKey: string }): Promise<void> {
    assertS3Name(args.bucket);
    assertS3Name(args.accessKey);
    const c = this.client();
    // Empty + remove the bucket.
    if (await c.bucketExists(args.bucket)) {
      const stream = c.listObjectsV2(args.bucket, "", true);
      const keys: string[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (o: { name?: string }) => {
          if (o.name) keys.push(o.name);
        });
        stream.on("end", () => resolve());
        stream.on("error", reject);
      });
      if (keys.length > 0) await c.removeObjects(args.bucket, keys);
      await c.removeBucket(args.bucket);
    }
    // Delete the service account.
    const adminAny = c as unknown as {
      deleteServiceAccount?: (accessKey: string) => Promise<unknown>;
    };
    if (typeof adminAny.deleteServiceAccount === "function") {
      await adminAny.deleteServiceAccount(args.accessKey).catch(() => {});
    }
  }

  async listObjects(bucket: string, prefix: string, max: number): Promise<{ key: string; size: number }[]> {
    assertS3Name(bucket);
    const cap = Math.max(1, Math.min(1000, Math.floor(max)));
    const c = this.client();
    const stream = c.listObjectsV2(bucket, prefix, true);
    const out: { key: string; size: number }[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (o: { name?: string; size?: number }) => {
        if (out.length < cap && o.name !== undefined) {
          out.push({ key: o.name, size: o.size ?? 0 });
        }
      });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    return out;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Validation helpers (defense-in-depth — DataProvisioner already
// validates upstream, but these admins may be called directly by
// operational tooling).
// ──────────────────────────────────────────────────────────────────────

const SAFE_PG_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
function assertSafeIdent(id: string): void {
  if (!SAFE_PG_IDENT.test(id)) {
    throw new Error(`unsafe Postgres identifier ${JSON.stringify(id)}`);
  }
}

const SAFE_REDIS_USER = /^[a-z0-9_]{1,64}$/;
function assertRedisUserName(u: string): void {
  if (!SAFE_REDIS_USER.test(u)) throw new Error(`unsafe Redis username ${JSON.stringify(u)}`);
}

const SAFE_REDIS_PREFIX = /^[a-z0-9-]+:[a-z0-9-]+:([a-z0-9]+:)?$/;
function assertRedisPrefix(p: string): void {
  if (!SAFE_REDIS_PREFIX.test(p)) {
    throw new Error(`unsafe Redis prefix ${JSON.stringify(p)} — expected creator:slug: or creator:slug:storeName:`);
  }
}

const SAFE_S3 = /^[a-z0-9](-?[a-z0-9])*(-([a-z0-9]+))*$/;
function assertS3Name(n: string): void {
  if (n.length < 3 || n.length > 63 || !SAFE_S3.test(n)) {
    throw new Error(`unsafe S3 name ${JSON.stringify(n)}`);
  }
}

/** Replace the database part of a Postgres connection URL. */
function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(db)}`;
  return u.toString();
}
