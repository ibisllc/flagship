import { spawn } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isProdFilesVolume } from "./dataLayer/naming.js";
import { assertNoHostPathInDockerArgs, filesMountArgs } from "./serviceRunner.js";

/**
 * Volume-aware backup: CONSISTENT dumps of the data the box keeps for apps:
 * the Postgres and Forgejo bind mounts under `<dataDir>/data/{postgres,forgejo}`
 * (installer/data-services/docker-compose.yml) and each app's files folder
 * (a Docker named volume, `flagship-files-<creator>--<slug>`).
 *
 * The peer-backup walker (`dataDirWalker.ts`) is rooted at `<dataDir>/data` and
 * would otherwise DESCEND into the live bind mounts and ship a TORN copy —
 * worse than a clean miss: PGDATA mid-write is inconsistent and forgejo
 * packfiles exceed the whole-file cap. The files volumes live outside that
 * tree, so the walker never sees them at all. So the walker EXCLUDES the raw
 * mounts and we write consistent dumps under a reserved subtree (`_dumps/`)
 * that the walker traverses normally. The dumps then ride the existing
 * transport unchanged (encrypt → shard → peers → SWK-sealed manifest);
 * `reloadDataVolumes` is the symmetric restore that loads them back into a
 * fresh box before it takes traffic.
 *
 * Consistency argument, per store:
 *   - postgres — `pg_dumpall` runs each database dump inside a serialized
 *     snapshot, so the logical dump is self-consistent with CONCURRENT writers.
 *     No freeze needed.
 *   - files — the app's container is PAUSED (cgroup freezer) for the length
 *     of the archive, so no write lands half-way through it, then unpaused.
 *     The archive is made by a throwaway container (the data layer's own
 *     image, `tar`) with no network, every capability dropped but the one
 *     that reads any file, a read-only root, and only that volume mounted,
 *     read-only. Restore is the reverse into a FRESH volume.
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
  /** Run + capture stdout (e.g. `docker volume ls`). Reject on non-zero exit. */
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

/**
 * Raw bind-mount directory names the walker must SKIP (dumped separately).
 * `minio` and `redis` are what an older box's removed stores left behind
 * (init.sh removes them only when empty); nothing restores them, so they
 * never ride either.
 */
export const RAW_DATA_MOUNTS = ["postgres", "forgejo", "chromium", "minio", "redis"] as const;

/** True for a raw mount dir OR anything beneath it — feed to walkDataDir.exclude. */
export function isRawDataMount(relPath: string): boolean {
  return RAW_DATA_MOUNTS.some((m) => relPath === m || relPath.startsWith(`${m}/`));
}

/** True for the `_dumps/` subtree — feed to walkDataDir.raiseCapFor. */
export function isDumpSubtree(relPath: string): boolean {
  return relPath === DUMPS_SUBTREE || relPath.startsWith(`${DUMPS_SUBTREE}/`);
}

/**
 * The image the files archives run in: the data layer's Postgres image
 * (installer/data-services/docker-compose.yml; a test pins them together),
 * which is already on every box and carries GNU tar.
 */
export const FILES_HELPER_IMAGE =
  "pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c930220cb9bf2f956d10a8f909cf9973d9672ca0278aef2c1e6facccad2e0";

export interface DataServicesCreds {
  postgresUser: string;
  postgresPassword: string;
}

export interface VolumeDumpConfig {
  /** `<dataDir>/data` — the walker root. Dumps land under `<dataRoot>/_dumps`. */
  dataRoot: string;
  runner: VolumeDumpRunner;
  /** The data-services admin credentials; absent ⇒ only the files folders are dumped. */
  creds?: DataServicesCreds | null;
  /** Container names (default = docker-compose.yml). */
  containers?: Partial<Record<"postgres" | "forgejo", string>>;
  /** Image the files archives run in. Default FILES_HELPER_IMAGE. */
  helperImage?: string;
  /** Restrict to a subset of stores (default: all three, files only without creds). */
  only?: ReadonlyArray<StoreName>;
  onLog?: (m: string) => void;
}

export type StoreName = "postgres" | "files" | "forgejo";
export type StoreStatus = "ok" | "error";

export interface VolumeDumpReport {
  stores: Record<StoreName, StoreStatus | "skipped">;
  errors: Array<{ store: StoreName; message: string }>;
  /** True iff every REQUESTED store dumped cleanly. */
  ok: boolean;
}

const DEFAULT_CONTAINERS = {
  postgres: "flagship-postgres",
  forgejo: "flagship-forgejo",
} as const;

