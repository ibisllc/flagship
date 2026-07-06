import { spawn } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Volume-aware backup: CONSISTENT logical dumps of the data-layer stores that
 * live as docker bind mounts under `<dataDir>/data/{postgres,minio,redis,forgejo}`
 * (installer/data-services/docker-compose.yml).
 *
 * The peer-backup walker (`dataDirWalker.ts`) is rooted at `<dataDir>/data` and
 * would otherwise DESCEND into those live bind mounts and ship a TORN copy —
 * worse than a clean miss: PGDATA mid-write is inconsistent, minio's
 * `.minio.sys` is dotfile-excluded, forgejo packfiles exceed the whole-file cap,
 * the redis AOF is mid-append. So the walker is told to EXCLUDE the raw mounts
 * and we instead write consistent LOGICAL dumps under a reserved subtree
 * (`_dumps/`) that the walker traverses normally. The dumps then ride the
 * existing transport unchanged (encrypt → shard → peers → SWK-sealed manifest);
 * `reloadDataVolumes` is the symmetric restore that loads them back into a fresh
 * box's stack before it takes traffic.
 *
 * Consistency argument, per store:
 *   - postgres — `pg_dumpall` runs each database dump inside a serialized
 *     snapshot, so the logical dump is self-consistent with CONCURRENT writers.
 *     No freeze needed.
 *   - redis — `BGSAVE` forks a point-in-time child; the resulting `dump.rdb` is
 *     a consistent snapshot taken while the server keeps serving. No freeze.
 *   - minio — `mc mirror` of live buckets is eventually-consistent: objects
 *     added mid-mirror may be missed, but every object it copies is whole. A
 *     freeze (final-flush) closes that window.
 *   - forgejo — SQLite `.backup` uses the online-backup API (consistent under
 *     concurrent writes); a checkpoint/quiesce reduces WAL churn but is not
 *     required for correctness. The repo tar is append-mostly git data.
 *
 * Everything runs through an INJECTED runner (no real box in unit tests). A
 * store whose dump FAILS is recorded in the report + logged loudly and its
 * partial output is discarded (tmp+rename) — it is NOT silently shipped, and it
 * is NOT walked (the raw mount stays excluded either way), so a failure is a
 * clean, visible miss rather than torn data.
 */

// ──────────────────────────────────────────────────────────────────────
// Injected command runner (tests never touch a real box / real docker)
// ──────────────────────────────────────────────────────────────────────

export interface VolumeDumpRunner {
  /** Run a command (argv only, no shell). Reject on non-zero exit. */
  run(cmd: string, args: string[]): Promise<void>;
  /** Run + capture stdout (e.g. `mc ls`). Reject on non-zero exit. */
  capture(cmd: string, args: string[]): Promise<{ stdout: string }>;
  /**
   * Stream a command's stdout into `outPath` (e.g. `pg_dumpall`, `tar -cf -`).
   * Writes to `<outPath>.partial` and renames on exit 0 so a FAILED dump never
   * leaves a torn file that would be shipped as if valid.
   */
  runToFile(cmd: string, args: string[], outPath: string): Promise<void>;
  /** Feed `inPath` to a command's stdin (e.g. `psql` restore). Reject on non-zero. */
  runFromFile(cmd: string, args: string[], inPath: string): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000; // dumps of a large store can be slow

export const realVolumeDumpRunner: VolumeDumpRunner = {
  run(cmd, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
      const t = armTimeout(p, reject);
      p.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      p.on("exit", (code) => {
        clearTimeout(t);
        code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`));
      });
    });
  },
  capture(cmd, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const t = armTimeout(p, reject);
      p.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      p.stdout?.on("data", (d) => (stdout += d.toString()));
      p.stderr?.on("data", (d) => (stderr += d.toString()));
      p.on("exit", (code) => {
        clearTimeout(t);
        if (code === 0) return resolve({ stdout });
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-400)}`));
      });
    });
  },
  async runToFile(cmd, args, outPath) {
    await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
    const tmp = `${outPath}.partial`;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp, { mode: 0o600 });
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      const t = armTimeout(p, reject);
      p.stderr?.on("data", (d) => (stderr += d.toString()));
      p.stdout?.pipe(out);
      p.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      p.on("exit", (code) => {
        clearTimeout(t);
        out.end(() => {
          if (code === 0) return resolve();
          reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-400)}`));
        });
      });
    }).then(
      () => rename(tmp, outPath),
      async (e) => {
        await rm(tmp, { force: true });
        throw e;
      },
    );
  },
  runFromFile(cmd, args, inPath) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ["pipe", "inherit", "pipe"] });
      let stderr = "";
      const t = armTimeout(p, reject);
      p.stderr?.on("data", (d) => (stderr += d.toString()));
      p.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      createReadStream(inPath).pipe(p.stdin!);
      p.on("exit", (code) => {
        clearTimeout(t);
        if (code === 0) return resolve();
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-400)}`));
      });
    });
  },
};

