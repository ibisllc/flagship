import { describe, expect, it, vi } from "vitest";

const pgCalls: Array<{ url: string; sql: string; params?: unknown[] }> = [];
vi.mock("pg", () => {
  class Client {
    private readonly url: string;
    constructor(opts: { connectionString: string }) {
      this.url = opts.connectionString;
    }
    async connect(): Promise<void> {}
    async end(): Promise<void> {}
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; fields: unknown[] }> {
      pgCalls.push({ url: this.url, sql, ...(params ? { params } : {}) });
      return { rows: [], fields: [] };
    }
  }
  return { Client, default: { Client } };
});

import {
  APP_PG_EXTENSIONS,
  DataProvisioner,
  FILES_MOUNT,
  InMemoryFilesAdmin,
  InMemoryPostgresAdmin,
  RealFilesAdmin,
  RealPostgresAdmin,
  credentialsToEnv,
  filesVolume,
  filesVolumeOf,
  generateSecret,
  pgDatabase,
  postgresStoreNames,
  wantsAnyStore,
} from "../src/dataLayer/index.js";
import type { CommandRunner } from "../src/serviceRunner.js";

const KEY = "n".repeat(40);
const db = (creator: string, slug: string, storeName?: string, space?: "dev" | "prod") =>
  pgDatabase({ creator, slug, ...(storeName ? { storeName } : {}), ...(space ? { space } : {}) }, KEY);

function rig(opts: { secret?: () => string } = {}) {
  const pg = new InMemoryPostgresAdmin();
  const files = new InMemoryFilesAdmin();
  const prov = new DataProvisioner({
    postgres: pg,
    files,
    nameKey: KEY,
    generateSecret: opts.secret ?? (() => "secret"),
  });
  return { pg, files, prov };
}

describe("generateSecret", () => {
  it("produces 32 bytes of base64url with no padding chars", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThan(40);
  });
});

describe("store flags", () => {
  it("an older `kv` store asks for the default Postgres database; `objects` asks for the files folder", () => {
    expect(postgresStoreNames({ kv: true })).toEqual(["default"]);
    expect(postgresStoreNames({ postgres: ["a", "b"], kv: true })).toEqual(["a", "b"]);
    expect(wantsAnyStore({ objects: true })).toBe(true);
    expect(wantsAnyStore({})).toBe(false);
    expect(wantsAnyStore(undefined)).toBe(false);
  });
});

