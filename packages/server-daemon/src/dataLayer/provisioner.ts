import { normalizeStoreFlag, isSingletonStore, wantsFiles, type AppDataStores } from "@flagship/protocol";
import type { FilesAdmin, PostgresAdmin } from "./admin.js";
import type { PgQuotaAdmin } from "../appQuota/pgQuota.js";
import {
  APP_PG_EXTENSIONS,
  DEFAULT_STORE_NAME,
  DEV_FILES_PREFIX,
  DEV_PG_PREFIX,
  FILES_MOUNT,
  filesVolume,
  generateSecret,
  pgDatabase,
  pgRole,
  type AppDataIdentity,
} from "./naming.js";

/**
 * Per-app credentials minted at deploy time. The daemon keeps them sealed
 * (the installed-services registry) and re-derives the env bundle on each
 * deploy / restart.
 *
 * Postgres carries a map of `storeName → credential`, so one app can hold
 * e.g. a `sprites` database next to a `levels` one; single-store apps
 * (`"postgres": true`) live under `"default"` and get unsuffixed env vars.
 * The files folder is one Docker volume per app.
 *
 * A registry saved by older code may also carry `objects` / `kv` entries:
 * nothing reads them (the box has no S3 or Redis), so they are inert.
 */
export interface PostgresStore {
  url: string;
  database: string;
  role: string;
}
export interface FilesStore {
  /** The Docker named volume mounted at `/data`. */
  volume: string;
}

export interface AppDataCredentials {
  creator: string;
  slug: string;
  /** True when the Postgres flag was `true` (single-store); drives env-var naming. */
  postgresSingleton?: boolean;
  postgres?: Record<string, PostgresStore>;
  files?: FilesStore;
}

export interface DataProvisionerOptions {
  postgres?: PostgresAdmin;
  files?: FilesAdmin;
  /**
   * The box's secret for opaque database/role names (DATA_NAME_KEY in
   * data-services.env). Required to make a Postgres store.
   */
  nameKey?: string;
  /** Local endpoints written into the credential URLs. */
  endpoints?: {
    postgresHost?: string;
    postgresPort?: number;
  };
  /** Override for tests so secrets are deterministic. */
  generateSecret?: () => string;
  /**
   * Resolves when Postgres can be used; throws (a `DataLayerUnavailableError`)
   * when it can't. Awaited before any Postgres work, so a down stack fails
   * fast with its reason. Files never wait on it.
   */
  ready?: () => Promise<void>;
  /**
   * A new files folder's limit (appQuota/: its budget, a staging copy's
   * quota or the safety size), read when the folder is made. Absent: no
   * limit of its own.
   */
  filesSizeBytes?: (volume: string) => number | undefined | Promise<number | undefined>;
  /** Database size limits (appQuota/pgQuota.ts), set with the Postgres admin. */
  pgQuota?: PgQuotaAdmin;
}

/** The Postgres store names a spec asks for (an older `kv` asks for the default one). */
export function postgresStoreNames(stores: AppDataStores | undefined): string[] {
  if (!stores) return [];
  const names = normalizeStoreFlag(stores.postgres);
  if (names.length > 0) return names;
  return normalizeStoreFlag(stores.kv).length > 0 ? [DEFAULT_STORE_NAME] : [];
}

/** Whether the spec asks for any store at all. */
export function wantsAnyStore(stores: AppDataStores | undefined): boolean {
  return postgresStoreNames(stores).length > 0 || wantsFiles(stores);
}

export class DataProvisioner {
  private opts: DataProvisionerOptions;
  constructor(opts: DataProvisionerOptions = {}) {
    this.opts = opts;
  }

  /**
   * Attach Postgres once it exists: on a box whose data-services secrets
   * appear after the daemon started (first boot), the runtime builds the
   * provisioner with files only and attaches Postgres when the stack turns
   * healthy.
   */
  attach(admins: Pick<DataProvisionerOptions, "postgres" | "files" | "endpoints" | "nameKey" | "pgQuota">): void {
    this.opts = { ...this.opts, ...admins };
  }

  /** Set how big a new files folder may be (the runtime, once its quota manager exists). */
  setFilesSize(fn: (volume: string) => number | undefined | Promise<number | undefined>): void {
    this.opts = { ...this.opts, filesSizeBytes: fn };
  }

  /** The database size limiter, once Postgres is attached. */
  pgQuota(): PgQuotaAdmin | null {
    return this.opts.postgres ? (this.opts.pgQuota ?? null) : null;
  }

  /** Staging databases (`__dev_…`), for their own small limit. */
  async devDatabases(): Promise<string[]> {
    const pg = this.opts.postgres;
    if (!pg?.listNamed) return [];
    return (await pg.listNamed(DEV_PG_PREFIX)).filter((n) => n.startsWith(DEV_PG_PREFIX));
  }

  /** Resolves when Postgres can be used; throws why not (see `ready`). */
  async checkReady(): Promise<void> {
    await this.opts.ready?.();
    if (!this.hasAdmins()) throw new Error("the data layer isn't set up on this server yet");
  }