function armTimeout(
  p: ReturnType<typeof spawn>,
  reject: (e: Error) => void,
  ms = DEFAULT_TIMEOUT_MS,
): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    try {
      p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    reject(new Error(`command timed out after ${ms}ms and was killed`));
  }, ms);
  if (typeof (t as { unref?: () => void }).unref === "function") {
    (t as { unref?: () => void }).unref!();
  }
  return t;
}

// ──────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────

/** The subtree name (under `<dataDir>/data`) the consistent dumps are written to. */
export const DUMPS_SUBTREE = "_dumps";

/** Raw bind-mount directory names the walker must SKIP (dumped separately). */
export const RAW_DATA_MOUNTS = ["postgres", "minio", "redis", "forgejo", "chromium"] as const;

/** True for a raw mount dir OR anything beneath it — feed to walkDataDir.exclude. */
export function isRawDataMount(relPath: string): boolean {
  return RAW_DATA_MOUNTS.some((m) => relPath === m || relPath.startsWith(`${m}/`));
}

/** True for the `_dumps/` subtree — feed to walkDataDir.raiseCapFor. */
export function isDumpSubtree(relPath: string): boolean {
  return relPath === DUMPS_SUBTREE || relPath.startsWith(`${DUMPS_SUBTREE}/`);
}

export interface DataServicesCreds {
  postgresUser: string;
  postgresPassword: string;
  minioRootUser: string;
  minioRootPassword: string;
  redisPassword: string;
}

export interface VolumeDumpConfig {
  /** `<dataDir>/data` — the walker root. Dumps land under `<dataRoot>/_dumps`. */
  dataRoot: string;
  runner: VolumeDumpRunner;
  creds: DataServicesCreds;
  /** Container names (default = docker-compose.yml). */
  containers?: Partial<Record<"postgres" | "minio" | "redis" | "forgejo", string>>;
  /** `mc` binary + isolated config dir (mirrors RealMinioAdmin). */
  mc?: { binary?: string; alias?: string; configDir?: string; endpointUrl?: string };
  /** Restrict to a subset of stores (default: all four). */
  only?: ReadonlyArray<StoreName>;
  onLog?: (m: string) => void;
}

export type StoreName = "postgres" | "minio" | "redis" | "forgejo";
export type StoreStatus = "ok" | "error";

export interface VolumeDumpReport {
  stores: Record<StoreName, StoreStatus | "skipped">;
  errors: Array<{ store: StoreName; message: string }>;
  /** True iff every REQUESTED store dumped cleanly. */
  ok: boolean;
}

const DEFAULT_CONTAINERS = {
  postgres: "flagship-postgres",
  minio: "flagship-minio",
  redis: "flagship-redis",
  forgejo: "flagship-forgejo",
} as const;

// Inside-container paths (from the compose volume mounts).
const FORGEJO_DB_IN = "/var/lib/gitea/data/forgejo.db";
const FORGEJO_DB_BACKUP_IN = "/var/lib/gitea/data/_flagship_backup.db";
const FORGEJO_REPOS_PARENT_IN = "/var/lib/gitea/data";
const FORGEJO_REPOS_DIR = "gitea-repositories";
// Host-side paths (bind mounts), relative to `dataRoot`.
const REDIS_RDB_HOST_REL = "redis/dump.rdb";
const FORGEJO_DB_BACKUP_HOST_REL = "forgejo/data/_flagship_backup.db";

// ──────────────────────────────────────────────────────────────────────
// Dump (backup side)
// ──────────────────────────────────────────────────────────────────────

/**
 * Write consistent logical dumps of every data store under `<dataRoot>/_dumps`.
 * Best-effort PER STORE: one store's failure is recorded + logged but does not
 * abort the others (each store is independent, like `realWipeContent`'s steps).
 * A failed store leaves NO partial dump (tmp+rename / cleanup), so the backup
 * either ships a whole consistent dump or nothing for that store — never torn.
 */