describe("DataProvisioner.provisionApp", () => {
  it("provisions only the stores declared in the manifest", async () => {
    const { pg, files, prov } = rig();
    const creds = await prov.provisionApp({ creator: "harry", slug: "habit-tracker", stores: { postgres: true } });
    expect(creds.postgres).toBeDefined();
    expect(creds.files).toBeUndefined();
    expect(pg.databases.has(db("harry", "habit-tracker"))).toBe(true);
    expect(files.volumes.size).toBe(0);
  });

  it("creates every app database with the extension list", async () => {
    const { pg, prov } = rig();
    await prov.provisionApp({ creator: "harry", slug: "x", stores: { postgres: true } });
    expect(pg.databases.get(db("harry", "x"))!.extensions).toEqual([...APP_PG_EXTENSIONS]);
  });

  it("provisions Postgres and a files folder, and produces matching env", async () => {
    const { files, prov } = rig();
    const creds = await prov.provisionApp({ creator: "harry", slug: "habits", stores: { postgres: true, files: true } });
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_PG_URL).toContain(db("harry", "habits"));
    expect(env.FLAGSHIP_PG_DATABASE).toBe(db("harry", "habits"));
    expect(env.FLAGSHIP_PG_ROLE).toBe(db("harry", "habits"));
    expect(env.FLAGSHIP_FILES_DIR).toBe(FILES_MOUNT);
    expect(FILES_MOUNT).toBe("/data");
    expect(creds.files).toEqual({ volume: "flagship-files-harry--habits" });
    expect(filesVolumeOf(creds)).toBe("flagship-files-harry--habits");
    expect(files.volumes.get("flagship-files-harry--habits")!.labels).toEqual({
      "flagship.files": "prod",
      "flagship.app": "harry--habits",
    });
    for (const k of Object.keys(env)) expect(k).toMatch(/^FLAGSHIP_/);
    // No S3 or Redis env any more.
    expect(Object.keys(env).some((k) => k.startsWith("FLAGSHIP_S3_") || k.startsWith("FLAGSHIP_REDIS_"))).toBe(false);
  });

  it("maps an older manifest's objects → files folder and kv → the Postgres database", async () => {
    const { pg, files, prov } = rig();
    const creds = await prov.provisionApp({ creator: "harry", slug: "old", stores: { objects: true, kv: true } });
    expect(Object.keys(creds.postgres!)).toEqual(["default"]);
    expect(pg.databases.has(db("harry", "old"))).toBe(true);
    expect(files.volumes.has("flagship-files-harry--old")).toBe(true);
  });

  it("URL-encodes generated passwords (defense against / # @ ? in secrets)", async () => {
    const { prov } = rig({ secret: () => "p/a@ss?word#" });
    const creds = await prov.provisionApp({ creator: "harry", slug: "x", stores: { postgres: true } });
    expect(creds.postgres!.default!.url).toContain("p%2Fa%40ss%3Fword%23");
  });

  it("writes the configured host and port into the URL", async () => {
    const prov = new DataProvisioner({
      postgres: new InMemoryPostgresAdmin(),
      nameKey: KEY,
      endpoints: { postgresHost: "host.flagship.internal", postgresPort: 5432 },
      generateSecret: () => "s",
    });
    const creds = await prov.provisionApp({ creator: "harry", slug: "x", stores: { postgres: true } });
    expect(creds.postgres!.default!.url).toBe(`postgresql://${db("harry", "x")}:s@host.flagship.internal:5432/${db("harry", "x")}`);
  });

  it("multi-store Postgres: each named store gets its own DB + role + suffixed env var", async () => {
    const { pg, prov } = rig();
    const creds = await prov.provisionApp({ creator: "harry", slug: "habits", stores: { postgres: ["main", "analytics"] } });
    expect(Object.keys(creds.postgres!).sort()).toEqual(["analytics", "main"]);
    expect(pg.databases.has(db("harry", "habits", "main"))).toBe(true);
    expect(pg.databases.has(db("harry", "habits", "analytics"))).toBe(true);
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_PG_URL_MAIN).toContain(db("harry", "habits", "main"));
    expect(env.FLAGSHIP_PG_URL_ANALYTICS).toContain(db("harry", "habits", "analytics"));
    expect(env.FLAGSHIP_PG_URL).toBeUndefined();
    expect(env.FLAGSHIP_PG_STORES).toBe("main,analytics");
  });

  it("a dashed store name gives env names with `_` (a dash is no env-name character)", async () => {
    const { prov } = rig();
    const creds = await prov.provisionApp({ creator: "harry", slug: "pics", stores: { postgres: ["main-photos"] } });
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_PG_URL_MAIN_PHOTOS).toContain(db("harry", "pics", "main-photos"));
    expect(Object.keys(env).every((k) => /^[A-Z_][A-Z0-9_]*$/.test(k))).toBe(true);
    expect(env.FLAGSHIP_PG_STORES).toBe("main-photos");
  });

  it("an empty seed map needs no execSql", async () => {
    const pg = new InMemoryPostgresAdmin();
    (pg as { execSql?: unknown }).execSql = undefined;
    const prov = new DataProvisioner({ postgres: pg, nameKey: KEY, generateSecret: () => "s" });
    const creds = await prov.provisionDevDataspace({ creator: "owner", slug: "stg-1", stores: { postgres: true }, seedSqlByStore: {} });
    expect(creds.postgres!.default!.database).toBe(db("owner", "stg-1", undefined, "dev"));
  });

  it("rejects a manifest with duplicate storeNames", async () => {
    const { prov } = rig();
    await expect(
      prov.provisionApp({ creator: "harry", slug: "x", stores: { postgres: ["main", "main"] } }),
    ).rejects.toThrow(/duplicate/);
  });

  it("throws if a store is requested but no admin or name key is configured", async () => {
    await expect(
      new DataProvisioner({}).provisionApp({ creator: "harry", slug: "x", stores: { postgres: true } }),
    ).rejects.toThrow(/postgres admin/);
    await expect(
      new DataProvisioner({ postgres: new InMemoryPostgresAdmin() }).provisionApp({
        creator: "harry",
        slug: "x",
        stores: { postgres: true },
      }),
    ).rejects.toThrow(/name key/);
    await expect(
      new DataProvisioner({ postgres: new InMemoryPostgresAdmin(), nameKey: KEY }).provisionApp({
        creator: "harry",
        slug: "x",
        stores: { files: true },
      }),
    ).rejects.toThrow(/files admin/);
  });

  it("files never wait on the Postgres stack", async () => {
    const files = new InMemoryFilesAdmin();
    const prov = new DataProvisioner({
      files,
      ready: async () => {
        throw new Error("postgres down");
      },
    });
    const creds = await prov.provisionApp({ creator: "harry", slug: "pics", stores: { files: true } });
    expect(creds.files!.volume).toBe("flagship-files-harry--pics");
  });

  it("leaves nothing half-made when a later store fails", async () => {
    const pg = new InMemoryPostgresAdmin();
    const files = new InMemoryFilesAdmin();
    await files.createVolume({ volume: "flagship-files-harry--x" });
    const prov = new DataProvisioner({ postgres: pg, files, nameKey: KEY, generateSecret: () => "s" });
    await expect(
      prov.provisionApp({ creator: "harry", slug: "x", stores: { postgres: true, files: true } }),
    ).rejects.toThrow(/already exists/);
    expect(pg.databases.size).toBe(0);
  });
});