  /** Whether Postgres is attached (false until the stack is first healthy). */
  hasAdmins(): boolean {
    return !!this.opts.postgres;
  }

  /** Whether this box can make files folders. */
  hasFiles(): boolean {
    return !!this.opts.files;
  }

  private pgAdmin(): { admin: PostgresAdmin; nameKey: string } {
    if (!this.opts.postgres) throw new Error("postgres admin not configured");
    if (!this.opts.nameKey) throw new Error("the data layer's name key isn't set up on this server");
    return { admin: this.opts.postgres, nameKey: this.opts.nameKey };
  }

  async provisionApp(args: {
    creator: string;
    slug: string;
    stores: AppDataStores;
    /** "prod" (default) or the disjoint "dev" dataspace a staging copy uses. */
    space?: "dev" | "prod";
  }): Promise<AppDataCredentials> {
    const { creator, slug, stores } = args;
    const space = args.space ?? "prod";
    const secret = this.opts.generateSecret ?? generateSecret;
    const ep = this.opts.endpoints ?? {};
    const out: AppDataCredentials = { creator, slug };
    const pgStores = postgresStoreNames(stores);
    const files = wantsFiles(stores);
    if (files && !this.opts.files) throw new Error("files admin not configured");

    try {
      if (pgStores.length > 0) {
        await this.opts.ready?.();
        const { admin, nameKey } = this.pgAdmin();
        out.postgresSingleton = isSingletonStore(stores.postgres) || normalizeStoreFlag(stores.postgres).length === 0;
        out.postgres = {};
        for (const storeName of pgStores) {
          const id: AppDataIdentity = { creator, slug, storeName, space };
          const db = pgDatabase(id, nameKey);
          const role = pgRole(id, nameKey);
          const password = secret();
          await admin.createRoleAndDb({ db, role, password, extensions: APP_PG_EXTENSIONS });
          const host = ep.postgresHost ?? "127.0.0.1";
          const port = ep.postgresPort ?? 5432;
          out.postgres[storeName] = {
            url: `postgresql://${role}:${encodeURIComponent(password)}@${host}:${port}/${db}`,
            database: db,
            role,
          };
        }
      }
      if (files) {
        const volume = filesVolume({ creator, slug, space });
        const sizeBytes = await this.opts.filesSizeBytes?.(volume);
        await this.opts.files!.createVolume({
          volume,
          labels: { "flagship.files": space, "flagship.app": `${creator}--${slug}` },
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        });
        out.files = { volume };
      }
    } catch (e) {
      // Leave nothing half-made behind.
      await this.dropCredentials(out).catch(() => {});
      throw e;
    }
    return out;
  }

  /**
   * Drop every store a set of credentials names (uninstall, a failed
   * install): by the names it holds, so an app restored from another box
   * loses exactly what it had.
   */
  async dropCredentials(creds: AppDataCredentials): Promise<void> {
    const pg = Object.values(creds.postgres ?? {});
    if (pg.length > 0 && this.opts.postgres) {
      await this.opts.ready?.();
      for (const s of pg) await this.opts.postgres.dropRoleAndDb({ db: s.database, role: s.role });
    }
    if (creds.files && this.opts.files) await this.opts.files.removeVolume(creds.files.volume);
  }

  /** Drop the stores an identity's names point at (the dev dataspace). */
  async deprovisionApp(args: {
    creator: string;
    slug: string;
    stores: AppDataStores;
    space?: "dev" | "prod";
  }): Promise<void> {
    const space = args.space ?? "prod";
    const pgStores = postgresStoreNames(args.stores);
    if (pgStores.length > 0 && this.opts.postgres && this.opts.nameKey) {
      await this.opts.ready?.();
      for (const storeName of pgStores) {
        const id: AppDataIdentity = { creator: args.creator, slug: args.slug, storeName, space };
        await this.opts.postgres.dropRoleAndDb({ db: pgDatabase(id, this.opts.nameKey), role: pgRole(id, this.opts.nameKey) });
      }
    }
    if (wantsFiles(args.stores) && this.opts.files) {
      await this.opts.files.removeVolume(filesVolume({ creator: args.creator, slug: args.slug, space }));
    }
  }

  /**
   * Provision the DEV dataspace for an app and seed its Postgres store(s) with
   * the synthesizer's fabricated rows. Returns dev credentials (same shape as
   * prod, but every name is in the disjoint dev namespace).
   *
   * The `seedSqlByStore` map is `storeName → seed SQL` from
   * `synth.datasetToSql(...)`. Absent stores are provisioned empty. This method
   * NEVER touches a prod store: every identity it builds carries `space:"dev"`.
   *
   * If a dev store already exists (a re-mint), call `teardownDevDataspace` first.
   */
  async provisionDevDataspace(args: {
    creator: string;
    slug: string;
    stores: AppDataStores;
    seedSqlByStore?: Record<string, string>;
  }): Promise<AppDataCredentials> {
    const creds = await this.provisionApp({
      creator: args.creator,
      slug: args.slug,
      stores: args.stores,
      space: "dev",
    });
    if (creds.postgres && args.seedSqlByStore) {
      for (const [storeName, store] of Object.entries(creds.postgres)) {
        const seed = args.seedSqlByStore[storeName];
        if (!seed) continue;
        if (!this.opts.postgres?.execSql) {
          throw new Error("postgres admin does not support execSql; cannot seed dev dataspace");
        }
        // Defence in depth: refuse to seed anything that isn't a dev database.
        if (!store.database.startsWith(DEV_PG_PREFIX)) {
          throw new Error(`refusing to seed non-dev database ${store.database}`);
        }
        await this.opts.postgres.execSql({ db: store.database, sql: seed });
      }
    }
    return creds;
  }