export async function dumpDataVolumes(cfg: VolumeDumpConfig): Promise<VolumeDumpReport> {
  const log = cfg.onLog ?? (() => {});
  const only = cfg.only ?? (["postgres", "minio", "redis", "forgejo"] as const);
  const report: VolumeDumpReport = {
    stores: { postgres: "skipped", minio: "skipped", redis: "skipped", forgejo: "skipped" },
    errors: [],
    ok: true,
  };
  const outBase = join(cfg.dataRoot, DUMPS_SUBTREE);

  const runStore = async (name: StoreName, fn: () => Promise<void>): Promise<void> => {
    if (!only.includes(name)) return;
    try {
      await fn();
      report.stores[name] = "ok";
      log(`[volume-dump] ${name}: dumped`);
    } catch (e) {
      report.stores[name] = "error";
      report.ok = false;
      const message = (e as Error).message ?? String(e);
      report.errors.push({ store: name, message });
      log(`[volume-dump] ${name}: FAILED (store SKIPPED this round, not torn): ${message}`);
    }
  };

  await runStore("postgres", () => dumpPostgres(cfg, join(outBase, "postgres", "all.dump")));
  await runStore("redis", () => dumpRedis(cfg, join(outBase, "redis", "dump.rdb")));
  await runStore("minio", () => dumpMinio(cfg, join(outBase, "minio")));
  await runStore("forgejo", () => dumpForgejo(cfg, join(outBase, "forgejo")));

  return report;
}

function containerName(cfg: VolumeDumpConfig, key: keyof typeof DEFAULT_CONTAINERS): string {
  return cfg.containers?.[key] ?? DEFAULT_CONTAINERS[key];
}

