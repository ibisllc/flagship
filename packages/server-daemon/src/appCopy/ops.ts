/**
 * The Docker and Postgres work a copy needs (docs/app-placement.md §5), behind
 * one interface so the copy logic is tested without a real box.
 *
 *   image  — `docker save` / `docker load`.
 *   db     — `pg_dump -Fc` of the app's own database as the app's own role
 *            (one serialized snapshot, consistent under concurrent writers),
 *            restored with `pg_restore` as the TARGET app's own role into its
 *            fresh database, so every object belongs to that role. Database
 *            and role names differ per box (HMAC under each box's
 *            DATA_NAME_KEY); the extensions each box creates for every app
 *            database are left out of the dump.
 *   files  — the backups' tar container (volumeDump.ts) with the app paused
 *            for the length of the archive; restore unpacks into the fresh,
 *            unused volume the install just made.
 *
 * The app's database password reaches `docker exec` through the environment
 * (`-e PGPASSWORD` takes the CLI's value), never through argv.
 */
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { APP_PG_EXTENSIONS } from "../dataLayer/naming.js";
import type { PostgresStore } from "../dataLayer/provisioner.js";
import { filesArchiveDockerArgs, filesSizeDockerArgs } from "../volumeDump.js";
import { describe, dockerFailure, dockerRepaired, wakeDocker } from "../dockerHealth.js";
import { realCommandRunner, type CommandRunner } from "../serviceRunner.js";

export interface AppCopyOps {
  saveImage(image: string, outPath: string): Promise<void>;
  loadImage(inPath: string): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  removeImage(image: string): Promise<void>;
  dumpDatabase(store: PostgresStore, outPath: string): Promise<void>;
  restoreDatabase(store: PostgresStore, inPath: string): Promise<void>;
  /** `container` is paused while the folder is read, when it runs. */
  archiveFiles(volume: string, container: string, outPath: string): Promise<void>;
  restoreFiles(volume: string, inPath: string): Promise<void>;
  /** Sizes, in bytes, for sizing a whole-server backup before it starts
   *  (serverArchive/build.ts). Each is an upper bound of what the matching
   *  save/dump/archive writes. Optional: without them the backup can't be sized. */
  databaseBytes?(store: PostgresStore): Promise<number>;
  filesBytes?(volume: string): Promise<number>;
}

function bytesFrom(out: string, what: string): number {
  const n = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`couldn't read the size of ${what}`);
  return n;
}

const TIMEOUT_MS = 60 * 60_000;

interface SpawnOpts {
  env?: Record<string, string>;
  stdoutTo?: string;
  stdinFrom?: string;
}

function exec(cmd: string, args: string[], o: SpawnOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: [o.stdinFrom ? "pipe" : "ignore", "pipe", "pipe"],
      env: o.env ? { ...process.env, ...o.env } : process.env,
    });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, TIMEOUT_MS);
    t.unref?.();
    let written: Promise<void> = Promise.resolve();
    if (o.stdoutTo) {
      const w = createWriteStream(o.stdoutTo, { mode: 0o600 });
      written = new Promise((res, rej) => {
        w.on("finish", () => res());
        w.on("error", rej);
      });
      p.stdout!.pipe(w);
    } else {
      p.stdout!.on("data", (d: Buffer) => {
        if (out.length < 64 * 1024) out += d.toString();
      });
    }
    p.stderr!.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-800);
    });
    if (o.stdinFrom) {
      const r = createReadStream(o.stdinFrom);
      r.on("error", (e) => {
        p.kill("SIGKILL");
        reject(e);
      });
      p.stdin!.on("error", () => {
        // the command exited before reading everything; its exit code says why
      });
      r.pipe(p.stdin!);
    }
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`${cmd} ${args[0] ?? ""} exited with code ${code}: ${err.trim()}`));
      written.then(() => resolve(out), reject);
    });
  });
}

