/**
 * Targeted integration smoke for the unified data-layer admin clients.
 * Run this on a box where `installer/data-services/init.sh` has
 * brought up the compose stack and the secrets file is readable.
 *
 *   npx tsx scripts/smoke-data-layer.ts
 *
 * What it does:
 *   1. Reads `/var/flagship/data-services.env` (or
 *      $FLAGSHIP_DATA_SERVICES_ENV) for admin credentials.
 *   2. Provisions a temporary `(creator, slug) = (smoke, datalayer)`
 *      tenant via `DataProvisioner` against the real Postgres + Redis
 *      + MinIO running in the compose.
 *   3. Verifies the per-app role can connect, writes/reads a tiny
 *      payload to each store, then deprovisions.
 *
 * Outputs a one-line OK / FAIL per store. Does not leave residue.
 */

import { readFileSync } from "node:fs";
import { Client as PgClient } from "pg";
import { Redis } from "ioredis";
import { Client as MinioClient } from "minio";
import {
  DataProvisioner,
  RealMinioAdmin,
  RealPostgresAdmin,
  RealRedisAdmin,
} from "../packages/server-daemon/src/dataLayer/index.js";

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
  const required = [
    "POSTGRES_ADMIN_USER",
    "POSTGRES_ADMIN_PASSWORD",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "REDIS_ADMIN_PASSWORD",
  ];
  for (const k of required) {
    if (!env[k]) {
      console.error(`[smoke] env file missing ${k}`);
      process.exit(1);
    }
  }

  const provisioner = new DataProvisioner({
    postgres: new RealPostgresAdmin({
      adminUrl: `postgresql://${env.POSTGRES_ADMIN_USER}:${encodeURIComponent(env.POSTGRES_ADMIN_PASSWORD!)}@127.0.0.1:5432/postgres`,
    }),
    kv: new RealRedisAdmin({
      adminUrl: `redis://default:${encodeURIComponent(env.REDIS_ADMIN_PASSWORD!)}@127.0.0.1:6379/0`,
    }),
    objects: new RealMinioAdmin({
      endPoint: "127.0.0.1",
      port: 9000,
      rootUser: env.MINIO_ROOT_USER!,
      rootPassword: env.MINIO_ROOT_PASSWORD!,
    }),
  });

  const tenant = { creator: "smoke", slug: "datalayer" };
  console.log(`[smoke] provisioning tenant ${tenant.creator}_${tenant.slug}`);

  const creds = await provisioner.provisionApp({
    creator: tenant.creator,
    slug: tenant.slug,
    stores: { postgres: true, objects: true, kv: true },
  });

  let pgOk = false;
  let kvOk = false;
  let s3Ok = false;
  try {
    // Postgres roundtrip
    const pgInst = creds.postgres!.default!;
    const pg = new PgClient({ connectionString: pgInst.url });
    await pg.connect();
    try {
      await pg.query("CREATE TABLE smoke (k TEXT PRIMARY KEY, v TEXT)");
      await pg.query("INSERT INTO smoke VALUES ('hello', 'world')");
      const r = await pg.query<{ v: string }>("SELECT v FROM smoke WHERE k = $1", ["hello"]);
      if (r.rows[0]?.v === "world") pgOk = true;
    } finally {
      await pg.end();
    }

    // Redis roundtrip
    const kvInst = creds.kv!.default!;
    const redis = new Redis(kvInst.url, { maxRetriesPerRequest: 1 });
    try {
      await redis.set(`${kvInst.prefix}smoke`, "hello");
      const got = await redis.get(`${kvInst.prefix}smoke`);
      if (got === "hello") kvOk = true;
    } finally {
      redis.disconnect();
    }

    // MinIO roundtrip
    const s3Inst = creds.objects!.default!;
    const url = new URL(s3Inst.endpoint);
    const minio = new MinioClient({
      endPoint: url.hostname,
      port: parseInt(url.port || "9000", 10),
      useSSL: url.protocol === "https:",
      accessKey: s3Inst.accessKey,
      secretKey: s3Inst.secretKey,
    });
    await minio.putObject(s3Inst.bucket, "smoke.txt", Buffer.from("hello world"));
    const stream = await minio.getObject(s3Inst.bucket, "smoke.txt");
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    if (Buffer.concat(chunks).toString("utf8") === "hello world") s3Ok = true;
  } finally {
    console.log(`[smoke] deprovisioning`);
    await provisioner.deprovisionApp({
      creator: tenant.creator,
      slug: tenant.slug,
      stores: { postgres: true, objects: true, kv: true },
    });
  }

  console.log(`[smoke] postgres: ${pgOk ? "OK" : "FAIL"}`);
  console.log(`[smoke] redis:    ${kvOk ? "OK" : "FAIL"}`);
  console.log(`[smoke] minio:    ${s3Ok ? "OK" : "FAIL"}`);
  if (!pgOk || !kvOk || !s3Ok) process.exit(2);
  console.log(`[smoke] ✅ data-layer integration green`);
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
