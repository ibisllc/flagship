/**
 * The test copy with Docker (`--stage docker`, or `auto` where `docker`
 * runs): the box's own build (`writeSourceTree` + `runDockerBuild`, which
 * writes the runtime's Dockerfile and applies the Dockerfile policy), then
 * the container started hardened like an app (read-only root, /tmp tmpfs,
 * every capability dropped) and the box's own start check
 * (`buildStartCheck`). `check_app` and `get_logs` reach the real container.
 *
 * Postgres: with BUILD_EVAL_PG_URL (an admin URL; the workflow starts a
 * Postgres service) each copy gets a fresh database, the app's migrations,
 * and the box's synthetic sample rows; `query_db` and `list_tables` work.
 * Without it, an app that declares Postgres is built for real but not
 * started: the rest of its check is the static one.
 *
 * Differences from the box: no gVisor, no egress fence (the build reaches
 * the internet through docker's default network rather than the registry-only
 * build network), the app's files folder is a tmpfs, and the database role is
 * the admin's rather than an app role.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { parseManifest, type AppManifest } from "@flagship/protocol";
import {
  DEFAULT_DOCKER_BUILD_LIMITS,
  buildStartCheck,
  realCommandRunner,
  runDockerBuild,
} from "../../../../packages/server-daemon/src/serviceRunner.js";
import { writeSourceTree } from "../../../../packages/server-daemon/src/llm/serviceSource.js";
import { migrationFiles } from "../../../../packages/server-daemon/src/llm/serviceName.js";
import { datasetToSql, generateSynthetic } from "../../../../packages/server-daemon/src/dataLayer/synth/index.js";
import {
  STAGING_CREATOR,
  STAGING_HOST,
  STAGING_ROLE,
  STAGING_USER,
  filesDigest,
  type CheckAppRequest,
  type CheckAppResult,
  type StageArgs,
  type StageResult,
  type StagedCopy,
  type StagingDataResult,
  type StagingHost,
} from "../../../../packages/server-daemon/src/buildmodes/staging.js";
import { staticBuildCheck } from "./staticCheck.js";
import type { StageOutcome } from "./staticStaging.js";

const run = promisify(execFile);

/** Is a docker daemon usable here? */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

interface Copy {
  container: string;
  port: number;
  slug: string;
  database?: string;
  pgUrl?: string;
}

export interface DockerStagingOptions {
  /** Admin Postgres URL reachable from this host (BUILD_EVAL_PG_URL). */
  pgAdminUrl?: string | null;
  python?: string | null;
  onStage?: (o: StageOutcome) => void;
}

function hostPgUrl(admin: string, database: string): string {
  const u = new URL(admin);
  u.pathname = `/${database}`;
  return u.toString();
}

