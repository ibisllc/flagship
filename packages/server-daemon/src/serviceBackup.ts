/**
 * App backup / export — phone-driven, exfil-to-phone (N11).
 *
 * The phone POSTs a `backup-app` PhoneOrder. The daemon:
 *   1. Resolves the app's source on disk.
 *   2. Streams a tar.gz of {manifest.json, source/**, optionally
 *      data/...} into a one-shot file under <dataDir>/backups/.
 *   3. If a password was supplied, encrypts the archive end-to-end
 *      with AES-GCM via a PBKDF2-derived key (salt + iv prepended).
 *   4. Records the (backupId, expiresAt, path) in an in-memory
 *      registry; schedules a 30-minute cleanup.
 *   5. Returns { backupId, fetchPath, expiresAt } for the phone to
 *      pull bytes from.
 *
 * The phone's paired-session token gates the fetch endpoint so the
 * archive bytes never travel through the .com control plane.
 *
 * Data-layer dump (Postgres / MinIO / Redis) is sketched as an
 * optional `dataExporter` callback — the v1 path ships source-only
 * and skips data when the exporter is null.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import * as tar from "tar-stream";

export interface AppBackupSpec {
  creator: string;
  slug: string;
  includeUserData: boolean;
  password?: string;
}

export interface AppBackupRecord {
  backupId: string;
  fetchPath: string;
  expiresAt: number;
  path: string;
  encrypted: boolean;
  bytes: number;
}

export interface AppSourceResolver {
  /**
   * Return the path to the app's source tree on disk for {creator,
   * slug}, or null if the app isn't installed / no source available.
   * Production wires this to the daemon's app working dir + Forgejo
   * checkout fallback.
   */
  (args: { creator: string; slug: string }): Promise<string | null>;
}

export interface AppDataExporter {
  /**
   * Write a tarball-friendly tree of the app's data-layer dumps under
   * `outDir`. Production: pg_dump filtered by `<creator>_<slug>`,
   * MinIO bucket export, Redis key dump. Tests inject a stub.
   * Errors abort the backup.
   */
  (args: {
    creator: string;
    slug: string;
    outDir: string;
  }): Promise<void>;
}

export interface AppBackupServiceOptions {
  /** Where to keep backup archives. Defaults to <dataDir>/backups. */
  backupDir: string;
  resolveSource: AppSourceResolver;
  /** Optional: only invoked when includeUserData is true. */
  dataExporter?: AppDataExporter | null;
  /** TTL for unfetched backups. Default 30 minutes. */
  ttlMs?: number;
  /** Test seam. */
  now?: () => number;
}

