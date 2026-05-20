/**
 * Thin R2 upload helper — shells out to `npx wrangler` so we don't take
 * on an S3 SDK dependency. The wrangler CLI is already a workspace
 * devDep + the operator is logged in for normal `wrangler deploy`.
 *
 * Pipeline:
 *   1. `npx wrangler r2 object put <bucket>/<key> --file <localPath>`
 *   2. `npx wrangler r2 object create-multipart-upload …` — N/A here
 *   3. Mint a presigned read URL via `wrangler r2 object presign`
 *      (TTL: 1 hour, plenty for rescue boot + dd).
 *   4. After the harness teardown, `wrangler r2 object delete …` to
 *      remove the temp object — same `finally` as the server destroy.
 *
 * The pure helpers (object-key generator, command-line builders, key
 * sanitizer) are unit-tested with a fake spawn so the test suite never
 * shells out for real.
 */

import { spawn } from "node:child_process";
import type { SpawnOptions, ChildProcess } from "node:child_process";

export interface SpawnLike {
  (
    cmd: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess;
}

/** Build a unique R2 object key: `e2e-runs/<unix-ms>-<rand>.iso`. */
export function makeObjectKey(now: number, rand: () => string): string {
  return `e2e-runs/${now}-${rand()}.iso`;
}

export function rand6(): string {
  // 6 chars of url-safe base36 — collision-safe at the population the
  // harness runs at (a handful of objects per day).
  let s = "";
  while (s.length < 6) s += Math.random().toString(36).slice(2);
  return s.slice(0, 6);
}

/* ───────────────────────── pure CLI builders ────────────────────────── */

export function putArgs(
  bucket: string,
  key: string,
  localPath: string,
  remote = true,
): string[] {
  return [
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--file",
    localPath,
    ...(remote ? ["--remote"] : []),
  ];
}

export function presignArgs(
  bucket: string,
  key: string,
  ttlSeconds: number,
): string[] {
  return [
    "wrangler",
    "r2",
    "object",
    "presign",
    `${bucket}/${key}`,
    "--ttl",
    String(ttlSeconds),
  ];
}

export function deleteArgs(bucket: string, key: string, remote = true): string[] {
  return [
    "wrangler",
    "r2",
    "object",
    "delete",
    `${bucket}/${key}`,
    ...(remote ? ["--remote"] : []),
  ];
}

/** Crude but precise: pluck the first https://… URL out of wrangler's stdout. */
export function parsePresignedUrl(stdout: string): string {
  const m = stdout.match(/https:\/\/[^\s'"<>]+/);
  if (!m) {
    throw new Error(
      `wrangler r2 object presign produced no URL; stdout was: ${stdout.slice(0, 240)}`,
    );
  }
  return m[0];
}

/* ───────────────────────── thin spawn-based runners ─────────────────── */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCmd(
  cmd: string,
  args: readonly string[],
  options: { spawnFn?: SpawnLike; cwd?: string } = {},
): Promise<RunResult> {
  const sp = options.spawnFn ?? (spawn as SpawnLike);
  return new Promise((resolve, reject) => {
    const child = sp(cmd, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 0, stdout: out, stderr: err }));
  });
}

export interface R2UploadResult {
  bucket: string;
  key: string;
  presignedUrl: string;
}

export interface R2UploaderOptions {
  bucket: string;
  /** Path to wrangler binary; default uses `npx`. */
  wranglerBin?: string;
  /** Optional spawn shim (tests). */
  spawnFn?: SpawnLike;
  /** Presign TTL in seconds. Default 3600 (1 hour). */
  presignTtlSeconds?: number;
}

export class R2Uploader {
  private readonly bucket: string;
  private readonly bin: string;
  private readonly spawnFn: SpawnLike;
  private readonly ttl: number;

  constructor(opts: R2UploaderOptions) {
    if (!opts.bucket) throw new Error("R2Uploader needs a bucket name");
    this.bucket = opts.bucket;
    this.bin = opts.wranglerBin ?? "npx";
    this.spawnFn = opts.spawnFn ?? (spawn as SpawnLike);
    this.ttl = opts.presignTtlSeconds ?? 3_600;
  }

  /** Upload + presign in one call. */
  async upload(localPath: string, key: string): Promise<R2UploadResult> {
    const putRes = await this.run(putArgs(this.bucket, key, localPath));
    if (putRes.code !== 0) {
      throw new Error(
        `wrangler r2 object put failed (code ${putRes.code}): ${putRes.stderr.slice(0, 400)}`,
      );
    }
    const presignRes = await this.run(presignArgs(this.bucket, key, this.ttl));
    if (presignRes.code !== 0) {
      throw new Error(
        `wrangler r2 object presign failed (code ${presignRes.code}): ${presignRes.stderr.slice(0, 400)}`,
      );
    }
    const url = parsePresignedUrl(presignRes.stdout);
    return { bucket: this.bucket, key, presignedUrl: url };
  }

  async delete(key: string): Promise<void> {
    const res = await this.run(deleteArgs(this.bucket, key));
    if (res.code !== 0) {
      throw new Error(
        `wrangler r2 object delete failed (code ${res.code}): ${res.stderr.slice(0, 400)}`,
      );
    }
  }

  private run(wranglerArgs: string[]): Promise<RunResult> {
    // `wranglerArgs` always starts with "wrangler …"; when we shell out
    // via `npx` we forward that whole vector as npx's positional args.
    const args =
      this.bin === "npx" ? wranglerArgs : wranglerArgs.slice(1);
    return runCmd(this.bin, args, { spawnFn: this.spawnFn });
  }
}