/** The same URL as the container sees it (the host's loopback is the docker host). */
function containerPgUrl(url: string): string {
  const u = new URL(url);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") u.hostname = "host.docker.internal";
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, statement_timeout: 10_000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

export class DockerStaging implements StagingHost {
  private readonly copies = new Map<string, Copy>();
  private readonly stagedCopies = new Map<string, StagedCopy>();
  private n = 0;

  constructor(private readonly opts: DockerStagingOptions = {}) {
    // The box's docker build flags (--memory, --cpu-quota) are the legacy builder's.
    process.env.DOCKER_BUILDKIT ??= "0";
  }

  private report(buildId: string, r: StageResult): StageResult {
    this.opts.onStage?.({ buildId, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) });
    return r;
  }

  async stage(a: StageArgs): Promise<StageResult> {
    const { buildId, files } = a;
    this.stagedCopies.delete(buildId);
    await this.teardown(buildId);
    const manifestJson = files["flagship.app.json"];
    if (!manifestJson) return this.report(buildId, { ok: false, reason: "nothing to deploy: write flagship.app.json first" });
    let manifest: AppManifest;
    try {
      const parsed = parseManifest(JSON.parse(manifestJson));
      if (!parsed.ok) return this.report(buildId, { ok: false, reason: `flagship.app.json is invalid: ${parsed.errors.join("; ")}` });
      manifest = parsed.manifest;
    } catch (e) {
      return this.report(buildId, { ok: false, reason: `flagship.app.json is not valid JSON: ${(e as Error).message}` });
    }

    const n = ++this.n;
    const image = `flagship-stg-${buildId}:${n}`;
    const contextDir = await mkdtemp(join(tmpdir(), "build-eval-docker-"));
    try {
      const w = await writeSourceTree(contextDir, files);
      if (!w.ok) return this.report(buildId, { ok: false, reason: `unsafe path in artifact files: ${w.unsafePath}` });
      try {
        await runDockerBuild(realCommandRunner, image, contextDir, { ...DEFAULT_DOCKER_BUILD_LIMITS, network: "default" });
      } catch (e) {
        return this.report(buildId, { ok: false, reason: `docker build failed: ${(e as Error).message}` });
      }
    } finally {
      await rm(contextDir, { recursive: true, force: true }).catch(() => {});
    }

    const stores = manifest.data.stores ?? {};
    const migrations = migrationFiles(files).sort((x, y) => x.filename.localeCompare(y.filename));
    if (migrations.length > 0 && !stores.postgres) {
      return this.report(buildId, { ok: false, reason: `migration ${migrations[0]!.filename} needs a Postgres store, and the manifest declares none` });
    }
    const copy: Copy = { container: `flagship-stg-${buildId}`, port: 20000 + Math.floor(Math.random() * 20000), slug: a.slug };
    const env: Record<string, string> = {
      ...Object.fromEntries((a.envNames ?? []).map((k) => [k, "staging-placeholder"])),
      ...(manifest.runtime.env ?? {}),
      FLAGSHIP_APP_ID: `staging--${a.slug}`,
      FLAGSHIP_CREATOR: STAGING_CREATOR,
      FLAGSHIP_SLUG: a.slug,
      FLAGSHIP_HOST: STAGING_HOST,
      PORT: String(manifest.runtime.port),
      TZ: "UTC",
      LANG: "C.UTF-8",
    };
    if (stores.postgres) {
      if (!this.opts.pgAdminUrl) {
        // Built for real; the start can't be tried without a database.
        const r = await staticBuildCheck(files, { python: this.opts.python ?? null });
        if (!r.ok) return this.report(buildId, { ok: false, reason: r.reason });
        this.stagedCopies.set(buildId, { image, filesDigest: filesDigest(files), slug: a.slug });
        return this.report(buildId, { ok: true, image });
      }
      const database = `bev_${createHash("sha256").update(`${buildId}|${n}`).digest("hex").slice(0, 16)}`;
      try {
        await withClient(this.opts.pgAdminUrl, (c) => c.query(`CREATE DATABASE ${database}`));
        copy.database = database;
        copy.pgUrl = hostPgUrl(this.opts.pgAdminUrl, database);
        const extensions = ["pgcrypto", "citext", "pg_trgm", "unaccent", "fuzzystrmatch", "hstore", "ltree", "btree_gin", "btree_gist", "vector"];
        await withClient(copy.pgUrl, async (c) => {
          for (const ext of extensions) await c.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`).catch(() => {});
        });
      } catch (e) {
        return this.report(buildId, { ok: false, reason: `data provisioning failed: ${(e as Error).message}` });
      }
      this.copies.set(buildId, copy);
      for (const m of migrations) {
        try {
          await withClient(copy.pgUrl!, (c) => c.query(m.sql));
        } catch (e) {
          return this.report(buildId, { ok: false, reason: `migration ${m.filename} failed: ${(e as Error).message}` });
        }
      }
      try {
        const seed = datasetToSql(
          generateSynthetic({
            sql: migrations.map((m) => m.sql).join("\n"),
            seedHex: createHash("sha256").update(`flagship/staging-seed/v1|${buildId}`).digest("hex"),
          }),
        );
        if (/\bINSERT\b/.test(seed)) await withClient(copy.pgUrl!, (c) => c.query(seed));
      } catch {
        /* empty tables */
      }
      env.FLAGSHIP_PG_URL = containerPgUrl(copy.pgUrl!);
      env.FLAGSHIP_PG_DATABASE = database;
      env.FLAGSHIP_PG_ROLE = new URL(copy.pgUrl!).username;
    }
    this.copies.set(buildId, copy);
    const user = manifest.runtime.base === "static" ? "101" : "10001";
    const args = [
      "run",
      "-d",
      "--name",
      copy.container,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "512m",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `127.0.0.1:${copy.port}:${manifest.runtime.port}`,
      ...(stores.files ? ["--tmpfs", `/data:rw,size=256m,uid=${user},gid=${user}`] : []),
      ...Object.entries({ ...env, ...(stores.files ? { FLAGSHIP_FILES_DIR: "/data" } : {}) }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      image,
    ];
    try {
      await run("docker", args, { timeout: 60_000 });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      return this.report(buildId, { ok: false, reason: `container deploy failed: ${(err.stderr || err.message).trim()}` });
    }
    const check = buildStartCheck(realCommandRunner, { containerName: () => copy.container });
    const r = await check({ serviceId: buildId, image, env, port: copy.port, containerPort: manifest.runtime.port });
    if (!r.ok) return this.report(buildId, { ok: false, reason: r.reason });
    this.stagedCopies.set(buildId, { image, filesDigest: filesDigest(files), slug: a.slug });
    return this.report(buildId, { ok: true, image });
  }

  async checkApp(buildId: string, req: CheckAppRequest): Promise<CheckAppResult> {
    const c = this.copies.get(buildId);
    if (!c) return { ok: false, reason: "nothing is running yet: call deploy first" };
    if (typeof req.path !== "string" || !req.path.startsWith("/") || /[\s\0]/.test(req.path)) {
      return { ok: false, reason: "path must start with / and contain no spaces" };
    }
    const method = (req.method ?? "GET").toUpperCase();
    const body = req.body !== undefined && method !== "GET" && method !== "HEAD" ? req.body : undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${c.port}${req.path}`, {
        method,
        headers: {
          host: STAGING_HOST,
          "x-flagship-app-id": `staging--${c.slug}`,
          "x-flagship-visitor": "member",
          "x-flagship-user": STAGING_USER,
          "x-flagship-role": STAGING_ROLE,
          "x-flagship-timestamp": String(Date.now()),
          ...(body !== undefined ? { "content-type": /^\s*[[{]/.test(body) ? "application/json" : "text/plain; charset=utf-8" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return {
        ok: true,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body: text.slice(0, 4096),
        truncated: text.length > 4096,
      };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  async logs(buildId: string): Promise<string | null> {
    const c = this.copies.get(buildId);
    if (!c) return null;
    try {
      const { stdout, stderr } = await run("docker", ["logs", "--tail", "200", c.container], { timeout: 15_000 });
      const text = [stdout, stderr].map((s) => s.trimEnd()).filter(Boolean).join("\n");
      return text.length > 16_000 ? `…${text.slice(-16_000)}` : text;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || "(no output)";
    }
  }

  async queryDb(buildId: string, req: { sql: string; store?: string }): Promise<StagingDataResult> {
    const c = this.copies.get(buildId);
    if (!c?.pgUrl) return { ok: false, reason: c ? "the app has no database (data.stores.postgres)" : "there's no test copy yet: call deploy first" };
    try {
      const r = await withClient(c.pgUrl, (cl) => cl.query(req.sql));
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      return { ok: true, text: JSON.stringify({ rows: (last?.rows ?? []).slice(0, 200), rowCount: last?.rowCount ?? 0 }) };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  async listTables(buildId: string): Promise<StagingDataResult> {
    return this.queryDb(buildId, {
      sql:
        "SELECT table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS columns " +
        "FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name ORDER BY table_name",
    });
  }

  async teardown(buildId: string): Promise<void> {
    const c = this.copies.get(buildId);
    this.copies.delete(buildId);
    if (!c) return;
    await run("docker", ["rm", "-f", c.container], { timeout: 30_000 }).catch(() => {});
    if (c.database && this.opts.pgAdminUrl) {
      await withClient(this.opts.pgAdminUrl, (cl) => cl.query(`DROP DATABASE IF EXISTS ${c.database} WITH (FORCE)`)).catch(() => {});
    }
  }

  staged(buildId: string): StagedCopy | null {
    const s = this.stagedCopies.get(buildId);
    return s ? { ...s } : null;
  }

  forget(buildId: string): void {
    const s = this.stagedCopies.get(buildId);
    this.stagedCopies.delete(buildId);
    if (s) void run("docker", ["rmi", "-f", s.image], { timeout: 30_000 }).catch(() => {});
  }
}