async function dumpPostgres(cfg: VolumeDumpConfig, outPath: string): Promise<void> {
  // `pg_dumpall` = cluster-wide (all roles + all databases). Each per-DB dump
  // runs in a serialized snapshot ⇒ consistent under concurrent writes. Password
  // passed via `-e PGPASSWORD` (loopback-only box; mirrors RealMinioAdmin's
  // argv-passed root secret).
  await cfg.runner.runToFile(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${cfg.creds.postgresPassword}`,
      containerName(cfg, "postgres"),
      "pg_dumpall",
      "-U",
      cfg.creds.postgresUser,
      "-h",
      "127.0.0.1",
      "--clean",
      "--if-exists",
    ],
    outPath,
  );
}

async function dumpRedis(cfg: VolumeDumpConfig, outPath: string): Promise<void> {
  const c = containerName(cfg, "redis");
  const auth = ["-a", cfg.creds.redisPassword, "--no-auth-warning"];
  // Snapshot: capture the pre-BGSAVE LASTSAVE, trigger BGSAVE, poll until
  // LASTSAVE advances (fork completed) — then the on-disk dump.rdb is a
  // consistent point-in-time image. Bounded so a stuck fork can't hang forever.
  const lastSave = async (): Promise<string> =>
    (await cfg.runner.capture("docker", ["exec", c, "redis-cli", ...auth, "LASTSAVE"])).stdout.trim();
  const before = await lastSave();
  await cfg.runner.run("docker", ["exec", c, "redis-cli", ...auth, "BGSAVE"]);
  const deadline = Date.now() + 120_000;
  for (;;) {
    if ((await lastSave()) !== before) break;
    if (Date.now() > deadline) throw new Error("BGSAVE did not complete within 120s");
    await delay(500);
  }
  // The rdb is written to the redis bind mount on the host — copy it out.
  await copyHostFile(join(cfg.dataRoot, REDIS_RDB_HOST_REL), outPath);
}

async function dumpMinio(cfg: VolumeDumpConfig, outDir: string): Promise<void> {
  const mcBin = cfg.mc?.binary ?? "mc";
  const alias = cfg.mc?.alias ?? "flagship";
  const endpoint = cfg.mc?.endpointUrl ?? "http://127.0.0.1:9000";
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const mc = (args: string[]) =>
    cfg.runner.run(mcBin, cfg.mc?.configDir ? ["--config-dir", cfg.mc.configDir, ...args] : args);
  // Idempotent alias registration (mirrors RealMinioAdmin.ensureAlias).
  await mc(["alias", "set", alias, endpoint, cfg.creds.minioRootUser, cfg.creds.minioRootPassword]);
  // Mirror EVERY bucket's objects into `_dumps/minio/<bucket>/…`. `--overwrite`
  // keeps re-dumps idempotent; `--remove` prunes objects deleted since the last
  // dump so the mirror tracks the live store.
  await mc(["mirror", "--overwrite", "--remove", `${alias}/`, outDir]);
}

async function dumpForgejo(cfg: VolumeDumpConfig, outDir: string): Promise<void> {
  const c = containerName(cfg, "forgejo");
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  // SQLite online `.backup` — consistent snapshot even with concurrent writers
  // (uses the backup API, not a raw file copy that could tear across the WAL).
  await cfg.runner.run("docker", [
    "exec",
    c,
    "sqlite3",
    FORGEJO_DB_IN,
    `.backup '${FORGEJO_DB_BACKUP_IN}'`,
  ]);
  // The `.backup` target sits on the forgejo bind mount ⇒ readable on the host.
  await copyHostFile(join(cfg.dataRoot, FORGEJO_DB_BACKUP_HOST_REL), join(outDir, "forgejo.db"));
  // Best-effort cleanup of the in-container temp copy.
  await cfg.runner
    .run("docker", ["exec", c, "rm", "-f", FORGEJO_DB_BACKUP_IN])
    .catch(() => {});
  // Repos: a tar of the bare-repo tree (git data is append-mostly; a live tar is
  // recoverable). Streamed straight to disk so multi-GB repos never buffer.
  await cfg.runner.runToFile(
    "docker",
    ["exec", c, "tar", "-cf", "-", "-C", FORGEJO_REPOS_PARENT_IN, FORGEJO_REPOS_DIR],
    join(outDir, "repos.tar"),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Reload (restore side — the AppDataImporter twin of the exporter)
// ──────────────────────────────────────────────────────────────────────

export interface VolumeReloadConfig extends VolumeDumpConfig {
  /**
   * Compose file + env used to stop/start a single service (redis is
   * stop→drop-rdb→start). Defaults mirror installer/data-services.
   */
  compose?: { file?: string; envFile?: string };
}

export interface VolumeReloadReport {
  stores: Record<StoreName, StoreStatus | "absent">;
  errors: Array<{ store: StoreName; message: string }>;
  ok: boolean;
}

const DEFAULT_COMPOSE_FILE = "/opt/flagship/installer/data-services/docker-compose.yml";
const DEFAULT_COMPOSE_ENV = "/var/flagship/data-services.env";

/**
 * Load the consistent dumps produced by `dumpDataVolumes` back into a FRESH
 * box's already-initdb'd data stack, before it takes traffic. Symmetric to the
 * dump: each store's dump under `<dataRoot>/_dumps` is applied with the inverse
 * command. Idempotent (re-applying a logical dump converges) + best-effort per
 * store; a MISSING dump for a store is "absent" (not an error — that store just
 * had nothing backed up). Wired into the migration take-over path.
 */
export async function reloadDataVolumes(cfg: VolumeReloadConfig): Promise<VolumeReloadReport> {
  const log = cfg.onLog ?? (() => {});
  const only = cfg.only ?? (["postgres", "minio", "redis", "forgejo"] as const);
  const report: VolumeReloadReport = {
    stores: { postgres: "absent", minio: "absent", redis: "absent", forgejo: "absent" },
    errors: [],
    ok: true,
  };
  const base = join(cfg.dataRoot, DUMPS_SUBTREE);

  const runStore = async (name: StoreName, dumpPath: string, fn: () => Promise<void>): Promise<void> => {
    if (!only.includes(name)) return;
    if (!(await exists(dumpPath))) {
      log(`[volume-reload] ${name}: no dump present, skipping`);
      return;
    }
    try {
      await fn();
      report.stores[name] = "ok";
      log(`[volume-reload] ${name}: reloaded`);
    } catch (e) {
      report.stores[name] = "error";
      report.ok = false;
      const message = (e as Error).message ?? String(e);
      report.errors.push({ store: name, message });
      log(`[volume-reload] ${name}: FAILED: ${message}`);
    }
  };

  await runStore("postgres", join(base, "postgres", "all.dump"), () =>
    reloadPostgres(cfg, join(base, "postgres", "all.dump")),
  );
  await runStore("minio", join(base, "minio"), () => reloadMinio(cfg, join(base, "minio")));
  await runStore("redis", join(base, "redis", "dump.rdb"), () =>
    reloadRedis(cfg, join(base, "redis", "dump.rdb")),
  );
  await runStore("forgejo", join(base, "forgejo", "forgejo.db"), () =>
    reloadForgejo(cfg, join(base, "forgejo")),
  );

  return report;
}

async function reloadPostgres(cfg: VolumeReloadConfig, dumpPath: string): Promise<void> {
  // `pg_dumpall --clean --if-exists` output DROPs then re-CREATEs every role +
  // database, so `psql < all.dump` is idempotent against a live cluster.
  await cfg.runner.runFromFile(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `PGPASSWORD=${cfg.creds.postgresPassword}`,
      containerName(cfg, "postgres"),
      "psql",
      "-U",
      cfg.creds.postgresUser,
      "-h",
      "127.0.0.1",
      "-d",
      "postgres",
    ],
    dumpPath,
  );
}

async function reloadMinio(cfg: VolumeReloadConfig, inDir: string): Promise<void> {
  const mcBin = cfg.mc?.binary ?? "mc";
  const alias = cfg.mc?.alias ?? "flagship";
  const endpoint = cfg.mc?.endpointUrl ?? "http://127.0.0.1:9000";
  const mc = (args: string[]) =>
    cfg.runner.run(mcBin, cfg.mc?.configDir ? ["--config-dir", cfg.mc.configDir, ...args] : args);
  await mc(["alias", "set", alias, endpoint, cfg.creds.minioRootUser, cfg.creds.minioRootPassword]);
  // Reverse mirror: local dump tree → live minio. `--overwrite` makes it
  // idempotent; buckets are auto-created by mc mirror.
  await mc(["mirror", "--overwrite", inDir, `${alias}/`]);
}

async function reloadRedis(cfg: VolumeReloadConfig, rdbPath: string): Promise<void> {
  // Redis loads dump.rdb only at startup ⇒ stop → drop the rdb into the bind
  // mount → start. Compose stop/start is used so the container keeps its config.
  const file = cfg.compose?.file ?? DEFAULT_COMPOSE_FILE;
  const envFile = cfg.compose?.envFile ?? DEFAULT_COMPOSE_ENV;
  const compose = (args: string[]) =>
    cfg.runner.run("docker", ["compose", "-f", file, "--env-file", envFile, ...args]);
  await compose(["stop", "redis"]);
  await copyHostFile(rdbPath, join(cfg.dataRoot, REDIS_RDB_HOST_REL));
  await compose(["start", "redis"]);
}

async function reloadForgejo(cfg: VolumeReloadConfig, inDir: string): Promise<void> {
  // Restore the SQLite DB into the bind mount while forgejo is stopped, then
  // untar the repos back over the repo tree, then start it again.
  const file = cfg.compose?.file ?? DEFAULT_COMPOSE_FILE;
  const envFile = cfg.compose?.envFile ?? DEFAULT_COMPOSE_ENV;
  const c = containerName(cfg, "forgejo");
  const compose = (args: string[]) =>
    cfg.runner.run("docker", ["compose", "-f", file, "--env-file", envFile, ...args]);
  await compose(["stop", "forgejo"]);
  await copyHostFile(join(inDir, "forgejo.db"), join(cfg.dataRoot, "forgejo", "data", "forgejo.db"));
  const reposTar = join(inDir, "repos.tar");
  if (await exists(reposTar)) {
    // Untar into the repos parent on the host bind mount.
    await cfg.runner.runFromFile(
      "tar",
      ["-xf", "-", "-C", join(cfg.dataRoot, "forgejo", "data")],
      reposTar,
    );
  }
  await compose(["start", "forgejo"]);
}

// ──────────────────────────────────────────────────────────────────────
// data-services.env → creds
// ──────────────────────────────────────────────────────────────────────

/**
 * Read the compose-written admin credentials. Returns null (data layer absent /
 * incomplete) rather than throwing, mirroring the runtime's graceful-degrade.
 */
export async function loadDataServicesCreds(envFile: string): Promise<DataServicesCreds | null> {
  let text: string;
  try {
    text = await readFile(envFile, "utf8");
  } catch {
    return null;
  }
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  const {
    POSTGRES_ADMIN_USER,
    POSTGRES_ADMIN_PASSWORD,
    MINIO_ROOT_USER,
    MINIO_ROOT_PASSWORD,
    REDIS_ADMIN_PASSWORD,
  } = env;
  if (
    !POSTGRES_ADMIN_USER ||
    !POSTGRES_ADMIN_PASSWORD ||
    !MINIO_ROOT_USER ||
    !MINIO_ROOT_PASSWORD ||
    !REDIS_ADMIN_PASSWORD
  ) {
    return null;
  }
  return {
    postgresUser: POSTGRES_ADMIN_USER,
    postgresPassword: POSTGRES_ADMIN_PASSWORD,
    minioRootUser: MINIO_ROOT_USER,
    minioRootPassword: MINIO_ROOT_PASSWORD,
    redisPassword: REDIS_ADMIN_PASSWORD,
  };
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

async function copyHostFile(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.partial`;
  await copyFile(src, tmp);
  await rename(tmp, dest);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
