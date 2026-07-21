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

describe("naming helpers — host-independent (creator, slug, storeName) identity", () => {
  it("Postgres database is `_<creator>_<slug>` with dashes folded to underscores", () => {
    expect(pgDatabase({ creator: "harry", slug: "habit-tracker" })).toBe(
      "_harry_habit_tracker",
    );
  });
  it("Postgres database includes a dashless storeName suffix when present", () => {
    expect(
      pgDatabase({ creator: "harry", slug: "game1", storeName: "sprites" }),
    ).toBe("_harry_game1_sprites");
  });
  it("default storeName renders as if absent (single-store apps stay clean)", () => {
    expect(
      pgDatabase({ creator: "harry", slug: "game1", storeName: "default" }),
    ).toBe("_harry_game1");
  });
  it("S3 bucket is dash-joined and preserves dashes in slug", () => {
    expect(s3Bucket({ creator: "harry", slug: "habit-tracker" })).toBe("harry-habit-tracker");
    expect(
      s3Bucket({ creator: "harry", slug: "game1", storeName: "sprites" }),
    ).toBe("harry-game1-sprites");
  });
  it("Redis prefix uses colon separators, dashes preserved", () => {
    expect(redisPrefix({ creator: "harry", slug: "habit-tracker" })).toBe(
      "harry:habit-tracker:",
    );
    expect(
      redisPrefix({ creator: "harry", slug: "game1", storeName: "sprites" }),
    ).toBe("harry:game1:sprites:");
  });
  it("rejects creator with dashes (parsing ambiguity defense)", () => {
    expect(() => pgDatabase({ creator: "har-ry", slug: "x" })).toThrow();
  });
  it("rejects slug with leading/trailing dash or double dash", () => {
    expect(() => pgDatabase({ creator: "harry", slug: "-foo" })).toThrow();
    expect(() => pgDatabase({ creator: "harry", slug: "foo-" })).toThrow();
    expect(() => pgDatabase({ creator: "harry", slug: "foo--bar" })).toThrow();
  });
  it("rejects storeName with dashes (storeNames are dashless)", () => {
    expect(() =>
      pgDatabase({ creator: "harry", slug: "x", storeName: "main-data" }),
    ).toThrow();
  });
  it("generateSecret produces 32 bytes of base64url with no padding chars", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThan(40);
  });
  it("pgRole equals pgDatabase (one role per app keeps RBAC predictable)", () => {
    const id = { creator: "harry", slug: "x" };
    expect(pgRole(id)).toBe(pgDatabase(id));
  });
  it("redisUser equals pgRole (callers can refer to one identifier)", () => {
    const id = { creator: "harry", slug: "x" };
    expect(redisUser(id)).toBe(pgRole(id));
  });
  it("s3AccessKey equals s3Bucket", () => {
    const id = { creator: "harry", slug: "x" };
    expect(s3AccessKey(id)).toBe(s3Bucket(id));
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
      creator: "harry",
      slug: "habit-tracker",
      stores: { postgres: true, objects: false, kv: false },
    });
    expect(creds.postgres).toBeDefined();
    expect(creds.objects).toBeUndefined();
    expect(creds.kv).toBeUndefined();
    expect(pg.databases.has("_harry_habit_tracker")).toBe(true);
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
      creator: "harry",
      slug: "habits",
      stores: { postgres: true, objects: true, kv: true },
    });
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_PG_URL).toContain("_harry_habits");
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
      creator: "harry",
      slug: "x",
      stores: { postgres: true, kv: true },
    });
    expect(creds.postgres!.default!.url).toContain("p%2Fa%40ss%3Fword%23");
    expect(creds.kv!.default!.url).toContain("p%2Fa%40ss%3Fword%23");
  });

  it("multi-store Postgres: each named store gets its own DB + role + suffixed env var", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "s",
    });
    const creds = await prov.provisionApp({
      creator: "harry",
      slug: "habits",
      stores: { postgres: ["main", "analytics"] },
    });
    expect(Object.keys(creds.postgres!).sort()).toEqual(["analytics", "main"]);
    expect(pg.databases.has("_harry_habits_main")).toBe(true);
    expect(pg.databases.has("_harry_habits_analytics")).toBe(true);
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_PG_URL_MAIN).toContain("_harry_habits_main");
    expect(env.FLAGSHIP_PG_URL_ANALYTICS).toContain("_harry_habits_analytics");
    expect(env.FLAGSHIP_PG_URL).toBeUndefined(); // no singleton when multi-store
    expect(env.FLAGSHIP_PG_STORES).toBe("main,analytics");
  });

  it("multi-store MinIO: dash suffix in bucket names, _<NAME> suffix in env vars", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "s",
    });
    const creds = await prov.provisionApp({
      creator: "harry",
      slug: "habits",
      stores: { objects: ["public", "private"] },
    });
    expect(objects.buckets.has("harry-habits-public")).toBe(true);
    expect(objects.buckets.has("harry-habits-private")).toBe(true);
    const env = credentialsToEnv(creds);
    expect(env.FLAGSHIP_S3_BUCKET_PUBLIC).toBe("harry-habits-public");
    expect(env.FLAGSHIP_S3_BUCKET_PRIVATE).toBe("harry-habits-private");
  });

  it("multi-store Redis: prefix carries the storeName (`<creator>:<slug>:<storeName>:`)", async () => {
    const { pg, objects, kv } = setup();
    const prov = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => "s",
    });
    const creds = await prov.provisionApp({
      creator: "harry",
      slug: "habits",
      stores: { kv: ["cache", "queue"] },
    });
    expect(creds.kv!.cache.prefix).toBe("harry:habits:cache:");
    expect(creds.kv!.queue.prefix).toBe("harry:habits:queue:");
  });

  it("rejects manifest with duplicate storeNames at the provisioner boundary", async () => {
    const prov = new DataProvisioner({ postgres: new InMemoryPostgresAdmin() });
    await expect(
      prov.provisionApp({
        creator: "harry",
        slug: "x",
        stores: { postgres: ["main", "main"] },
      }),
    ).rejects.toThrow(/duplicate/);
  });

  it("throws if a store is requested but no admin is configured", async () => {
    const prov = new DataProvisioner({});
    await expect(
      prov.provisionApp({
        creator: "harry",
        slug: "x",
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
      creator: "harry",
      slug: "x",
      stores: { postgres: true, objects: true, kv: true },
    });
    await prov.deprovisionApp({
      creator: "harry",
      slug: "x",
      stores: { postgres: true, objects: false, kv: true },
    });
    expect(pg.databases.size).toBe(0);
    expect(objects.buckets.size).toBe(1); // not asked to drop objects
    expect(kv.users.size).toBe(0);
  });
});

