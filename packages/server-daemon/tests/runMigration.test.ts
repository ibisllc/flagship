/**
 * Tests for the runMigration dispatcher. We exercise:
 *   - .sql is routed through runSqlOverride with the app's PG URL.
 *   - .ts is routed through runScriptOverride with FLAGSHIP_* env injected.
 *   - .js is routed through runScriptOverride with cmd = "node".
 *   - Unknown extensions are skipped (success).
 *   - Missing PG store on a .sql migration throws a clear error.
 *   - FLAGSHIP_* are scrubbed from the parent env before re-injection.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunMigration } from "../src/runMigration.js";
import type { InstalledApp } from "../src/appPlatform.js";
import type { AppDataCredentials } from "../src/dataLayer/index.js";

function fakeApp(args: { data?: AppDataCredentials | null }): InstalledApp {
  return {
    creator: "alice",
    slug: "x",
    appId: "alice-x",
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
      appByAppId: () => fakeApp({ data: PG_CREDS }),
      runSqlOverride: async (a) => {
        seen.push(a);
      },
    });
    await run({ appId: "alice-x", absPath: sqlPath, filename: "0001_init.sql" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("CREATE TABLE");
    expect(seen[0]?.pgUrl).toBe(PG_CREDS.postgres!.default!.url);
  });

  it("throws when the app has no postgres store", async () => {
    const sqlPath = join(tmp, "0001_init.sql");
    await writeFile(sqlPath, "SELECT 1;");
    const run = buildRunMigration({
      appByAppId: () => fakeApp({ data: null }),
    });
    await expect(
      run({ appId: "alice-x", absPath: sqlPath, filename: "0001_init.sql" }),
    ).rejects.toThrow(/has no postgres store/);
  });

  it("throws when the app is unknown", async () => {
    const sqlPath = join(tmp, "0001_init.sql");
    await writeFile(sqlPath, "SELECT 1;");
    const run = buildRunMigration({
      appByAppId: () => null,
    });
    await expect(
      run({ appId: "alice-x", absPath: sqlPath, filename: "0001_init.sql" }),
    ).rejects.toThrow(/unknown appId/);
  });
});

describe("buildRunMigration — .ts/.js dispatch", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flagship-rm-"));
  });

  it("routes .ts through runScriptOverride with cmd=tsx", async () => {
    const tsPath = join(tmp, "0001_seed.ts");
    await writeFile(tsPath, "console.log('seeded')");

    const seen: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
    const run = buildRunMigration({
      appByAppId: () => fakeApp({ data: PG_CREDS }),
      runScriptOverride: async (a) => {
        seen.push(a);
      },
    });
    await run({ appId: "alice-x", absPath: tsPath, filename: "0001_seed.ts" });
    expect(seen[0]?.cmd).toBe("tsx");
    expect(seen[0]?.args).toEqual([tsPath]);
    expect(seen[0]?.env.FLAGSHIP_APP_ID).toBe("alice-x");
    expect(seen[0]?.env.FLAGSHIP_CREATOR).toBe("alice");
    expect(seen[0]?.env.FLAGSHIP_PG_URL).toBe(PG_CREDS.postgres!.default!.url);
    expect(seen[0]?.env.FLAGSHIP_MIGRATION_FILE).toBe("0001_seed.ts");
  });

  it("routes .js through runScriptOverride with cmd=node", async () => {
    const jsPath = join(tmp, "0001_seed.js");
    await writeFile(jsPath, "console.log('seeded')");

    const seen: { cmd: string }[] = [];
    const run = buildRunMigration({
      appByAppId: () => fakeApp({ data: null }),
      runScriptOverride: async (a) => {
        seen.push(a);
      },
    });
    await run({ appId: "alice-x", absPath: jsPath, filename: "0001_seed.js" });
    expect(seen[0]?.cmd).toBe("node");
  });

  it("scrubs FLAGSHIP_* from parent env before reinjecting the app's", async () => {
    process.env.FLAGSHIP_LEAKED = "should-not-pass";
    const tsPath = join(tmp, "0001_seed.ts");
    await writeFile(tsPath, "");

    const seen: { env: Record<string, string> }[] = [];
    const run = buildRunMigration({
      appByAppId: () => fakeApp({ data: null }),
      runScriptOverride: async (a) => {
        seen.push(a);
      },
    });
    await run({ appId: "alice-x", absPath: tsPath, filename: "0001_seed.ts" });
    expect(seen[0]?.env.FLAGSHIP_LEAKED).toBeUndefined();
    delete process.env.FLAGSHIP_LEAKED;
  });
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
    let scriptCalled = false;
    const run = buildRunMigration({
      appByAppId: () => fakeApp({ data: null }),
      runSqlOverride: async () => {
        sqlCalled = true;
      },
      runScriptOverride: async () => {
        scriptCalled = true;
      },
    });
    await run({ appId: "alice-x", absPath: readmePath, filename: "0001_README.md" });
    expect(sqlCalled).toBe(false);
    expect(scriptCalled).toBe(false);
  });
});
