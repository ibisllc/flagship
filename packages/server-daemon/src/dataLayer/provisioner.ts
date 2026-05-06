import { normalizeStoreFlag, isSingletonStore, type AppDataStores } from "@flagship/protocol";
import type { MinioAdmin, PostgresAdmin, RedisAdmin } from "./admin.js";
import {
  generateSecret,
  pgDatabase,
  pgRole,
  redisPrefix,
  redisUser,
  s3AccessKey,
  s3Bucket,
  type AppDataIdentity,
} from "./naming.js";

/**
 * Per-app credentials minted at deploy time. The daemon stores these wrapped
 * under SWK and re-derives the env-var bundle on each AppRunner deploy /
 * restart.
 *
 * Each store carries a map of `storeName → store-credential` so a single
 * app can have e.g. a `sprites` Postgres database alongside a `levels`
 * one. Single-store apps (`"postgres": true` in the manifest) live under
 * the implicit `"default"` storeName and produce unsuffixed env vars.
 */
export interface PostgresStore {
  url: string;
  database: string;
  role: string;
}
export interface ObjectsStore {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}
export interface KvStore {
  url: string;
  user: string;
  prefix: string;
}

export interface AppDataCredentials {
  creator: string;
  slug: string;
  /** True when the corresponding store flag was `true` (single-store); drives env-var naming. */
  postgresSingleton?: boolean;
  objectsSingleton?: boolean;
  kvSingleton?: boolean;
  postgres?: Record<string, PostgresStore>;
  objects?: Record<string, ObjectsStore>;
  kv?: Record<string, KvStore>;
}

export interface DataProvisionerOptions {
  postgres?: PostgresAdmin;
  objects?: MinioAdmin;
  kv?: RedisAdmin;
  /** Local endpoints written into the credential URLs. Sensible defaults for the in-server data layer. */
  endpoints?: {
    postgresHost?: string;
    postgresPort?: number;
    s3Endpoint?: string;
    redisHost?: string;
    redisPort?: number;
  };
  /** Override for tests so secrets are deterministic. */
  generateSecret?: () => string;
}

export class DataProvisioner {
  constructor(private readonly opts: DataProvisionerOptions = {}) {}

  async provisionApp(args: {
    creator: string;
    slug: string;
    stores: AppDataStores;
  }): Promise<AppDataCredentials> {
    const { creator, slug, stores } = args;
    const secret = this.opts.generateSecret ?? generateSecret;
    const ep = this.opts.endpoints ?? {};
    const out: AppDataCredentials = { creator, slug };

    const pgStores = normalizeStoreFlag(stores.postgres);
    if (pgStores.length > 0) {
      if (!this.opts.postgres) throw new Error("postgres admin not configured");
      out.postgresSingleton = isSingletonStore(stores.postgres);
      out.postgres = {};
      for (const storeName of pgStores) {
        const id: AppDataIdentity = { creator, slug, storeName };
        const db = pgDatabase(id);
        const role = pgRole(id);
        const password = secret();
        await this.opts.postgres.createRoleAndDb({ db, role, password });
        const host = ep.postgresHost ?? "127.0.0.1";
        const port = ep.postgresPort ?? 5432;
        out.postgres[storeName] = {
          url: `postgresql://${role}:${encodeURIComponent(password)}@${host}:${port}/${db}`,
          database: db,
          role,
        };
      }
    }

    const s3Stores = normalizeStoreFlag(stores.objects);
    if (s3Stores.length > 0) {
      if (!this.opts.objects) throw new Error("objects admin not configured");
      out.objectsSingleton = isSingletonStore(stores.objects);
      out.objects = {};
      for (const storeName of s3Stores) {
        const id: AppDataIdentity = { creator, slug, storeName };
        const bucket = s3Bucket(id);
        const accessKey = s3AccessKey(id);
        const secretKey = secret();
        await this.opts.objects.createBucketAndKey({ bucket, accessKey, secretKey });
        out.objects[storeName] = {
          endpoint: ep.s3Endpoint ?? "http://127.0.0.1:9000",
          bucket,
          accessKey,
          secretKey,
        };
      }
    }

    const kvStores = normalizeStoreFlag(stores.kv);
    if (kvStores.length > 0) {
      if (!this.opts.kv) throw new Error("kv admin not configured");
      out.kvSingleton = isSingletonStore(stores.kv);
      out.kv = {};
      for (const storeName of kvStores) {
        const id: AppDataIdentity = { creator, slug, storeName };
        const user = redisUser(id);
        const prefix = redisPrefix(id);
        const password = secret();
        await this.opts.kv.createAclUser({ user, password, prefix });
        const host = ep.redisHost ?? "127.0.0.1";
        const port = ep.redisPort ?? 6379;
        out.kv[storeName] = {
          url: `redis://${user}:${encodeURIComponent(password)}@${host}:${port}/0?prefix=${encodeURIComponent(prefix)}`,
          user,
          prefix,
        };
      }
    }
    return out;
  }