export class AppBackupService {
  private readonly backupDir: string;
  private readonly resolveSource: AppSourceResolver;
  private readonly dataExporter: AppDataExporter | null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly registry = new Map<string, AppBackupRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: AppBackupServiceOptions) {
    this.backupDir = opts.backupDir;
    this.resolveSource = opts.resolveSource;
    this.dataExporter = opts.dataExporter ?? null;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Build a backup archive for the named app. Returns metadata; the
   * archive bytes live on disk, fetched separately via streamForFetch.
   */
  async createBackup(spec: AppBackupSpec): Promise<AppBackupRecord> {
    const sourceDir = await this.resolveSource({ creator: spec.creator, slug: spec.slug });
    if (!sourceDir) {
      throw new Error(`app source not found for ${spec.creator}/${spec.slug}`);
    }
    if (spec.includeUserData && !this.dataExporter) {
      throw new Error("includeUserData requested but no dataExporter wired");
    }

    await mkdir(this.backupDir, { recursive: true });
    const backupId = randomHex(16);
    const filename = spec.password
      ? `${backupId}.tar.gz.enc`
      : `${backupId}.tar.gz`;
    const path = join(this.backupDir, filename);

    // 1. Collect file specs, then stream them into the tar pack.
    const pack = tar.pack();
    const fileSpecs: { name: string; fullPath: string; size: number }[] = [];
    for await (const entry of walkFiles(sourceDir)) {
      const name = "source/" + relative(sourceDir, entry.fullPath).split(sep).join("/");
      fileSpecs.push({ name, fullPath: entry.fullPath, size: entry.size });
    }
    if (spec.includeUserData && this.dataExporter) {
      const dataStaging = join(this.backupDir, `${backupId}.staging`);
      await mkdir(dataStaging, { recursive: true });
      try {
        await this.dataExporter({
          creator: spec.creator,
          slug: spec.slug,
          outDir: dataStaging,
        });
        for await (const entry of walkFiles(dataStaging)) {
          const name = "data/" + relative(dataStaging, entry.fullPath).split(sep).join("/");
          fileSpecs.push({ name, fullPath: entry.fullPath, size: entry.size });
        }
      } finally {
        // We'll clean up the staging dir AFTER the pack reads from it.
      }
    }

    // Stream the pack to disk, gzipped, and (if password) encrypted.
    const writeTarget = createWriteStream(path);
    let bytesWritten = 0;
    writeTarget.on("data", () => undefined); // not used; we'll stat after close.

    const tarToGzip = pack.pipe(createGzip());

    if (spec.password) {
      // Read the gzip output into a buffer, encrypt, write.
      const chunks: Buffer[] = [];
      const collectPromise = new Promise<void>((resolve, reject) => {
        tarToGzip.on("data", (c: Buffer) => chunks.push(c));
        tarToGzip.on("end", resolve);
        tarToGzip.on("error", reject);
      });

      // Push file contents into the pack.
      for (const f of fileSpecs) {
        await new Promise<void>((resolve, reject) => {
          const e = pack.entry(
            { name: f.name, size: f.size, mode: 0o644 },
            (err) => (err ? reject(err) : resolve()),
          );
          createReadStream(f.fullPath).pipe(e);
        });
      }
      pack.finalize();
      await collectPromise;
      const plain = Buffer.concat(chunks);
      const encrypted = await encryptArchive(plain, spec.password);
      await writeFile(path, encrypted);
      bytesWritten = encrypted.length;
    } else {
      const writePromise = new Promise<void>((resolve, reject) => {
        writeTarget.on("close", resolve);
        writeTarget.on("error", reject);
      });
      tarToGzip.pipe(writeTarget);
      for (const f of fileSpecs) {
        await new Promise<void>((resolve, reject) => {
          const e = pack.entry(
            { name: f.name, size: f.size, mode: 0o644 },
            (err) => (err ? reject(err) : resolve()),
          );
          createReadStream(f.fullPath).pipe(e);
        });
      }
      pack.finalize();
      await writePromise;
      const s = await stat(path);
      bytesWritten = s.size;
    }

    // 4. Cleanup staging dir if any.
    if (spec.includeUserData) {
      const dataStaging = join(this.backupDir, `${backupId}.staging`);
      await rm(dataStaging, { recursive: true, force: true });
    }

    const expiresAt = this.now() + this.ttlMs;
    const record: AppBackupRecord = {
      backupId,
      fetchPath: `/api/backups/${backupId}`,
      expiresAt,
      path,
      encrypted: !!spec.password,
      bytes: bytesWritten,
    };
    this.registry.set(backupId, record);
    const t = setTimeout(() => {
      void this.evict(backupId);
    }, this.ttlMs);
    (t as unknown as { unref?: () => void }).unref?.();
    this.timers.set(backupId, t);
    return record;
  }

  /**
   * Stream the bytes of a backup. Caller must already have validated
   * the paired-session token. Returns null if the backupId is unknown
   * or expired. Single-fetch: the backup is evicted after the call
   * regardless of success.
   */
  async streamForFetch(backupId: string): Promise<{ stream: NodeJS.ReadableStream; record: AppBackupRecord } | null> {
    const record = this.registry.get(backupId);
    if (!record) return null;
    if (this.now() > record.expiresAt) {
      await this.evict(backupId);
      return null;
    }
    const stream = createReadStream(record.path);
    // Schedule eviction after the read completes.
    const evictAfter = () => {
      void this.evict(backupId);
    };
    stream.once("close", evictAfter);
    stream.once("error", evictAfter);
    return { stream, record };
  }

  async evict(backupId: string): Promise<void> {
    const record = this.registry.get(backupId);
    if (!record) return;
    this.registry.delete(backupId);
    const t = this.timers.get(backupId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(backupId);
    }
    await rm(record.path, { force: true });
  }
}

interface FileEntry { fullPath: string; size: number; }

async function* walkFiles(root: string): AsyncIterable<FileEntry> {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as typeof entries;
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        queue.push(full);
      } else if (ent.isFile()) {
        const s = await stat(full);
        yield { fullPath: full, size: s.size };
      }
    }
  }
}

/**
 * AES-GCM encrypt the archive with a key derived from `password` via
 * PBKDF2. Output layout: salt(16) | iv(12) | ciphertext.
 */
async function encryptArchive(plain: Buffer, password: string): Promise<Buffer> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 250_000 },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plain),
  );
  const out = new Uint8Array(salt.length + iv.length + ct.length);
  out.set(salt, 0);
  out.set(iv, salt.length);
  out.set(ct, salt.length + iv.length);
  return Buffer.from(out);
}

/**
 * Decrypt an archive produced by encryptArchive. Phone-side import
 * uses the same routine; exported for symmetry + tests.
 */
export async function decryptArchive(
  cipher: Buffer,
  password: string,
): Promise<Buffer> {
  if (cipher.length < 16 + 12 + 16) {
    throw new Error("ciphertext too short");
  }
  const salt = cipher.subarray(0, 16);
  const iv = cipher.subarray(16, 28);
  const ct = cipher.subarray(28);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 250_000 },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ct),
  );
  return Buffer.from(plain);
}

function randomHex(byteLen: number): string {
  const b = crypto.getRandomValues(new Uint8Array(byteLen));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// Re-exported for convenience — the runtime wires both factory + class.
export { Readable };
export { pipeline };