const ALL_STORES: ReadonlyArray<StoreName> = ["postgres", "files", "forgejo"];

function storesFor(cfg: VolumeDumpConfig): ReadonlyArray<StoreName> {
  const only = cfg.only ?? ALL_STORES;
  // Postgres and Forgejo need the admin credentials; the files folders don't.
  return cfg.creds ? only : only.filter((s) => s === "files");
}

// Inside-container paths (from the compose volume mounts).
const FORGEJO_DB_IN = "/var/lib/gitea/data/forgejo.db";
const FORGEJO_DB_BACKUP_IN = "/var/lib/gitea/data/_flagship_backup.db";
const FORGEJO_REPOS_PARENT_IN = "/var/lib/gitea/data";
const FORGEJO_REPOS_DIR = "gitea-repositories";
// Host-side paths (bind mounts), relative to `dataRoot`.
const FORGEJO_DB_BACKUP_HOST_REL = "forgejo/data/_flagship_backup.db";

// ──────────────────────────────────────────────────────────────────────
// Dump (backup side)
// ──────────────────────────────────────────────────────────────────────

/**
 * Write consistent dumps of every data store under `<dataRoot>/_dumps`.
 * Best-effort PER STORE: one store's failure is recorded + logged but does not
 * abort the others (each store is independent, like `realWipeContent`'s steps).
 * A failed store leaves NO partial dump (tmp+rename / cleanup), so the backup
 * either ships a whole consistent dump or nothing for that store — never torn.
 */