  async deprovisionApp(args: {
    creator: string;
    slug: string;
    stores: AppDataStores;
  }): Promise<void> {
    for (const storeName of normalizeStoreFlag(args.stores.postgres)) {
      if (!this.opts.postgres) continue;
      const id: AppDataIdentity = { creator: args.creator, slug: args.slug, storeName };
      await this.opts.postgres.dropRoleAndDb({ db: pgDatabase(id), role: pgRole(id) });
    }
    for (const storeName of normalizeStoreFlag(args.stores.objects)) {
      if (!this.opts.objects) continue;
      const id: AppDataIdentity = { creator: args.creator, slug: args.slug, storeName };
      await this.opts.objects.dropBucketAndKey({
        bucket: s3Bucket(id),
        accessKey: s3AccessKey(id),
      });
    }
    for (const storeName of normalizeStoreFlag(args.stores.kv)) {
      if (!this.opts.kv) continue;
      const id: AppDataIdentity = { creator: args.creator, slug: args.slug, storeName };
      await this.opts.kv.dropAclUser(redisUser(id));
    }
  }

  // Read-only accessors used by the data dashboard. Each throws if the
  // corresponding admin isn't configured.
  async listPostgresTables(db: string): Promise<string[]> {
    if (!this.opts.postgres) throw new Error("postgres admin not configured");
    return this.opts.postgres.listTables(db);
  }
  async queryPostgres(args: { db: string; sql: string; maxRows: number }): Promise<{ columns: string[]; rows: unknown[][] }> {
    if (!this.opts.postgres) throw new Error("postgres admin not configured");
    return this.opts.postgres.query(args);
  }
  async listObjects(bucket: string, prefix: string, max: number): Promise<{ key: string; size: number }[]> {
    if (!this.opts.objects) throw new Error("objects admin not configured");
    return this.opts.objects.listObjects(bucket, prefix, max);
  }
  async listKvKeys(prefix: string, max: number): Promise<string[]> {
    if (!this.opts.kv) throw new Error("kv admin not configured");
    return this.opts.kv.listKeys(prefix, max);
  }
}

/**
 * Translate AppDataCredentials → the FLAGSHIP_* env bundle for AppRunner.
 *
 * Single-store apps produce unsuffixed env vars (FLAGSHIP_PG_URL); multi-
 * store apps produce one suffix per store name (FLAGSHIP_PG_URL_SPRITES,
 * FLAGSHIP_PG_URL_LEVELS).
 *
 * Helper var `FLAGSHIP_<STORE>_STORES` lists comma-separated store names
 * for multi-store apps; absent for single-store.
 */
export function credentialsToEnv(creds: AppDataCredentials): Record<string, string> {
  const env: Record<string, string> = {};

  if (creds.postgres) {
    for (const [storeName, c] of Object.entries(creds.postgres)) {
      const suffix = creds.postgresSingleton ? "" : `_${storeName.toUpperCase()}`;
      env[`FLAGSHIP_PG_URL${suffix}`] = c.url;
      env[`FLAGSHIP_PG_DATABASE${suffix}`] = c.database;
      env[`FLAGSHIP_PG_ROLE${suffix}`] = c.role;
    }
    if (!creds.postgresSingleton) {
      env.FLAGSHIP_PG_STORES = Object.keys(creds.postgres).join(",");
    }
  }

  if (creds.objects) {
    for (const [storeName, c] of Object.entries(creds.objects)) {
      const suffix = creds.objectsSingleton ? "" : `_${storeName.toUpperCase()}`;
      env[`FLAGSHIP_S3_ENDPOINT${suffix}`] = c.endpoint;
      env[`FLAGSHIP_S3_BUCKET${suffix}`] = c.bucket;
      env[`FLAGSHIP_S3_ACCESS_KEY${suffix}`] = c.accessKey;
      env[`FLAGSHIP_S3_SECRET_KEY${suffix}`] = c.secretKey;
    }
    if (!creds.objectsSingleton) {
      env.FLAGSHIP_S3_STORES = Object.keys(creds.objects).join(",");
    }
  }

  if (creds.kv) {
    for (const [storeName, c] of Object.entries(creds.kv)) {
      const suffix = creds.kvSingleton ? "" : `_${storeName.toUpperCase()}`;
      env[`FLAGSHIP_REDIS_URL${suffix}`] = c.url;
      env[`FLAGSHIP_REDIS_USER${suffix}`] = c.user;
      env[`FLAGSHIP_REDIS_PREFIX${suffix}`] = c.prefix;
    }
    if (!creds.kvSingleton) {
      env.FLAGSHIP_REDIS_STORES = Object.keys(creds.kv).join(",");
    }
  }

  return env;
}
