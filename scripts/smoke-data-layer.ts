/**
 * Targeted integration smoke for the unified data-layer admin clients.
 * Run this on a box where `installer/data-services/init.sh` has
 * brought up the compose stack and the secrets file is readable.
 *
 *   npx tsx scripts/smoke-data-layer.ts
 *
 * What it does:
 *   1. Reads `/var/flagship/data-services.env` (or
 *      $FLAGSHIP_DATA_SERVICES_ENV) for admin credentials and DATA_NAME_KEY.
 *   2. Provisions a temporary `(creator, slug) = (smoke, datalayer)`
 *      tenant via `DataProvisioner` against the real Postgres in the
 *      compose and a real files volume.
 *   3. Verifies the per-app role can connect, uses every extension, writes
 *      and reads a row, checks the files volume exists, then deprovisions.
 *
 * Outputs a one-line OK / FAIL per store. Does not leave residue.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Client as PgClient } from "pg";
import {
  APP_PG_EXTENSIONS,
  DataProvisioner,
  RealFilesAdmin,
  RealPostgresAdmin,
} from "../packages/server-daemon/src/dataLayer/index.js";

const execFileP = promisify(execFile);

const ENV_PATH =
  process.env.FLAGSHIP_DATA_SERVICES_ENV ?? "/var/flagship/data-services.env";

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx < 0) continue;
    out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}

async function main(): Promise<void> {
  let env: Record<string, string>;
  try {
    env = parseEnvFile(readFileSync(ENV_PATH, "utf8"));
  } catch (e) {
    console.error(`[smoke] cannot read ${ENV_PATH}: ${(e as Error).message}`);
    console.error(`[smoke] make sure installer/data-services/init.sh has run`);
    process.exit(1);
  }
  for (const k of ["POSTGRES_ADMIN_USER", "POSTGRES_ADMIN_PASSWORD", "DATA_NAME_KEY"]) {
    if (!env[k]) {
      console.error(`[smoke] env file missing ${k}`);
      process.exit(1);
    }
  }

  const provisioner = new DataProvisioner({
    postgres: new RealPostgresAdmin({
      adminUrl: `postgresql://${env.POSTGRES_ADMIN_USER}:${encodeURIComponent(env.POSTGRES_ADMIN_PASSWORD!)}@127.0.0.1:5432/postgres`,
    }),
    files: new RealFilesAdmin({
      run: async (cmd, args) => {
        await execFileP(cmd, args);
      },
      capture: async (cmd, args) => {
        const { stdout, stderr } = await execFileP(cmd, args);
        return { stdout, stderr };
      },
    }),
    nameKey: env.DATA_NAME_KEY!,
  });

  const tenant = { creator: "smoke", slug: "datalayer" };
  const stores = { postgres: true, files: true } as const;
  console.log(`[smoke] provisioning tenant ${tenant.creator}-${tenant.slug}`);

  const creds = await provisioner.provisionApp({ ...tenant, stores });

  let pgOk = false;
  let filesOk = false;
  try {
    const pgInst = creds.postgres!.default!;
    const pg = new PgClient({ connectionString: pgInst.url });
    await pg.connect();
    try {
      const ext = await pg.query<{ extname: string }>("SELECT extname FROM pg_extension");
      const have = new Set(ext.rows.map((r) => r.extname));
      const missing = APP_PG_EXTENSIONS.filter((e) => !have.has(e));
      if (missing.length > 0) console.log(`[smoke] missing extensions: ${missing.join(", ")}`);
      await pg.query("CREATE TABLE smoke (k TEXT PRIMARY KEY, v TEXT, e vector(3))");
      await pg.query("INSERT INTO smoke VALUES ('hello', 'world', '[1,2,3]')");
      const r = await pg.query<{ v: string }>("SELECT v FROM smoke WHERE k = $1", ["hello"]);
      if (r.rows[0]?.v === "world" && missing.length === 0) pgOk = true;
    } finally {
      await pg.end();
    }

    const volume = creds.files!.volume;
    const { stdout } = await execFileP("docker", ["volume", "inspect", "-f", "{{.Name}}", volume]);
    filesOk = stdout.trim() === volume;
  } finally {
    console.log(`[smoke] deprovisioning`);
    await provisioner.dropCredentials(creds);
  }

  console.log(`[smoke] postgres: ${pgOk ? "OK" : "FAIL"}`);
  console.log(`[smoke] files:    ${filesOk ? "OK" : "FAIL"}`);
  if (!pgOk || !filesOk) process.exit(2);
  console.log(`[smoke] data-layer integration green`);
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