export async function dumpDataVolumes(cfg: VolumeDumpConfig): Promise<VolumeDumpReport> {
  const log = cfg.onLog ?? (() => {});
  const only = storesFor(cfg);
  const report: VolumeDumpReport = {
    stores: { postgres: "skipped", files: "skipped", forgejo: "skipped" },
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
  await runStore("files", () => dumpFiles(cfg, join(outBase, "files")));
  await runStore("forgejo", () => dumpForgejo(cfg, join(outBase, "forgejo")));

  return report;
}

function containerName(cfg: VolumeDumpConfig, key: keyof typeof DEFAULT_CONTAINERS): string {
  return cfg.containers?.[key] ?? DEFAULT_CONTAINERS[key];
}

async function dumpPostgres(cfg: VolumeDumpConfig, outPath: string): Promise<void> {
  // `pg_dumpall` = cluster-wide (all roles + all databases, their grants
  // included). Each per-DB dump runs in a serialized snapshot ⇒ consistent
  // under concurrent writes. Password passed via `-e PGPASSWORD` (loopback-only
  // box).
  await cfg.runner.runToFile(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${cfg.creds!.postgresPassword}`,
      containerName(cfg, "postgres"),
      "pg_dumpall",
      "-U",
      cfg.creds!.postgresUser,
      "-h",
      "127.0.0.1",
      "--clean",
      "--if-exists",
    ],
    outPath,
  );
}

/** The running containers that mount a volume (the app it belongs to). */
async function runningUsersOf(cfg: VolumeDumpConfig, volume: string): Promise<string[]> {
  const { stdout } = await cfg.runner.capture("docker", ["ps", "-q", "--filter", `volume=${volume}`]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The prod files volumes on this box (dev ones, a staging copy's, are never backed up). */
async function listProdFilesVolumes(cfg: VolumeDumpConfig): Promise<string[]> {
  const { stdout } = await cfg.runner.capture("docker", ["volume", "ls", "-q"]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((n) => isProdFilesVolume(n))
    .sort();
}

function filesTarArgs(cfg: VolumeDumpConfig, volume: string, mode: "dump" | "restore"): string[] {
  return filesArchiveDockerArgs(volume, mode, cfg.helperImage);
}

/**
 * `docker run` for a throwaway tar container over one files volume: `dump`
 * writes the folder to stdout read-only, `restore` unpacks stdin into it.
 * Shared with an app copy (appCopy/ops.ts).
 */
export function filesArchiveDockerArgs(volume: string, mode: "dump" | "restore", helperImage?: string): string[] {
  const caps =
    mode === "dump"
      ? ["--cap-add", "DAC_READ_SEARCH"]
      : ["--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "FSETID"];
  const args = [
    "run",
    ...(mode === "restore" ? ["-i"] : []),
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    ...caps,
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--user",
    "0:0",
    ...filesMountArgs(volume, { readonly: mode === "dump" }),
    "--entrypoint",
    "tar",
    helperImage ?? FILES_HELPER_IMAGE,
    ...(mode === "dump"
      ? ["--numeric-owner", "-cf", "-", "-C", "/data", "."]
      : ["--numeric-owner", "-xpf", "-", "-C", "/data"]),
  ];
  // Same tripwire as every app container: a named volume, never a host path.
  assertNoHostPathInDockerArgs(args);
  return args;
}

async function dumpFiles(cfg: VolumeDumpConfig, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const volumes = await listProdFilesVolumes(cfg);
  const failures: string[] = [];
  for (const volume of volumes) {
    // Freeze the app while its folder is archived (whatever its container
    // is called); an app that isn't running has nothing to freeze.
    const paused: string[] = [];
    try {
      for (const c of await runningUsersOf(cfg, volume)) {
        await cfg.runner.run("docker", ["pause", c]);
        paused.push(c);
      }
      await cfg.runner.runToFile("docker", filesTarArgs(cfg, volume, "dump"), join(outDir, `${volume}.tar`));
    } catch (e) {
      failures.push(`${volume}: ${(e as Error).message}`);
    } finally {
      for (const c of paused) await cfg.runner.run("docker", ["unpause", c]).catch(() => {});
    }
  }
  // An uninstalled app's archive goes with it.
  const keep = new Set(volumes.map((v) => `${v}.tar`));
  for (const f of await readdir(outDir).catch(() => [] as string[])) {
    if (f.endsWith(".tar") && !keep.has(f)) {
      await rm(join(outDir, f), { force: true });
    }
  }
  if (failures.length > 0) throw new Error(`files folders not archived: ${failures.join("; ")}`);
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
   * Compose file + env used to stop/start a single service (forgejo is
   * stop→restore→start). Defaults mirror installer/data-services.
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
 * Load the dumps produced by `dumpDataVolumes` back into a FRESH box, before
 * it takes traffic. Symmetric to the dump: each store's dump under
 * `<dataRoot>/_dumps` is applied with the inverse command. Best-effort per
 * store; a MISSING dump for a store is "absent" (not an error — that store just
 * had nothing backed up). Wired into the migration take-over path.
 */
export async function reloadDataVolumes(cfg: VolumeReloadConfig): Promise<VolumeReloadReport> {
  const log = cfg.onLog ?? (() => {});
  const only = storesFor(cfg);
  const report: VolumeReloadReport = {
    stores: { postgres: "absent", files: "absent", forgejo: "absent" },
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
  await runStore("files", join(base, "files"), () => reloadFiles(cfg, join(base, "files")));
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
      `PGPASSWORD=${cfg.creds!.postgresPassword}`,
      containerName(cfg, "postgres"),
      "psql",
      "-U",
      cfg.creds!.postgresUser,
      "-h",
      "127.0.0.1",
      "-d",
      "postgres",
    ],
    dumpPath,
  );
}

/**
 * Each `<volume>.tar` goes into a FRESH volume of that name: an existing one
 * no container uses is removed first (an app's folder is replaced, never
 * merged); one a container still uses is left alone and reported.
 */
async function reloadFiles(cfg: VolumeReloadConfig, inDir: string): Promise<void> {
  const failures: string[] = [];
  const tars = (await readdir(inDir)).filter((f) => f.endsWith(".tar")).sort();
  for (const f of tars) {
    const volume = f.slice(0, -4);
    if (!isProdFilesVolume(volume)) continue;
    try {
      const users = (await cfg.runner.capture("docker", ["ps", "-aq", "--filter", `volume=${volume}`])).stdout.trim();
      if (users) throw new Error("a container still uses it");
      await cfg.runner.run("docker", ["volume", "rm", "-f", volume]);
      await cfg.runner.run("docker", [
        "volume",
        "create",
        "--label",
        "flagship.files=prod",
        "--label",
        `flagship.app=${volume.slice("flagship-files-".length)}`,
        volume,
      ]);
      await cfg.runner.runFromFile("docker", filesTarArgs(cfg, volume, "restore"), join(inDir, f));
    } catch (e) {
      failures.push(`${volume}: ${(e as Error).message}`);
    }
  }
  if (failures.length > 0) throw new Error(`files folders not restored: ${failures.join("; ")}`);
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
  const { POSTGRES_ADMIN_USER, POSTGRES_ADMIN_PASSWORD } = env;
  if (!POSTGRES_ADMIN_USER || !POSTGRES_ADMIN_PASSWORD) return null;
  return { postgresUser: POSTGRES_ADMIN_USER, postgresPassword: POSTGRES_ADMIN_PASSWORD };
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
