import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import * as tar from "tar-stream";
import { AppBackupService, decryptArchive } from "../src/serviceBackup.js";

async function tmpDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "appbackup-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function unpackTarGz(buf: Buffer): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        out[header.name] = Buffer.concat(chunks).toString("utf8");
        next();
      });
      stream.resume();
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    Readable.from([buf]).pipe(createGunzip()).pipe(extract);
  });
  return out;
}

describe("AppBackupService", () => {
  let workdir: { dir: string; cleanup: () => Promise<void> };
  let backupDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    workdir = await tmpDir();
    backupDir = join(workdir.dir, "backups");
    sourceDir = join(workdir.dir, "source");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(sourceDir, "src"), { recursive: true });
    await writeFile(join(sourceDir, "flagship.app.json"), '{"schema_version":1,"name":"habits"}', "utf8");
    await writeFile(join(sourceDir, "Dockerfile"), "FROM busybox\n", "utf8");
    await writeFile(join(sourceDir, "src", "main.js"), "console.log('hi');\n", "utf8");
  });
  afterEach(async () => {
    await workdir.cleanup();
  });

  it("source-only backup: tar.gz contains the app's source tree", async () => {
    const svc = new AppBackupService({
      backupDir,
      resolveSource: async () => sourceDir,
    });
    const rec = await svc.createBackup({
      creator: "alice",
      slug: "habits",
      includeUserData: false,
    });
    expect(rec.encrypted).toBe(false);
    expect(rec.bytes).toBeGreaterThan(0);
    expect(rec.fetchPath).toBe(`/api/backups/${rec.backupId}`);

    const buf = await readFile(rec.path);
    const files = await unpackTarGz(buf);
    expect(files["source/flagship.app.json"]).toContain("habits");
    expect(files["source/Dockerfile"]).toContain("FROM busybox");
    expect(files["source/src/main.js"]).toContain("console.log");
  });

  it("password-protected backup is encrypted on disk and round-trips via decryptArchive", async () => {
    const svc = new AppBackupService({
      backupDir,
      resolveSource: async () => sourceDir,
    });
    const rec = await svc.createBackup({
      creator: "alice",
      slug: "habits",
      includeUserData: false,
      password: "correct horse battery staple",
    });
    expect(rec.encrypted).toBe(true);

    const onDisk = await readFile(rec.path);
    // First few bytes should NOT look like gzip magic (1f 8b) — they're
    // PBKDF2 salt instead.
    expect(onDisk.subarray(0, 2).toString("hex")).not.toBe("1f8b");

    const plain = await decryptArchive(onDisk, "correct horse battery staple");
    const files = await unpackTarGz(plain);
    expect(files["source/flagship.app.json"]).toBeDefined();
  });

  it("decryptArchive rejects the wrong password", async () => {
    const svc = new AppBackupService({
      backupDir,
      resolveSource: async () => sourceDir,
    });
    const rec = await svc.createBackup({
      creator: "alice",
      slug: "habits",
      includeUserData: false,
      password: "right",
    });
    const onDisk = await readFile(rec.path);
    await expect(decryptArchive(onDisk, "wrong")).rejects.toThrow();
  });

  it("rejects includeUserData=true when no dataExporter is wired", async () => {
    const svc = new AppBackupService({
      backupDir,
      resolveSource: async () => sourceDir,
    });
    await expect(
      svc.createBackup({ creator: "alice", slug: "habits", includeUserData: true }),
    ).rejects.toThrow(/dataExporter/);
  });

  it("includeUserData=true: data dump appears under data/ in the archive", async () => {
    const svc = new AppBackupService({
      backupDir,
      resolveSource: async () => sourceDir,
      dataExporter: async ({ outDir }) => {
        await writeFile(join(outDir, "postgres.sql"), "CREATE TABLE t(x INT);", "utf8");
        await mkdir(join(outDir, "objects"), { recursive: true });
        await writeFile(join(outDir, "objects", "blob.bin"), "object data", "utf8");
      },
    });
    const rec = await svc.createBackup({
      creator: "alice",
      slug: "habits",
      includeUserData: true,
    });
    const buf = await readFile(rec.path);
    const files = await unpackTarGz(buf);
    expect(files["data/postgres.sql"]).toBe("CREATE TABLE t(x INT);");
    expect(files["data/objects/blob.bin"]).toBe("object data");
    expect(files["source/flagship.app.json"]).toBeDefined();
  });

  it("streamForFetch returns the bytes once and evicts after read", async () => {
    const svc = new AppBackupService({
      backupDir,
      resolveSource: async () => sourceDir,
    });
    const rec = await svc.createBackup({
      creator: "alice",
      slug: "habits",
      includeUserData: false,
    });
    const fetched = await svc.streamForFetch(rec.backupId);
    expect(fetched).not.toBeNull();
    if (!fetched) return;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      fetched.stream.on("data", (c: Buffer) => chunks.push(c));
      fetched.stream.on("end", resolve);
      fetched.stream.on("error", reject);
    });
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    // Second fetch should miss (evicted on first stream close).
    await new Promise((r) => setTimeout(r, 20));
    const second = await svc.streamForFetch(rec.backupId);
    expect(second).toBeNull();
  });

  it("streamForFetch returns null after expiry", async () => {
    let now = 1_000_000;
    const svc = new AppBackupService({
      backupDir,
      resolveSource: async () => sourceDir,
      ttlMs: 100,
      now: () => now,
    });
    const rec = await svc.createBackup({
      creator: "alice",
      slug: "habits",
      includeUserData: false,
    });
    now += 200; // past TTL
    const fetched = await svc.streamForFetch(rec.backupId);
    expect(fetched).toBeNull();
  });

  it("rejects when the source resolver returns null", async () => {
    const svc = new AppBackupService({
      backupDir,
      resolveSource: async () => null,
    });
    await expect(
      svc.createBackup({ creator: "alice", slug: "habits", includeUserData: false }),
    ).rejects.toThrow(/source not found/);
  });
});
