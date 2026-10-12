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
import { filesArchiveDockerArgs } from "../volumeDump.js";

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

function credsOf(store: PostgresStore): { role: string; password: string } {
  const u = new URL(store.url);
  return { role: decodeURIComponent(u.username) || store.role, password: decodeURIComponent(u.password) };
}

export function realAppCopyOps(opts: { postgresContainer?: string; helperImage?: string } = {}): AppCopyOps {
  const pg = opts.postgresContainer ?? "flagship-postgres";
  const pgArgs = (role: string, db: string) => ["-h", "127.0.0.1", "-U", role, "-d", db];
  return {
    saveImage: (image, outPath) => execToFile("docker", ["save", image], outPath),
    loadImage: async (inPath) => {
      await exec("docker", ["load", "-q"], { stdinFrom: inPath });
    },
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
  };
}