/** Run with stdout into `outPath` via a partial file, so a failure leaves nothing. */
async function execToFile(cmd: string, args: string[], outPath: string, env?: Record<string, string>): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  const tmp = `${outPath}.partial`;
  try {
    await exec(cmd, args, { stdoutTo: tmp, ...(env ? { env } : {}) });
    await rename(tmp, outPath);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * A copy can arrive while dockerd is down or crash-looping; wake (or repair)
 * it, and say what dockerd itself reported when it won't start, so the owner
 * sees the box's problem, not ours.
 */
export async function ensureDocker(waitMs = 60_000): Promise<void> {
  const h = await wakeDocker({ cmd: realCommandRunner as Required<CommandRunner>, waitMs, log: (m) => console.warn(m) });
  if (!h.ok) throw new Error(h.reason);
  if (h.repaired) {
    dockerRepaired(h.repaired);
    throw new Error(`${h.repaired}. The server is restarting to finish; try again in a minute`);
  }
}

/** Run a docker command, saying what state dockerd is in when it couldn't be reached. */
async function docker(run: () => Promise<unknown>): Promise<void> {
  await ensureDocker();
  try {
    await run();
  } catch (e) {
    if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test((e as Error).message)) {
      throw new Error(`${(e as Error).message} (${describe(await dockerFailure(realCommandRunner as Required<CommandRunner>))})`);
    }
    throw e;
  }
}

function credsOf(store: PostgresStore): { role: string; password: string } {
  const u = new URL(store.url);
  return { role: decodeURIComponent(u.username) || store.role, password: decodeURIComponent(u.password) };
}

export function realAppCopyOps(opts: { postgresContainer?: string; helperImage?: string } = {}): AppCopyOps {
  const pg = opts.postgresContainer ?? "flagship-postgres";
  const pgArgs = (role: string, db: string) => ["-h", "127.0.0.1", "-U", role, "-d", db];
  return {
    saveImage: (image, outPath) => docker(() => execToFile("docker", ["save", image], outPath)),
    loadImage: (inPath) => docker(() => exec("docker", ["load", "-q"], { stdinFrom: inPath })),
    imageExists: async (image) => {
      try {
        await exec("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
        return true;
      } catch {
        return false;
      }
    },
    removeImage: async (image) => {
      await exec("docker", ["image", "rm", image]);
    },
    dumpDatabase: async (store, outPath) => {
      const { role, password } = credsOf(store);
      await execToFile(
        "docker",
        [
          "exec",
          "-e",
          "PGPASSWORD",
          pg,
          "pg_dump",
          ...pgArgs(role, store.database),
          "-Fc",
          "--no-owner",
          "--no-privileges",
          ...APP_PG_EXTENSIONS.map((x) => `--exclude-extension=${x}`),
        ],
        outPath,
        { PGPASSWORD: password },
      );
    },
    restoreDatabase: async (store, inPath) => {
      const { role, password } = credsOf(store);
      await exec(
        "docker",
        [
          "exec",
          "-i",
          "-e",
          "PGPASSWORD",
          pg,
          "pg_restore",
          ...pgArgs(role, store.database),
          "--no-owner",
          "--no-privileges",
          "--single-transaction",
          "--exit-on-error",
        ],
        { stdinFrom: inPath, env: { PGPASSWORD: password } },
      );
    },
    archiveFiles: async (volume, container, outPath) => {
      const running = (await exec("docker", ["ps", "-q", "--filter", `name=^${container}$`])).trim() !== "";
      if (running) await exec("docker", ["pause", container]);
      try {
        await execToFile("docker", filesArchiveDockerArgs(volume, "dump", opts.helperImage), outPath);
      } finally {
        if (running) await exec("docker", ["unpause", container]).catch(() => "");
      }
    },
    restoreFiles: async (volume, inPath) => {
      await exec("docker", filesArchiveDockerArgs(volume, "restore", opts.helperImage), { stdinFrom: inPath });
    },
    databaseBytes: async (store) => {
      const { role, password } = credsOf(store);
      const out = await exec(
        "docker",
        ["exec", "-e", "PGPASSWORD", pg, "psql", ...pgArgs(role, store.database), "-tAc", "SELECT pg_database_size(current_database())"],
        { env: { PGPASSWORD: password } },
      );
      return bytesFrom(out, "a database");
    },
    filesBytes: async (volume) => bytesFrom(await exec("docker", filesSizeDockerArgs(volume, opts.helperImage)), "a files folder"),
  };
}
