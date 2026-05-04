import { describe, expect, it } from "vitest";
import {
  DataProvisioner,
  InMemoryMinioAdmin,
  InMemoryPostgresAdmin,
  InMemoryRedisAdmin,
  credentialsToEnv,
  generateSecret,
  pgDatabase,
  pgRole,
  redisPrefix,
  redisUser,
  s3AccessKey,
  s3Bucket,
} from "../src/dataLayer/index.js";

describe("naming helpers", () => {
  it("Postgres database name uses the flagship_<user>_<app> shape with underscores", () => {
    expect(pgDatabase({ username: "harry", appName: "habit-tracker" })).toBe(
      "flagship_harry_habit_tracker",
    );
  });
  it("S3 bucket is hyphenated and DNS-safe", () => {
    expect(s3Bucket({ username: "harry", appName: "habit-tracker" })).toBe("harry-habit-tracker");
  });
  it("Redis prefix has trailing colon for safe glob matching", () => {
    expect(redisPrefix({ username: "harry", appName: "habits" })).toBe("harry:habits:");
  });
  it("rejects non-DNS-label inputs (typo defense; could otherwise inject SQL identifiers)", () => {
    expect(() => pgDatabase({ username: "Harry!", appName: "x" })).toThrow();
    expect(() => s3Bucket({ username: "h", appName: "with.dot" })).toThrow();
  });
  it("generateSecret produces 32 bytes of base64url with no padding chars", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThan(40);
  });
  it("pgRole equals pgDatabase (one role per app keeps RBAC predictable)", () => {
    const naming = { username: "harry", appName: "x" };
    expect(pgRole(naming)).toBe(pgDatabase(naming));
  });
  it("redisUser equals pgRole (callers can refer to one identifier)", () => {
    const naming = { username: "harry", appName: "x" };
    expect(redisUser(naming)).toBe(pgRole(naming));
  });
  it("s3AccessKey equals s3Bucket", () => {
    const naming = { username: "harry", appName: "x" };
    expect(s3AccessKey(naming)).toBe(s3Bucket(naming));
  });
});

describe("DataProvisioner.provisionApp", () => {
  function setup() {
    return {
      pg: new InMemoryPostgresAdmin(),
      objects: new InMemoryMinioAdmin(),
      kv: new InMemoryRedisAdmin(),
    };
  }

  it("provisions only the stores declared in the manifest", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "fixed-secret",
    });
    const creds = await prov.provisionApp({
      username: "harry",
      appName: "habit-tracker",
      stores: { postgres: true, objects: false, kv: false },
    });
    expect(creds.postgres).toBeDefined();
    expect(creds.objects).toBeUndefined();
    expect(creds.kv).toBeUndefined();
    expect(pg.databases.has("flagship_harry_habit_tracker")).toBe(true);
    expect(objects.buckets.size).toBe(0);
    expect(kv.users.size).toBe(0);
  });

  it("provisions all three when all flags are true and produces matching env", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "secret",
    });
    const creds = await prov.provisionApp({
      username: "harry",
      appName: "habits",
      stores: { postgres: true, objects: true, kv: true },
    });
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_PG_URL).toContain("flagship_harry_habits");
    expect(env.FLAGSHIP_S3_BUCKET).toBe("harry-habits");
    expect(env.FLAGSHIP_REDIS_URL).toContain(encodeURIComponent("harry:habits:"));
    expect(env.FLAGSHIP_REDIS_PREFIX).toBe("harry:habits:");
    // No app-supplied env can use FLAGSHIP_ — all of these come from the runtime.
    for (const k of Object.keys(env)) expect(k).toMatch(/^FLAGSHIP_/);
  });

  it("URL-encodes generated passwords (defense against / # @ ? in secrets)", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "p/a@ss?word#",
    });
    const creds = await prov.provisionApp({
      username: "harry",
      appName: "x",
      stores: { postgres: true, kv: true },
    });
    expect(creds.postgres!.default!.url).toContain("p%2Fa%40ss%3Fword%23");
    expect(creds.kv!.default!.url).toContain("p%2Fa%40ss%3Fword%23");
  });

  it("multi-instance Postgres: each named instance gets its own DB + role + suffixed env var", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "s",
    });
    const creds = await prov.provisionApp({
      username: "harry",
      appName: "habits",
      stores: { postgres: ["main", "analytics"] },
    });
    expect(Object.keys(creds.postgres!).sort()).toEqual(["analytics", "main"]);
    expect(pg.databases.has("flagship_harry_habits_main")).toBe(true);
    expect(pg.databases.has("flagship_harry_habits_analytics")).toBe(true);
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_PG_URL_MAIN).toContain("flagship_harry_habits_main");
    expect(env.FLAGSHIP_PG_URL_ANALYTICS).toContain("flagship_harry_habits_analytics");
    expect(env.FLAGSHIP_PG_URL).toBeUndefined(); // no singleton when multi-instance
    expect(env.FLAGSHIP_PG_INSTANCES).toBe("main,analytics");
  });

  it("multi-instance MinIO: hyphen suffix in bucket names, _<INST> suffix in env vars", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "s",
    });
    const creds = await prov.provisionApp({
      username: "harry",
      appName: "habits",
      stores: { objects: ["public", "private"] },
    });
    expect(objects.buckets.has("harry-habits-public")).toBe(true);
    expect(objects.buckets.has("harry-habits-private")).toBe(true);
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_S3_BUCKET_PUBLIC).toBe("harry-habits-public");
    expect(env.FLAGSHIP_S3_BUCKET_PRIVATE).toBe("harry-habits-private");
  });

  it("multi-instance Redis: prefix carries the instance name (`<user>:<app>:<instance>:`)", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "s",
    });
    const creds = await prov.provisionApp({
      username: "harry",
      appName: "habits",
      stores: { kv: ["cache", "queue"] },
    });
    expect(creds.kv!.cache.prefix).toBe("harry:habits:cache:");
    expect(creds.kv!.queue.prefix).toBe("harry:habits:queue:");
  });

  it("rejects manifest with duplicate instance names at the provisioner boundary", async () => {
    const prov = new DataProvisioner({ postgres: new InMemoryPostgresAdmin() });
    await expect(
      prov.provisionApp({
        username: "harry",
        appName: "x",
        stores: { postgres: ["main", "main"] },
      }),
    ).rejects.toThrow(/duplicate/);
  });

  it("throws if a store is requested but no admin is configured", async () => {
    const prov = new DataProvisioner({});
    await expect(
      prov.provisionApp({
        username: "harry",
        appName: "x",
        stores: { postgres: true },
      }),
    ).rejects.toThrow(/postgres admin/);
  });
});

describe("DataProvisioner.deprovisionApp", () => {
  it("drops only the stores that were provisioned", async () => {
    const pg = new InMemoryPostgresAdmin();
    const objects = new InMemoryMinioAdmin();
    const kv = new InMemoryRedisAdmin();
    const prov = new DataProvisioner({ postgres: pg, objects, kv });
    await prov.provisionApp({
      username: "harry",
      appName: "x",
      stores: { postgres: true, objects: true, kv: true },
    });
    await prov.deprovisionApp({
      username: "harry",
      appName: "x",
      stores: { postgres: true, objects: false, kv: true },
    });
    expect(pg.databases.size).toBe(0);
    expect(objects.buckets.size).toBe(1); // not asked to drop objects
    expect(kv.users.size).toBe(0);
  });
});