describe("DataProvisioner.dropCredentials / deprovisionApp", () => {
  it("drops exactly what a set of credentials names", async () => {
    const { pg, files, prov } = rig();
    const creds = await prov.provisionApp({ creator: "harry", slug: "x", stores: { postgres: true, files: true } });
    await prov.dropCredentials(creds);
    expect(pg.databases.size).toBe(0);
    expect(files.volumes.size).toBe(0);
  });

  it("deprovisionApp drops only the stores it is asked to", async () => {
    const { pg, files, prov } = rig();
    await prov.provisionApp({ creator: "harry", slug: "x", stores: { postgres: true, files: true } });
    await prov.deprovisionApp({ creator: "harry", slug: "x", stores: { postgres: true } });
    expect(pg.databases.size).toBe(0);
    expect(files.volumes.size).toBe(1);
  });
});

describe("dev dataspace provisioning", () => {
  const app = { creator: "harry", slug: "notes" };
  const stores = { postgres: true, files: true } as const;

  it("provisions dev stores under the disjoint dev namespace", async () => {
    const { pg, files, prov } = rig();
    const creds = await prov.provisionDevDataspace({ ...app, stores });
    expect(creds.postgres!.default!.database).toBe(db("harry", "notes", undefined, "dev"));
    expect(creds.postgres!.default!.database.startsWith("__dev_")).toBe(true);
    expect(files.volumes.has("flagship-devfiles-harry--notes")).toBe(true);
    expect(files.volumes.get("flagship-devfiles-harry--notes")!.labels["flagship.files"]).toBe("dev");
    expect(pg.databases.has(db("harry", "notes"))).toBe(false);
  });

  it("seeds the dev Postgres store from synthesizer SQL", async () => {
    const { pg, prov } = rig();
    const seed = `INSERT INTO "users" (id) VALUES (1);\nINSERT INTO "users" (id) VALUES (2);\nINSERT INTO "notes" (id) VALUES (1);`;
    await prov.provisionDevDataspace({ ...app, stores: { postgres: true }, seedSqlByStore: { default: seed } });
    const tables = await pg.listTables(db("harry", "notes", undefined, "dev"));
    expect(tables.sort()).toEqual(["notes", "users"]);
  });

  it("teardownDevDataspace drops ONLY the dev stores, never prod", async () => {
    const { pg, files, prov } = rig();
    await prov.provisionApp({ ...app, stores });
    await prov.provisionDevDataspace({ ...app, stores });
    await prov.teardownDevDataspace({ ...app, stores });
    expect(pg.databases.has(db("harry", "notes", undefined, "dev"))).toBe(false);
    expect(files.volumes.has(filesVolume({ ...app, space: "dev" }))).toBe(false);
    expect(pg.databases.has(db("harry", "notes"))).toBe(true);
    expect(files.volumes.has(filesVolume(app))).toBe(true);
  });
});

