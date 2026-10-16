/**
 * The database size limiter (appQuota/pgQuota.ts) against a real Postgres:
 * at the limit the app's role can read, delete and truncate but not insert,
 * update, create tables or temp tables; the box's admin is unaffected; what
 * was taken is given back exactly; a stopped role can't log in. Also the
 * whole stage machine (AppQuotaManager) end to end on a real database.
 *
 * Runs when FLAGSHIP_TEST_PG_URL names a superuser connection (CI's gate job
 * runs the box's own Postgres image as a service); skipped otherwise.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppQuotaManager, RealPgQuota, emptyRevocation } from "../src/appQuota/index.js";
import { RealPostgresAdmin } from "../src/dataLayer/realAdmins.js";

const ADMIN_URL = process.env.FLAGSHIP_TEST_PG_URL;
const MiB = 1024 * 1024;

function urlFor(role: string, password: string, db: string): string {
  const u = new URL(ADMIN_URL!);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

async function asApp<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

describe.skipIf(!ADMIN_URL)("database size limits on a real Postgres", () => {
  const admin = new RealPostgresAdmin({ adminUrl: ADMIN_URL ?? "" });
  const quota = new RealPgQuota({ adminUrl: ADMIN_URL ?? "" });
  const name = `app_${randomBytes(12).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  const appUrl = () => urlFor(name, password, name);

  beforeAll(async () => {
    await admin.createRoleAndDb({ db: name, role: name, password });
    await asApp(appUrl(), async (c) => {
      await c.query("CREATE TABLE notes (id serial PRIMARY KEY, body text)");
      await c.query("CREATE SCHEMA extra");
      await c.query("CREATE TABLE extra.blobs (b bytea)");
      await c.query("INSERT INTO notes (body) VALUES ('one'), ('two')");
    });
  });

  afterAll(async () => {
    await admin.dropRoleAndDb({ db: name, role: name }).catch(() => {});
  });

  it("measures the database", async () => {
    const sizes = await quota.sizes([name, "app_doesnotexist"]);
    expect(sizes.get(name)).toBeGreaterThan(1 * MiB);
    expect(sizes.has("app_doesnotexist")).toBe(false);
  });

  it("blocks writes but keeps reads, deletes and truncates, and gives back exactly what it took", async () => {
    const revoked = await quota.block(name, name, emptyRevocation());
    expect(revoked.tables.length).toBe(2);
    expect(revoked.temporary).toBe(true);
    expect(revoked.databaseCreate).toBe(true);
    expect(revoked.schemas.map((s) => s.name).sort()).toEqual(["extra", "public"]);
    expect(revoked.schemas.find((s) => s.name === "public")?.from).toEqual([name, "pg_database_owner"]);
    await asApp(appUrl(), async (c) => {
      await expect(c.query("INSERT INTO notes (body) VALUES ('three')")).rejects.toThrow(/permission denied/);
      await expect(c.query("UPDATE notes SET body = 'x'")).rejects.toThrow(/permission denied/);
      await expect(c.query("INSERT INTO extra.blobs VALUES ('\\x00')")).rejects.toThrow(/permission denied/);
      await expect(c.query("CREATE TABLE more (x int)")).rejects.toThrow(/permission denied/);
      await expect(c.query("CREATE TEMP TABLE t (x int)")).rejects.toThrow(/permission denied/);
      await expect(c.query("CREATE SCHEMA another")).rejects.toThrow(/permission denied/);
      expect((await c.query("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(2);
      await c.query("DELETE FROM notes WHERE body = 'two'");
      await c.query("TRUNCATE extra.blobs");
    });
    // The box's own work runs as the admin and still writes.
    await asApp(urlFor(new URL(ADMIN_URL!).username, decodeURIComponent(new URL(ADMIN_URL!).password), name), async (c) => {
      await c.query("INSERT INTO notes (body) VALUES ('by the box')");
    });
    // Blocking again (a tick while still over) is harmless and keeps the record.
    const again = await quota.block(name, name, revoked);
    expect(again.tables.length).toBe(2);
    await quota.unblock(name, name, again);
    await asApp(appUrl(), async (c) => {
      await c.query("INSERT INTO notes (body) VALUES ('three')");
      await c.query("UPDATE notes SET body = body || '!'");
      await c.query("CREATE TABLE more (x int)");
      await c.query("CREATE TEMP TABLE t (x int)");
      await c.query("DROP TABLE more");
    });
  });

  it("an app that re-grants itself is why a database can be stopped", async () => {
    const revoked = await quota.block(name, name, emptyRevocation());
    await asApp(appUrl(), async (c) => {
      // The owner can give itself the privilege back: the block alone can't hold a hostile app.
      await c.query(`GRANT INSERT ON notes TO ${name}`);
      await c.query("INSERT INTO notes (body) VALUES ('sneaky')");
    });
    await quota.setLogin(name, false);
    await expect(asApp(appUrl(), async () => {})).rejects.toThrow(/not permitted to log in/);
    await quota.setLogin(name, true);
    await quota.unblock(name, name, revoked);
    await asApp(appUrl(), async (c) => {
      await c.query("INSERT INTO notes (body) VALUES ('back')");
    });
  });

  it("ends a stopped role's open sessions", async () => {
    const c = new Client({ connectionString: appUrl() });
    await c.connect();
    c.on("error", () => {});
    await quota.setLogin(name, false);
    await expect(c.query("SELECT 1")).rejects.toThrow();
    await c.end().catch(() => {});
    await quota.setLogin(name, true);
  });

  it("counts the room deleted rows leave, after a VACUUM", async () => {
    await asApp(appUrl(), async (c) => {
      await c.query("INSERT INTO notes (body) SELECT repeat('x', 1000) FROM generate_series(1, 5000)");
      await c.query("DELETE FROM notes WHERE id % 2 = 0");
    });
    await quota.vacuum(name);
    const free = await quota.freeBytes(name);
    expect(free).toBeGreaterThan(1 * MiB);
    // freeBytes leaves its extension in a schema of the admin's; unblock removes it.
    await quota.unblock(name, name, emptyRevocation());
    const ext = await asApp(appUrl(), (c) => c.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_freespacemap'"));
    expect(ext.rows[0].n).toBe(0);
  });

  it("the manager blocks at the budget and gives writes back once it's raised", async () => {
    const size = (await quota.sizes([name])).get(name)!;
    let pgBudget = MiB;
    const m = new AppQuotaManager({
      apps: () => [{ serviceId: "alice-notes", postgres: [{ database: name, role: name }] }],
      budgets: () => new Map([["alice-notes", { totalBytes: pgBudget, filesBytes: 0, postgresBytes: pgBudget }]]),
      files: null,
      pg: () => quota,
      hostDisk: async () => ({ totalBytes: 100 * 1024 * MiB, availBytes: 50 * 1024 * MiB }),
      statePath: null,
      log: () => {},
    });
    await m.kick();
    expect(m.appView("alice-notes")?.postgres).toMatchObject({ writesBlocked: true, limitBytes: MiB });
    await asApp(appUrl(), async (c) => {
      await expect(c.query("INSERT INTO notes (body) VALUES ('blocked')")).rejects.toThrow(/permission denied/);
    });
    pgBudget = size + 100 * MiB;
    await m.kick();
    expect(m.appView("alice-notes")?.postgres?.writesBlocked).toBe(false);
    await asApp(appUrl(), async (c) => {
      await c.query("INSERT INTO notes (body) VALUES ('allowed')");
    });
  });
});