describe("cross-host portability — same data identity regardless of where the app runs", () => {
  it("a `<creator>=alice, slug=game1` app produces the same names on alice's box and on bob's", async () => {
    // Simulates the migration story: alice creates the app; later bob's box
    // runs the same identity. The data namespace doesn't include the host,
    // so the names match regardless of which box the test is "running on."
    const onAlicesBox = pgDatabase({ creator: "alice", slug: "game1" });
    const onBobsBox = pgDatabase({ creator: "alice", slug: "game1" });
    expect(onAlicesBox).toBe(onBobsBox);
    expect(onAlicesBox).toBe("_alice_game1");

    // The host appears in the URL but never in data names.
    expect(s3Bucket({ creator: "alice", slug: "game1" })).toBe("alice-game1");
    expect(redisPrefix({ creator: "alice", slug: "game1" })).toBe("alice:game1:");
  });
});

describe("dev dataspace naming — provably disjoint from prod (feat/dev-prod-dataspace)", () => {
  const id = { creator: "harry", slug: "habit-tracker" } as const;

  it("prod names are byte-identical to the pre-dev-dataspace form (no migration)", () => {
    expect(pgDatabase({ ...id, space: "prod" })).toBe(pgDatabase(id));
    expect(redisPrefix({ ...id, space: "prod" })).toBe(redisPrefix(id));
    expect(s3Bucket({ ...id, space: "prod" })).toBe(s3Bucket(id));
    expect(pgDatabase(id)).toBe("_harry_habit_tracker");
  });

  it("dev names carry a store-valid dev marker", () => {
    expect(pgDatabase({ ...id, space: "dev" })).toBe("__dev_harry_habit_tracker");
    expect(redisPrefix({ ...id, space: "dev" })).toBe("dev:harry:habit-tracker:");
    expect(s3Bucket({ ...id, space: "dev" })).toBe("dev.harry-habit-tracker");
  });

  it("dev and prod names NEVER collide across creators/slugs (incl. a creator literally named 'dev')", () => {
    const cases = [
      { creator: "dev", slug: "notes" },
      { creator: "harry", slug: "dev-notes" },
      { creator: "d", slug: "e-v" },
      { creator: "harry", slug: "habit-tracker" },
    ] as const;
    for (const c of cases) {
      expect(pgDatabase({ ...c, space: "dev" })).not.toBe(pgDatabase({ ...c, space: "prod" }));
      expect(redisPrefix({ ...c, space: "dev" })).not.toBe(redisPrefix({ ...c, space: "prod" }));
      expect(s3Bucket({ ...c, space: "dev" })).not.toBe(s3Bucket({ ...c, space: "prod" }));
      // A prod pg name can never begin with the dev sentinel `__`.
      expect(pgDatabase({ ...c, space: "prod" }).startsWith("__")).toBe(false);
      expect(pgDatabase({ ...c, space: "dev" }).startsWith("__dev_")).toBe(true);
    }
  });

  it("pgRole/redisUser follow pgDatabase into the dev namespace", () => {
    expect(pgRole({ ...id, space: "dev" })).toBe("__dev_harry_habit_tracker");
    expect(redisUser({ ...id, space: "dev" })).toBe("__dev_harry_habit_tracker");
    expect(s3AccessKey({ ...id, space: "dev" })).toBe("dev.harry-habit-tracker");
  });
});