describe("RealPostgresAdmin", () => {
  const adminUrl = "postgresql://flagship_admin:pw@127.0.0.1:5432/postgres";

  it("locks every database to its own role and creates the extensions as the admin, in the app's database", async () => {
    pgCalls.length = 0;
    const name = db("harry", "x");
    await new RealPostgresAdmin({ adminUrl }).createRoleAndDb({
      db: name,
      role: name,
      password: "it's",
      extensions: APP_PG_EXTENSIONS,
    });
    const onPostgres = pgCalls.filter((c) => c.url === adminUrl).map((c) => c.sql);
    expect(onPostgres).toEqual([
      `REVOKE CONNECT, TEMPORARY ON DATABASE "postgres" FROM PUBLIC`,
      `REVOKE CONNECT, TEMPORARY ON DATABASE "template1" FROM PUBLIC`,
      `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'it''s'`,
      // Its connection, timeout and temp-file limits (appQuota/pgQuota.ts).
      `ALTER ROLE "${name}" CONNECTION LIMIT 20`,
      `ALTER ROLE "${name}" SET statement_timeout = '30s'`,
      `ALTER ROLE "${name}" SET idle_in_transaction_session_timeout = '60s'`,
      `ALTER ROLE "${name}" SET temp_file_limit = '1GB'`,
      `CREATE DATABASE "${name}" OWNER "${name}"`,
      `REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`,
      `GRANT CONNECT, TEMPORARY ON DATABASE "${name}" TO "${name}"`,
    ]);
    const inApp = pgCalls.filter((c) => c.url !== adminUrl);
    expect(new Set(inApp.map((c) => new URL(c.url).pathname))).toEqual(new Set([`/${name}`]));
    expect(inApp.map((c) => c.sql)).toEqual(APP_PG_EXTENSIONS.map((e) => `CREATE EXTENSION IF NOT EXISTS "${e}"`));
  });

  it("refuses unsafe identifiers before touching the server", async () => {
    pgCalls.length = 0;
    const admin = new RealPostgresAdmin({ adminUrl });
    await expect(admin.createRoleAndDb({ db: `x"; DROP`, role: "x", password: "p" })).rejects.toThrow(/unsafe/);
    await expect(admin.createRoleAndDb({ db: "x", role: "x", password: "p", extensions: ["bad-ext"] })).rejects.toThrow(/unsafe/);
    expect(pgCalls).toEqual([]);
  });
});

describe("RealFilesAdmin", () => {
  function fakeDocker(existing: Set<string>) {
    const calls: string[] = [];
    const cmd: CommandRunner = {
      run: async (c, args) => {
        calls.push(`${c} ${args.join(" ")}`);
      },
      capture: async (c, args) => {
        calls.push(`${c} ${args.join(" ")}`);
        if (args[0] === "volume" && args[1] === "inspect") {
          const v = args[args.length - 1]!;
          if (!existing.has(v)) throw new Error("no such volume");
          return { stdout: args[3] === "{{.Mountpoint}}" ? `/var/lib/docker/volumes/${v}/_data\n` : `${v}\n`, stderr: "" };
        }
        if (args[0] === "volume" && args[1] === "create") existing.add(args[args.length - 1]!);
        if (args[0] === "volume" && args[1] === "rm") existing.delete(args[args.length - 1]!);
        if (c === "du") return { stdout: "12\t/x\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    };
    return { calls, cmd };
  }

  it("creates a labelled named volume and opens its root to the app's uid", async () => {
    const { calls, cmd } = fakeDocker(new Set());
    await new RealFilesAdmin(cmd).createVolume({ volume: "flagship-files-harry--x", labels: { "flagship.files": "prod" } });
    expect(calls).toContain("docker volume create --label flagship.files=prod flagship-files-harry--x");
    expect(calls).toContain("chmod 0777 /var/lib/docker/volumes/flagship-files-harry--x/_data");
  });

  it("refuses an existing volume and any name that isn't a files volume", async () => {
    const admin = new RealFilesAdmin(fakeDocker(new Set(["flagship-files-harry--x"])).cmd);
    await expect(admin.createVolume({ volume: "flagship-files-harry--x" })).rejects.toThrow(/already exists/);
    await expect(admin.createVolume({ volume: "/var/flagship/data" })).rejects.toThrow(/not a files volume/);
    await expect(admin.removeVolume("flagship-postgres")).rejects.toThrow(/not a files volume/);
  });

  it("reports the volume's size from du", async () => {
    const admin = new RealFilesAdmin(fakeDocker(new Set(["flagship-files-harry--x"])).cmd);
    expect(await admin.volumeBytes("flagship-files-harry--x")).toBe(12 * 1024);
    expect(await admin.volumeBytes("flagship-files-harry--y")).toBeNull();
  });
});
