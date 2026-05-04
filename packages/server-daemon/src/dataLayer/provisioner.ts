import type { AppDataStores } from "@flagship/protocol";
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
 * restart. The SWK wrapping means a stolen disk image yields ciphertext,
 * not credentials.
 */
export interface AppDataCredentials {
  username: string;
  appName: string;
  postgres?: { url: string; database: string; role: string };
  objects?: { endpoint: string; bucket: string; accessKey: string; secretKey: string };
  kv?: { url: string; user: string; prefix: string };
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
    const naming = { username, appName };
    const secret = this.opts.generateSecret ?? generateSecret;
    const ep = this.opts.endpoints ?? {};
    const out: AppDataCredentials = { username, appName };

    if (stores.postgres) {
      if (!this.opts.postgres) throw new Error("postgres admin not configured");
      const db = pgDatabase(naming);
      const role = pgRole(naming);
      const password = secret();
      await this.opts.postgres.createRoleAndDb({ db, role, password });
      const host = ep.postgresHost ?? "127.0.0.1";
      const port = ep.postgresPort ?? 5432;
      out.postgres = {
        url: `postgresql://${role}:${encodeURIComponent(password)}@${host}:${port}/${db}`,
        database: db,
        role,
      };
    }

    if (stores.objects) {
      if (!this.opts.objects) throw new Error("objects admin not configured");
      const bucket = s3Bucket(naming);
      const accessKey = s3AccessKey(naming);
      const secretKey = secret();
      await this.opts.objects.createBucketAndKey({ bucket, accessKey, secretKey });
      out.objects = {
        endpoint: ep.s3Endpoint ?? "http://127.0.0.1:9000",
        bucket,
        accessKey,
        secretKey,
      };
    }

    if (stores.kv) {
      if (!this.opts.kv) throw new Error("kv admin not configured");
      const user = redisUser(naming);
      const prefix = redisPrefix(naming);
      const password = secret();
      await this.opts.kv.createAclUser({ user, password, prefix });
      const host = ep.redisHost ?? "127.0.0.1";
      const port = ep.redisPort ?? 6379;
      // Clients honor either "user:password@host" or the AUTH command. We
      // use the URL form so node-redis / ioredis pick it up automatically.
      out.kv = {
        url: `redis://${user}:${encodeURIComponent(password)}@${host}:${port}/0?prefix=${encodeURIComponent(prefix)}`,
        user,
        prefix,
      };
    }
    return out;
  }

  async deprovisionApp(args: { username: string; appName: string; stores: AppDataStores }): Promise<void> {
    const naming = { username: args.username, appName: args.appName };
    if (args.stores.postgres && this.opts.postgres) {
      await this.opts.postgres.dropRoleAndDb({ db: pgDatabase(naming), role: pgRole(naming) });
    }
    if (args.stores.objects && this.opts.objects) {
      await this.opts.objects.dropBucketAndKey({
        bucket: s3Bucket(naming),
        accessKey: s3AccessKey(naming),
      });
    }
    if (args.stores.kv && this.opts.kv) {
      await this.opts.kv.dropAclUser(redisUser(naming));
    }
  }
}

/** Translate AppDataCredentials → the FLAGSHIP_* env bundle for AppRunner. */
export function credentialsToEnv(creds: AppDataCredentials): Record<string, string> {
  const env: Record<string, string> = {};
  if (creds.postgres) {
    env.FLAGSHIP_PG_URL = creds.postgres.url;
    env.FLAGSHIP_PG_DATABASE = creds.postgres.database;
    env.FLAGSHIP_PG_ROLE = creds.postgres.role;
  }
  if (creds.objects) {
    env.FLAGSHIP_S3_ENDPOINT = creds.objects.endpoint;
    env.FLAGSHIP_S3_BUCKET = creds.objects.bucket;
    env.FLAGSHIP_S3_ACCESS_KEY = creds.objects.accessKey;
    env.FLAGSHIP_S3_SECRET_KEY = creds.objects.secretKey;
  }
  if (creds.kv) {
    env.FLAGSHIP_REDIS_URL = creds.kv.url;
    env.FLAGSHIP_REDIS_USER = creds.kv.user;
    env.FLAGSHIP_REDIS_PREFIX = creds.kv.prefix;
  }
  return env;
}