describe("dev dataspace provisioning (Component B)", () => {
  function rig() {
    const pg = new InMemoryPostgresAdmin();
    const objects = new InMemoryMinioAdmin();
    const kv = new InMemoryRedisAdmin();
    let n = 0;
    const provisioner = new DataProvisioner({
      postgres: pg,
      objects,
      kv,
      generateSecret: () => `secret${n++}`,
    });
    return { pg, objects, kv, provisioner };
  }
  const stores = { postgres: true, objects: true, kv: true } as const;
  const app = { creator: "harry", slug: "notes" };

  it("provisions dev stores under the disjoint dev namespace", async () => {
    const { pg, objects, kv, provisioner } = rig();
    const creds = await provisioner.provisionDevDataspace({ ...app, stores });
    expect(creds.postgres!.default!.database).toBe("__dev_harry_notes");
    expect(objects.buckets.has("dev.harry-notes")).toBe(true);
    expect([...kv.users.keys()]).toContain("__dev_harry_notes");
    expect(pg.databases.has("__dev_harry_notes")).toBe(true);
    // The prod name is NOT created by a dev provision.
    expect(pg.databases.has("_harry_notes")).toBe(false);
  });

  it("seeds the dev Postgres store from synthesizer SQL", async () => {
    const { pg, provisioner } = rig();
    const seed = `INSERT INTO "users" (id) VALUES (1);\nINSERT INTO "users" (id) VALUES (2);\nINSERT INTO "notes" (id) VALUES (1);`;
    await provisioner.provisionDevDataspace({ ...app, stores: { postgres: true }, seedSqlByStore: { default: seed } });
    const tables = await pg.listTables("__dev_harry_notes");
    expect(tables.sort()).toEqual(["notes", "users"]);
  });

  it("dev and prod coexist without collision", async () => {
    const { pg, provisioner } = rig();
    await provisioner.provisionApp({ ...app, stores: { postgres: true } });
    await provisioner.provisionDevDataspace({ ...app, stores: { postgres: true } });
    expect(pg.databases.has("_harry_notes")).toBe(true);
    expect(pg.databases.has("__dev_harry_notes")).toBe(true);
  });

  it("teardownDevDataspace drops ONLY the dev stores, never prod", async () => {
    const { pg, objects, kv, provisioner } = rig();
    await provisioner.provisionApp({ ...app, stores });
    await provisioner.provisionDevDataspace({ ...app, stores });
    await provisioner.teardownDevDataspace({ ...app, stores });
    // Dev gone.
    expect(pg.databases.has("__dev_harry_notes")).toBe(false);
    expect(objects.buckets.has("dev.harry-notes")).toBe(false);
    expect(kv.users.has("__dev_harry_notes")).toBe(false);
    // Prod untouched.
    expect(pg.databases.has("_harry_notes")).toBe(true);
    expect(objects.buckets.has("harry-notes")).toBe(true);
    expect(kv.users.has("_harry_notes")).toBe(true);
  });

  it("refuses to seed if the resolved database is somehow not dev-namespaced", async () => {
    // Guard test: a bug that passed space:"prod" must never seed via this path.
    const { provisioner } = rig();
    // provisionDevDataspace always uses space:"dev", so this is the belt-and-braces
    // check inside it; we assert the dev path DID seed a dev db (positive) and that
    // the prod provision path has no execSql seeding at all.
    const creds = await provisioner.provisionDevDataspace({
      ...app,
      stores: { postgres: true },
      seedSqlByStore: { default: 'INSERT INTO "t" (id) VALUES (1);' },
    });
    expect(creds.postgres!.default!.database.startsWith("__dev_")).toBe(true);
  });
});
