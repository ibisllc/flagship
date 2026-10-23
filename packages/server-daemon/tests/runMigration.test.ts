/**
 * Tests for the runMigration dispatcher. We exercise:
 *   - .sql is routed through runSqlOverride with the app's PG URL.
 *   - .ts/.js (any script extension) are refused and never executed.
 *   - Unknown extensions are skipped (success).
 *   - Missing PG store on a .sql migration throws a clear error.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunMigration } from "../src/runMigration.js";
import type { InstalledService } from "../src/servicePlatform.js";
import type { AppDataCredentials } from "../src/dataLayer/index.js";

function fakeApp(args: { data?: AppDataCredentials | null }): InstalledService {
  return {
    creator: "alice",
    slug: "x",
    serviceId: "alice-x",
    manifest: {
      schema_version: 1,
      name: "x",
      version: "0.1.0",
      runtime: { image: "x", port: 80 },
      data: {},
      network: { subdomain: "x" },
      access: { enabled: true, default_role: "viewer" },
      migration: { verification: "standard" },
    },
    urlLabel: "x",
    membership: {} as never,
    containerPort: 8080,
    data: args.data ?? null,
    installedAt: 0,
  };
}

const PG_CREDS: AppDataCredentials = {
  creator: "alice",
  slug: "x",
  postgresSingleton: true,
  postgres: {
    default: {
      url: "postgresql://app:secret@127.0.0.1:5432/_alice_x",
      role: "_alice_x",
      database: "_alice_x",
    },
  },
};

describe("buildRunMigration — .sql dispatch", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flagship-rm-"));
  });

  it("routes .sql through runSqlOverride with the app's PG URL", async () => {
    const sqlPath = join(tmp, "0001_init.sql");
    await writeFile(sqlPath, "CREATE TABLE t(id int);");

    const seen: { sql: string; pgUrl: string }[] = [];
    const run = buildRunMigration({
      serviceByServiceId: () => fakeApp({ data: PG_CREDS }),
      runSqlOverride: async (a) => {
        seen.push(a);
      },
    });
    await run({ serviceId: "alice-x", absPath: sqlPath, filename: "0001_init.sql" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("CREATE TABLE");
    expect(seen[0]?.pgUrl).toBe(PG_CREDS.postgres!.default!.url);
  });

  it("throws when the app has no postgres store", async () => {
    const sqlPath = join(tmp, "0001_init.sql");
    await writeFile(sqlPath, "SELECT 1;");
    const run = buildRunMigration({
      serviceByServiceId: () => fakeApp({ data: null }),
    });
    await expect(
      run({ serviceId: "alice-x", absPath: sqlPath, filename: "0001_init.sql" }),
    ).rejects.toThrow(/has no postgres store/);
  });

  it("throws when the app is unknown", async () => {
    const sqlPath = join(tmp, "0001_init.sql");
    await writeFile(sqlPath, "SELECT 1;");
    const run = buildRunMigration({
      serviceByServiceId: () => null,
    });
    await expect(
      run({ serviceId: "alice-x", absPath: sqlPath, filename: "0001_init.sql" }),
    ).rejects.toThrow(/unknown serviceId/);
  });
});

describe("buildRunMigration — script migrations are refused", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flagship-rm-"));
  });

  it.each(["0001_seed.ts", "0001_seed.js", "0001_seed.mjs", "0001_seed.cts", "0001_SEED.TSX"])(
    "refuses %s without running anything",
    async (filename) => {
      const path = join(tmp, filename);
      await writeFile(path, "require('child_process').execSync('id')");
      let sqlCalled = false;
      const run = buildRunMigration({
        serviceByServiceId: () => fakeApp({ data: PG_CREDS }),
        runSqlOverride: async () => {
          sqlCalled = true;
        },
      });
      await expect(run({ serviceId: "alice-x", absPath: path, filename })).rejects.toThrow(
        /script migration/,
      );
      expect(sqlCalled).toBe(false);
    },
  );
});

describe("buildRunMigration — unknown extensions", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flagship-rm-"));
  });

  it("returns success without invoking any executor", async () => {
    const readmePath = join(tmp, "0001_README.md");
    await writeFile(readmePath, "# notes");
    let sqlCalled = false;
    const run = buildRunMigration({
      serviceByServiceId: () => fakeApp({ data: null }),
      runSqlOverride: async () => {
        sqlCalled = true;
      },
    });
    await run({ serviceId: "alice-x", absPath: readmePath, filename: "0001_README.md" });
    expect(sqlCalled).toBe(false);
  });
});
