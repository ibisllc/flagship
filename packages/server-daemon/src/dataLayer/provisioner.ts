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
} from "./naming.js";

/**
 * Per-app credentials minted at deploy time. The daemon stores these wrapped
 * under SWK and re-derives the env-var bundle on each AppRunner deploy /
 * restart.
 *
 * Each store carries a map of `instance → instance-credential` so a single
 * app can have e.g. a `main` Postgres database alongside an `analytics` one.
 * Singleton stores live under the implicit `"default"` instance.
 */
export interface PostgresInstance {
  url: string;
  database: string;
  role: string;
}
export interface ObjectsInstance {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}
export interface KvInstance {
  url: string;
  user: string;
  prefix: string;
}

export interface AppDataCredentials {
  username: string;
  appName: string;
  /** True when the corresponding store flag was `true` (singleton); drives env-var naming. */
  postgresSingleton?: boolean;
  objectsSingleton?: boolean;
  kvSingleton?: boolean;
  postgres?: Record<string, PostgresInstance>;
  objects?: Record<string, ObjectsInstance>;
  kv?: Record<string, KvInstance>;
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
    username: string;
    appName: string;
    stores: AppDataStores;
  }): Promise<AppDataCredentials> {
    const { username, appName, stores } = args;
    const secret = this.opts.generateSecret ?? generateSecret;
    const ep = this.opts.endpoints ?? {};
    const out: AppDataCredentials = { username, appName };

    const pgInstances = normalizeStoreFlag(stores.postgres);
    if (pgInstances.length > 0) {
      if (!this.opts.postgres) throw new Error("postgres admin not configured");
      out.postgresSingleton = isSingletonStore(stores.postgres);
      out.postgres = {};
      for (const instance of pgInstances) {
        const naming = { username, appName, instance };
        const db = pgDatabase(naming);
        const role = pgRole(naming);
        const password = secret();
        await this.opts.postgres.createRoleAndDb({ db, role, password });
        const host = ep.postgresHost ?? "127.0.0.1";
        const port = ep.postgresPort ?? 5432;
        out.postgres[instance] = {
          url: `postgresql://${role}:${encodeURIComponent(password)}@${host}:${port}/${db}`,
          database: db,
          role,
        };
      }
    }

    const s3Instances = normalizeStoreFlag(stores.objects);
    if (s3Instances.length > 0) {
      if (!this.opts.objects) throw new Error("objects admin not configured");
      out.objectsSingleton = isSingletonStore(stores.objects);
      out.objects = {};
      for (const instance of s3Instances) {
        const naming = { username, appName, instance };
        const bucket = s3Bucket(naming);
        const accessKey = s3AccessKey(naming);
        const secretKey = secret();
        await this.opts.objects.createBucketAndKey({ bucket, accessKey, secretKey });
        out.objects[instance] = {
          endpoint: ep.s3Endpoint ?? "http://127.0.0.1:9000",
          bucket,
          accessKey,
          secretKey,
        };
      }
    }

    const kvInstances = normalizeStoreFlag(stores.kv);
    if (kvInstances.length > 0) {
      if (!this.opts.kv) throw new Error("kv admin not configured");
      out.kvSingleton = isSingletonStore(stores.kv);
      out.kv = {};
      for (const instance of kvInstances) {
        const naming = { username, appName, instance };
        const user = redisUser(naming);
        const prefix = redisPrefix(naming);
        const password = secret();
        await this.opts.kv.createAclUser({ user, password, prefix });
        const host = ep.redisHost ?? "127.0.0.1";
        const port = ep.redisPort ?? 6379;
        out.kv[instance] = {
          url: `redis://${user}:${encodeURIComponent(password)}@${host}:${port}/0?prefix=${encodeURIComponent(prefix)}`,
          user,
          prefix,
        };
      }
    }
    return out;
  }

  async deprovisionApp(args: { username: string; appName: string; stores: AppDataStores }): Promise<void> {
    for (const instance of normalizeStoreFlag(args.stores.postgres)) {
      if (!this.opts.postgres) continue;
      const naming = { username: args.username, appName: args.appName, instance };
      await this.opts.postgres.dropRoleAndDb({ db: pgDatabase(naming), role: pgRole(naming) });
    }
    for (const instance of normalizeStoreFlag(args.stores.objects)) {
      if (!this.opts.objects) continue;
      const naming = { username: args.username, appName: args.appName, instance };
      await this.opts.objects.dropBucketAndKey({
        bucket: s3Bucket(naming),
        accessKey: s3AccessKey(naming),
      });
    }
    for (const instance of normalizeStoreFlag(args.stores.kv)) {
      if (!this.opts.kv) continue;
      const naming = { username: args.username, appName: args.appName, instance };
      await this.opts.kv.dropAclUser(redisUser(naming));
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
 * Singleton stores produce unsuffixed env vars (FLAGSHIP_PG_URL); multi-instance
 * stores produce one suffix per instance (FLAGSHIP_PG_URL_MAIN, FLAGSHIP_PG_URL_ANALYTICS).
 */
export function credentialsToEnv(creds: AppDataCredentials): Record<string, string> {
  const env: Record<string, string> = {};

  if (creds.postgres) {
    for (const [instance, c] of Object.entries(creds.postgres)) {
      const suffix = creds.postgresSingleton ? "" : `_${instance.replace(/-/g, "_").toUpperCase()}`;
      env[`FLAGSHIP_PG_URL${suffix}`] = c.url;
      env[`FLAGSHIP_PG_DATABASE${suffix}`] = c.database;
      env[`FLAGSHIP_PG_ROLE${suffix}`] = c.role;
    }
    if (!creds.postgresSingleton) {
      env.FLAGSHIP_PG_INSTANCES = Object.keys(creds.postgres).join(",");
    }
  }

  if (creds.objects) {
    for (const [instance, c] of Object.entries(creds.objects)) {
      const suffix = creds.objectsSingleton ? "" : `_${instance.replace(/-/g, "_").toUpperCase()}`;
      env[`FLAGSHIP_S3_ENDPOINT${suffix}`] = c.endpoint;
      env[`FLAGSHIP_S3_BUCKET${suffix}`] = c.bucket;
      env[`FLAGSHIP_S3_ACCESS_KEY${suffix}`] = c.accessKey;
      env[`FLAGSHIP_S3_SECRET_KEY${suffix}`] = c.secretKey;
    }
    if (!creds.objectsSingleton) {
      env.FLAGSHIP_S3_INSTANCES = Object.keys(creds.objects).join(",");
    }
  }

  if (creds.kv) {
    for (const [instance, c] of Object.entries(creds.kv)) {
      const suffix = creds.kvSingleton ? "" : `_${instance.replace(/-/g, "_").toUpperCase()}`;
      env[`FLAGSHIP_REDIS_URL${suffix}`] = c.url;
      env[`FLAGSHIP_REDIS_USER${suffix}`] = c.user;
      env[`FLAGSHIP_REDIS_PREFIX${suffix}`] = c.prefix;
    }
    if (!creds.kvSingleton) {
      env.FLAGSHIP_REDIS_INSTANCES = Object.keys(creds.kv).join(",");
    }
  }

  return env;
}