  /** Tear down an app's DEV dataspace. Only ever drops dev-namespaced stores. */
  async teardownDevDataspace(args: {
    creator: string;
    slug: string;
    stores: AppDataStores;
  }): Promise<void> {
    await this.deprovisionApp({
      creator: args.creator,
      slug: args.slug,
      stores: args.stores,
      space: "dev",
    });
  }

  /**
   * Drop every DEV store except those of the identities in `keep` (the boot
   * sweep of copies a restart orphaned). Only `__dev_` databases/roles and
   * `flagship-devfiles-` volumes are ever considered; a prod name can't match.
   */
  async sweepDevDataspaces(
    keep: () => readonly { creator: string; slug: string; stores: AppDataStores }[],
  ): Promise<{ databases: number; volumes: number }> {
    // Read at each drop, after the listing: a copy that started meanwhile
    // has named its stores before it makes them, so it is never swept.
    const kept = () => {
      const pgNames = new Set<string>();
      const volumeNames = new Set<string>();
      for (const k of keep()) {
        if (this.opts.nameKey) {
          for (const storeName of postgresStoreNames(k.stores)) {
            pgNames.add(pgDatabase({ creator: k.creator, slug: k.slug, storeName, space: "dev" }, this.opts.nameKey));
          }
        }
        if (wantsFiles(k.stores)) volumeNames.add(filesVolume({ creator: k.creator, slug: k.slug, space: "dev" }));
      }
      return { pgNames, volumeNames };
    };
    let databases = 0;
    let volumes = 0;
    const pg = this.opts.postgres;
    if (pg?.listNamed) {
      await this.opts.ready?.();
      for (const name of await pg.listNamed(DEV_PG_PREFIX)) {
        if (!name.startsWith(DEV_PG_PREFIX) || kept().pgNames.has(name)) continue;
        await pg.dropRoleAndDb({ db: name, role: name });
        databases++;
      }
    }
    const files = this.opts.files;
    if (files?.listVolumes) {
      for (const v of await files.listVolumes(DEV_FILES_PREFIX)) {
        if (!v.startsWith(DEV_FILES_PREFIX) || kept().volumeNames.has(v)) continue;
        await files.removeVolume(v);
        volumes++;
      }
    }
    return { databases, volumes };
  }

  // Read-only accessors used by the data dashboard.
  async listPostgresTables(db: string): Promise<string[]> {
    if (!this.opts.postgres) throw new Error("postgres admin not configured");
    return this.opts.postgres.listTables(db);
  }
  async queryPostgres(args: { db: string; sql: string; maxRows: number }): Promise<{ columns: string[]; rows: unknown[][] }> {
    if (!this.opts.postgres) throw new Error("postgres admin not configured");
    return this.opts.postgres.query(args);
  }
  /** Bytes an app's files folder uses, or null when unknown. */
  async filesBytes(volume: string): Promise<number | null> {
    if (!this.opts.files) return null;
    return this.opts.files.volumeBytes(volume);
  }
}

/** `_<INSTANCE>` for a named store; a dash in its name becomes `_` (env names have none). */
function envSuffix(storeName: string): string {
  return `_${storeName.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Translate AppDataCredentials → the FLAGSHIP_* env bundle for AppRunner.
 *
 * Single-store apps produce unsuffixed env vars (FLAGSHIP_PG_URL); multi-
 * store apps one suffix per store name (FLAGSHIP_PG_URL_SPRITES) plus
 * FLAGSHIP_PG_STORES. An app with files gets FLAGSHIP_FILES_DIR.
 */
export function credentialsToEnv(creds: AppDataCredentials): Record<string, string> {
  const env: Record<string, string> = {};
  if (creds.postgres) {
    for (const [storeName, c] of Object.entries(creds.postgres)) {
      const suffix = creds.postgresSingleton ? "" : envSuffix(storeName);
      env[`FLAGSHIP_PG_URL${suffix}`] = c.url;
      env[`FLAGSHIP_PG_DATABASE${suffix}`] = c.database;
      env[`FLAGSHIP_PG_ROLE${suffix}`] = c.role;
    }
    if (!creds.postgresSingleton) {
      env.FLAGSHIP_PG_STORES = Object.keys(creds.postgres).join(",");
    }
  }
  if (creds.files) env.FLAGSHIP_FILES_DIR = FILES_MOUNT;
  return env;
}

/** The files volume a set of credentials mounts, if any. */
export function filesVolumeOf(creds: AppDataCredentials | null | undefined): string | undefined {
  return creds?.files?.volume;
}
