/**
 * "Backup/clone server" on the box (owner sessions only, behind the screens gate).
 *
 * Backup (two files, docs/server-backup-and-clone.md):
 *   POST   /api/screens/server-archive/start   { archiveId, key, slots } → 202
 *          key = the content key (hex) the owner's app made; slots = its key
 *          slots (passcode, account), written into the backup file as they are
 *   GET    /api/screens/server-archive                              → { archive: {...} | null }
 *   GET    /api/screens/server-archive/backup-file                  → the backup file (small JSON)
 *   GET    /api/screens/server-archive/chunk?offset=N               → ≤ 4 MiB of the data file
 *   POST   /api/screens/server-archive/link                         → { path, backupFileName, dataFileName, bytes, sha256, expiresAt }
 *   POST   /api/screens/server-archive/approve  { approval, signature }  (flagship/archive-download/v1)
 *   GET    /api/archive-download/<token>            → the download page (QR + code); never a file
 *   GET    /api/archive-download/<token>/status?r=  → { approved }
 *   GET    /api/archive-download/<token>/backup?r=  → the backup file   } only for a request the owner
 *   GET    /api/archive-download/<token>/file?r=    → the data file     } approved (signed, checked under
 *          this box's authority); the data file streams from disk with
 *          HTTP Range (206, Accept-Ranges, ETag = its SHA-256).
 *   DELETE /api/screens/server-archive                              → forget it (and delete the files)
 * Restore, only on a server created to restore a backup (restoreWait.ts):
 *   GET    /api/screens/server-restore                              → { waiting, restore }
 *   POST   /api/screens/server-restore/start   { archiveId, bytes } → 202 { received } (resumes)
 *   POST   /api/screens/server-restore/chunk?offset=N  (raw bytes)  → { received }
 *   POST   /api/screens/server-restore/commit  { key }              → 202
 *
 * One backup and one restore at a time. The box sees the content key only for
 * the minutes it needs it and never keeps it. A restore checks the uploaded
 * data file against the owner-signed restore order (size and SHA-256) before
 * the key opens it, then every frame as it unpacks.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BACKUP_BUNDLE_HEADER_BYTES,
  archiveDownloadCode,
  archiveKeysDigest,
  backupBundleFileName,
  backupBundleHeader,
  parseBackupBundleHeader,
  parseArchiveDownloadApproval,
  parseArchiveKeys,
  parseArchiveKeysDeposit,
  parseBackupSlots,
  wrapAccountSlot,
  type ArchiveDownloadApproval,
  type ArchiveKeysDeposit,
  type BackupBody,
  type BackupSlot,
} from "@flagship/protocol";
import { renderDownloadPage } from "./downloadPage.js";
import { mkdir, open, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { ARCHIVE_EXCLUDES, ARCHIVE_INCLUDES, buildServerArchive, estimateServerArchive, type ArchiveBuildDeps } from "./build.js";
import { ARCHIVE_FRAME_BYTES, ArchiveError, checkDataFile, writeBackupFile } from "./format.js";
import { installArchive, unpackArchive, type ArchiveRestoreDeps, type RestoreAppResult } from "./restore.js";
import type { RestoreWait } from "./restoreWait.js";
import { KEY_POOL_LOW, KEY_POOL_MAX, SAVED_BACKUP_FILE, SAVED_DATA_FILE, SavedBackups, type SavedBackupMeta, type SavedState } from "./saved.js";
import { isDue, nextRunAt, parseSchedule, retained, slotStartAtOrBefore } from "./schedule.js";
import type { MigratePause } from "./migratePause.js";

/** statfs of a folder, or of its nearest existing parent: the backup folders are made on first use. */
export async function statfsNearest(dir: string) {
  let at = dir;
  for (;;) {
    try {
      return await statfs(at);
    } catch (e) {
      const parent = dirname(at);
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || parent === at) throw e;
      at = parent;
    }
  }
}

export async function freeBytesAt(dir: string): Promise<number> {
  const s = await statfsNearest(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export const ARCHIVE_PATH = "/api/screens/server-archive";
export const DOWNLOAD_PATH = "/api/archive-download/";
/** Migrate's speed check: a few MiB the new server times (no session; a one-use token). */
export const PROBE_PATH = "/api/archive-probe/";
export const RESTORE_PATH = "/api/screens/server-restore";
/** The saved backups (Back up now into the list, and the schedule). */
export const SAVED_PATH = `${ARCHIVE_PATH}/backups`;
export const ARCHIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60_000;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
/** Left free after a backup, so the apps and Postgres keep working while it runs. */
const HEADROOM_BYTES = 1024 * 1024 * 1024;

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}

export class NotEnoughSpace extends Error {}

export function isServerArchivePath(path: string): boolean {
  return path === ARCHIVE_PATH || path.startsWith(`${ARCHIVE_PATH}/`) || path === RESTORE_PATH || path.startsWith(`${RESTORE_PATH}/`);
}

export interface ServerArchiveServiceOptions {
  /** `<dataDir>/archives`: the two backup files and the scratch. Cleared at start. */
  dir: string;
  /** `<dataDir>/restore-upload`: a restore's upload, kept across restarts so it resumes. */
  uploadDir?: string;
  build: Omit<ArchiveBuildDeps, "workDir">;
  restore: Omit<ArchiveRestoreDeps, "workDir">;
  /** How this server was created (from its install blob): a restore makes the new server the same way. */
  serverSettings?: () => Promise<{ bootUnlockMode: "auto" | "approve"; diskEncryption: "luks" | "none" }>;
  /** Whether this server waits for a backup; absent ⇒ it never accepts one. */
  wait?: RestoreWait | null;
  /** Activity feed: kind, one readable line, ok. */
  note?: (kind: string, detail: string, ok?: boolean) => void;
  freeBytes?: (dir: string) => Promise<number>;
  /** Check an owner's `flagship/archive-download/v1` under this box's sensitive-order authority.
   *  Absent ⇒ no browser download is ever approved (fail closed). */
  authorizeDownload?: (a: ArchiveDownloadApproval, sig: Uint8Array) => boolean;
  /** `https://<control apex>`: the download page's QR is `<this>/app/backup-download#…`. */
  appLinkBase?: string;
  /** Saved backups: Back up now into a list, and the schedule. Absent ⇒ those routes answer 404. */
  saved?: {
    /** `<dataDir>/server-backups`: kept across restarts (never under `dir`). */
    dir: string;
    /** Check an admin device's `flagship/server-archive-keys/v1` under this box's sensitive-order authority. */
    authorizeKeys: (d: ArchiveKeysDeposit, sig: Uint8Array) => boolean;
    /** Size of the disk holding `dir` (default: statfs). */
    diskBytes?: (dir: string) => Promise<number>;
    /** Share of the disk saved backups may take. Default 0.5. */
    maxDiskShare?: number;
    /** Whether the schedule runs (the backup policy is phone-side, or unset). Default: always. */
    scheduleActive?: () => boolean;
  };
  /** Whether an import of `bytes` may come onto this server (the backup policy's limit): null, or why not. */
  admitIncoming?: (bytes: number) => string | null;
  /** Migrate on the archive path (docs/server-migration.md): the pause on the old box. */
  migrate?: { pause: MigratePause };
  /** Fetch for a box-to-box pull and the link probe (tests). */
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}

interface BackupJob {
  archiveId: string;
  state: "building" | "ready" | "failed";
  startedAt: number;
  progress: { done: number; total: number; app: string };
  /** The data file's size and SHA-256. */
  bytes?: number;
  sha256?: string;
  /** The backup file's size. */
  backupBytes?: number;
  /** The one file's SHA-256. */
  bundleSha256?: string;
  /** What the box expects the data file to take, once it has sized it. */
  estimatedBytes?: number;
  apps?: Array<{ serviceId: string; name: string }>;
  /** Apps that couldn't go in (no source, no public image), with why. */
  left?: Array<{ serviceId: string; name: string; reason: string }>;
  reason?: string;
}

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` against `size`; null = no usable Range (serve it all). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

/** SHA-256 of the one `.flagship` file: the header, the backup file, the data file. */
async function bundleDigest(backupPath: string, backupBytes: number, dataPath: string): Promise<string> {
  const h = createHash("sha256");
  h.update(Buffer.from(backupBundleHeader(backupBytes)));
  for (const p of [backupPath, dataPath]) {
    for await (const c of createReadStream(p)) h.update(c as Buffer);
  }
  return h.digest("hex");
}

function fileStem(sourceServer: string, at: number): string {
  const label = (sourceServer.split(".")[0] ?? "").replace(/[^A-Za-z0-9-]/g, "") || "server";
  return `${label}-${new Date(at).toISOString().slice(0, 10)}`;
}
export function backupFileName(sourceServer: string, at: number): string {
  return `${fileStem(sourceServer, at)}.flagship-backup`;
}
export function dataFileName(sourceServer: string, at: number): string {
  return `${fileStem(sourceServer, at)}.flagship-data`;
}

interface RestoreJob {
  archiveId: string;
  state: "uploading" | "ready" | "checking" | "restoring" | "done" | "failed";
  bytes: number;
  received: number;
  apps: RestoreAppResult[];
  reason?: string;
  startedAt: number;
}

const J = { "content-type": "application/json" } as const;

export function buildServerArchiveService(opts: ServerArchiveServiceOptions) {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const note = (kind: string, detail: string, ok = true) => {
    try {
      opts.note?.(kind, detail, ok);
    } catch {
      /* the feed never fails a backup */
    }
  };
  const dataFile = join(opts.dir, "server-backup.flagship-data");
  const backupFile = join(opts.dir, "server-backup.flagship-backup");
  const uploadDir = opts.uploadDir ?? join(opts.dir, "upload");
  const uploadFile = join(uploadDir, "restore.flagship-data");
  const scratch = join(opts.dir, "scratch");
  const unpackDir = join(opts.dir, "import-unpacked");
  let backup: BackupJob | null = null;
  let restore: RestoreJob | null = null;
  let running = false;
  /** A box-to-box pull of the backup this server waits for is under way. */
  let pulling = false;

  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra });
  const free = opts.freeBytes ?? freeBytesAt;

  async function ensureDir(dir: string = opts.dir): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async function dropBackupFiles(): Promise<void> {
    await rm(dataFile, { force: true }).catch(() => {});
    await rm(backupFile, { force: true }).catch(() => {});
  }

  async function sweep(): Promise<void> {
    if (backup && backup.state !== "building" && now() - backup.startedAt > KEEP_MS) {
      links.delete(backup.archiveId);
      backup = null;
      await dropBackupFiles();
    }
  }

  async function settings(): Promise<{ bootUnlockMode: "auto" | "approve"; diskEncryption: "luks" | "none" }> {
    try {
      return (await opts.serverSettings?.()) ?? { bootUnlockMode: "auto", diskEncryption: "luks" };
    } catch {
      return { bootUnlockMode: "auto", diskEncryption: "luks" };
    }
  }

  /**
   * Make one archive: size it, check the disk, seal the data file, write the
   * backup file around the slots. Shared by Back up now (the owner's slots)
   * and the saved/scheduled backups (an account slot from the key pool).
   */
  async function makeArchive(a: {
    archiveId: string;
    key: Buffer;
    slots: BackupSlot[];
    dataPath: string;
    backupPath: string;
    dataName: string;
    job: { progress: { done: number; total: number; app: string }; estimatedBytes?: number };
    /** Free room (e.g. drop older saved backups) until `need` bytes are free; returns the bytes free after. */
    makeRoom?: (need: number, estimate: number) => Promise<number>;
  }): Promise<{ bytes: number; sha256: string; backupBytes: number; bundleSha256: string; apps: Array<{ serviceId: string; name: string }>; left: Array<{ serviceId: string; name: string; reason: string }>; createdAt: number }> {
    // Size it first: the data file, one app's scratch, and headroom so
    // the apps keep working. A box that can't size something goes ahead
    // on the flat minimum it already passed.
    a.job.progress = { done: 0, total: 0, app: "Checking free space" };
    const est = await estimateServerArchive(opts.build);
    if (est) {
      a.job.estimatedBytes = est.archiveBytes;
      const need = est.archiveBytes + est.largestAppBytes + HEADROOM_BYTES;
      let have = await free(opts.dir);
      if (a.makeRoom) have = await a.makeRoom(need, est.archiveBytes);
      if (have < need) {
        throw new NotEnoughSpace(
          `this server needs about ${gb(need)} free to make this backup and has ${gb(have)}. Free some space (or remove apps you don't need) and try again`,
        );
      }
    }
    const r = await buildServerArchive(
      { ...opts.build, workDir: scratch },
      {
        archiveId: a.archiveId,
        key: a.key,
        outPath: a.dataPath,
        onProgress: (done, total, app) => {
          a.job.progress = { done, total, app };
        },
      },
    );
    const fqdn = opts.build.serverFqdn;
    const body: BackupBody = {
      createdAt: r.createdAt,
      server: { name: fqdn.split(".")[0] ?? fqdn, domain: fqdn, ...(await settings()) },
      apps: r.apps,
      left: r.left,
      includes: ARCHIVE_INCLUDES,
      excludes: ARCHIVE_EXCLUDES,
      data: { fileName: a.dataName, bytes: r.bytes, sha256: r.sha256, frameBytes: ARCHIVE_FRAME_BYTES },
    };
    const written = await writeBackupFile(a.backupPath, { archiveId: a.archiveId, key: a.key, slots: a.slots, body, nonce: randomBytes(12) });
    return { ...r, backupBytes: written.bytes, bundleSha256: await bundleDigest(a.backupPath, written.bytes, a.dataPath) };
  }

  function startBackup(req: HttpRequest): Promise<HttpResponse> {
    return (async () => {
      let b: { archiveId?: unknown; key?: unknown; slots?: unknown };
      try {
        b = JSON.parse(req.body.toString("utf8")) as typeof b;
      } catch {
        return err(400, "invalid json");
      }
      if (typeof b.archiveId !== "string" || !/^[0-9a-f]{32}$/.test(b.archiveId)) return err(400, "archiveId must be 16 bytes of lowercase hex");
      if (typeof b.key !== "string" || !/^[0-9a-f]{64}$/.test(b.key)) return err(400, "key must be 32 bytes of lowercase hex");
      const slots: BackupSlot[] | null = parseBackupSlots(b.slots);
      if (!slots) return err(400, "slots must hold a passcode slot, an account slot, or both");
      // Back up now always has a passcode: it is what opens the backup on an account that isn't yours (owner, 2026-10-16).
      if (!slots.some((s) => s.kind === "passcode")) return err(400, "a backup made with Back up now needs a passcode", { code: "passcode-required" });
      if (running) return err(409, "a backup or restore is already running here");
      await ensureDir();
      if ((await free(opts.dir)) < MIN_FREE_BYTES) return err(507, "this server doesn't have enough free disk space to make a backup");
      running = true;
      const job: BackupJob = { archiveId: b.archiveId, state: "building", startedAt: now(), progress: { done: 0, total: 0, app: "" } };
      if (backup) links.delete(backup.archiveId);
      backup = job;
      await dropBackupFiles();
      note("server.backup.started", "Started a backup of this server.");
      const key = Buffer.from(b.key, "hex");
      const archiveId = b.archiveId;
      void makeArchive({
        archiveId,
        key,
        slots,
        dataPath: dataFile,
        backupPath: backupFile,
        dataName: dataFileName(opts.build.serverFqdn, job.startedAt),
        job,
      })
        .then((r) => {
          job.state = "ready";
          job.bytes = r.bytes;
          job.sha256 = r.sha256;
          job.backupBytes = r.backupBytes;
          job.bundleSha256 = r.bundleSha256;
          job.apps = r.apps;
          job.left = r.left;
          key.fill(0);
          note(
            "server.backup.created",
            `Backup ready: ${r.apps.length} app${r.apps.length === 1 ? "" : "s"}.` +
              (r.left.length > 0 ? ` Left out: ${r.left.map((x) => x.name).join(", ")} (no source to rebuild from).` : ""),
            r.left.length === 0,
          );
          log(`[server-archive] backup ready (${r.bytes} bytes)`);
        })
        .catch(async (e: Error) => {
          job.state = "failed";
          job.reason = e.message || "the backup couldn't be made";
          key.fill(0);
          await dropBackupFiles();
          note("server.backup.failed", `The backup failed: ${job.reason}`, false);
          log(`[server-archive] backup failed: ${job.reason}`);
        })
        .finally(async () => {
          running = false;
          await rm(scratch, { recursive: true, force: true }).catch(() => {});
        });
      return json(202, { archiveId: b.archiveId });
    })();
  }

  // -------------------------------------------------------------------------
  // Downloads (Back up now's backup and every saved backup)
  // -------------------------------------------------------------------------

  /** A finished backup the owner can fetch. */
  interface Downloadable {
    archiveId: string;
    bytes: number;
    sha256: string;
    dataPath: string;
    backupPath: string;
    backupFileName: string;
    dataFileName: string;
    /** The backup file's size (the one file's metadata part). */
    backupBytes: number;
    /** The one `.flagship` file: its name, size and SHA-256 (served as a concatenation, never copied). */
    bundleFileName: string;
    bundleBytes: number;
    bundleSha256: string;
    /** null: kept until it is removed (saved backups). */
    expiresAt: number | null;
  }

  /** Bytes [start, end] of the one file: header, then the backup file, then the data file. */
  function bundleParts(d: Downloadable, start: number, end: number): Array<{ buf: Buffer } | { path: string; start: number; end: number }> {
    const header = Buffer.from(backupBundleHeader(d.backupBytes));
    const segs = [
      { at: 0, size: header.length, buf: header as Buffer | null, path: "" },
      { at: header.length, size: d.backupBytes, buf: null, path: d.backupPath },
      { at: header.length + d.backupBytes, size: d.bytes, buf: null, path: d.dataPath },
    ];
    const out: Array<{ buf: Buffer } | { path: string; start: number; end: number }> = [];
    for (const s of segs) {
      const a = Math.max(start, s.at);
      const b = Math.min(end, s.at + s.size - 1);
      if (a > b) continue;
      if (s.buf) out.push({ buf: s.buf.subarray(a - s.at, b - s.at + 1) });
      else out.push({ path: s.path, start: a - s.at, end: b - s.at });
    }
    return out;
  }

  function bundleStream(d: Downloadable, start: number, end: number): NodeJS.ReadableStream {
    const parts = bundleParts(d, start, end);
    return Readable.from(
      (async function* () {
        for (const p of parts) {
          if ("buf" in p) yield p.buf;
          else for await (const c of createReadStream(p.path, { start: p.start, end: p.end })) yield c as Buffer;
        }
      })(),
    );
  }

  async function bundleRead(d: Downloadable, start: number, len: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of bundleStream(d, start, start + len - 1)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }
  /** Download links, by archive id; they die with the backup (and at a restart). */
  const links = new Map<string, { token: string; approved: Set<string> }>();
  const downloadedNoted = new Set<string>();

  function manualDownloadable(): Downloadable | null {
    if (!backup || backup.state !== "ready" || backup.bytes === undefined) return null;
    return {
      archiveId: backup.archiveId,
      bytes: backup.bytes,
      sha256: backup.sha256 ?? "",
      dataPath: dataFile,
      backupPath: backupFile,
      backupFileName: backupFileName(opts.build.serverFqdn, backup.startedAt),
      dataFileName: dataFileName(opts.build.serverFqdn, backup.startedAt),
      backupBytes: backup.backupBytes ?? 0,
      bundleFileName: backupBundleFileName(dataFileName(opts.build.serverFqdn, backup.startedAt)),
      bundleBytes: BACKUP_BUNDLE_HEADER_BYTES + (backup.backupBytes ?? 0) + backup.bytes,
      bundleSha256: backup.bundleSha256 ?? "",
      expiresAt: backup.startedAt + KEEP_MS,
    };
  }

  function savedDownloadable(m: SavedBackupMeta): Downloadable {
    return {
      archiveId: m.archiveId,
      bytes: m.bytes,
      sha256: m.sha256,
      dataPath: join(store!.entryDir(m.archiveId), SAVED_DATA_FILE),
      backupPath: join(store!.entryDir(m.archiveId), SAVED_BACKUP_FILE),
      backupFileName: m.backupFileName,
      dataFileName: m.dataFileName,
      backupBytes: m.backupBytes,
      bundleFileName: m.bundleFileName,
      bundleBytes: m.bundleBytes,
      bundleSha256: m.bundleSha256,
      expiresAt: null,
    };
  }

  async function savedById(archiveId: string): Promise<Downloadable | null> {
    if (!store || !/^[0-9a-f]{32}$/.test(archiveId)) return null;
    const m = (await store.list()).find((x) => x.archiveId === archiveId);
    return m ? savedDownloadable(m) : null;
  }

  async function allDownloadables(): Promise<Downloadable[]> {
    const out: Downloadable[] = [];
    const m = manualDownloadable();
    if (m) out.push(m);
    if (store) for (const meta of await store.list()) out.push(savedDownloadable(meta));
    return out;
  }

  async function chunk(d: Downloadable | null, req: HttpRequest): Promise<HttpResponse> {
    if (!d) return err(404, "no backup is ready");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const offset = Number(q.get("offset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > d.bytes) return err(400, "bad offset");
    const len = Math.min(ARCHIVE_CHUNK_BYTES, d.bytes - offset);
    const buf = Buffer.alloc(len);
    const fh = await open(d.dataPath, "r");
    try {
      let read = 0;
      while (read < len) {
        const r = await fh.read(buf, read, len - read, offset + read);
        if (r.bytesRead === 0) break;
        read += r.bytesRead;
      }
      if (read !== len) return err(500, "the backup file changed while it was read");
    } finally {
      await fh.close();
    }
    if (offset + len >= d.bytes) noteDownloaded(d);
    return {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-flagship-archive-bytes": String(d.bytes),
        "x-flagship-archive-sha256": d.sha256,
        "cache-control": "no-store",
      },
      body: buf,
    };
  }

  /** `GET .../bundle?offset=N`: ≤ 4 MiB of the one `.flagship` file, for the phones' resumable downloader. */
  async function bundleChunk(d: Downloadable | null, req: HttpRequest): Promise<HttpResponse> {
    if (!d) return err(404, "no backup is ready");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const offset = Number(q.get("offset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > d.bundleBytes) return err(400, "bad offset");
    const len = Math.min(ARCHIVE_CHUNK_BYTES, d.bundleBytes - offset);
    const buf = len > 0 ? await bundleRead(d, offset, len) : Buffer.alloc(0);
    if (buf.length !== len) return err(500, "the backup file changed while it was read");
    if (offset + len >= d.bundleBytes) noteDownloaded(d);
    return {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-flagship-bundle-bytes": String(d.bundleBytes),
        "x-flagship-bundle-sha256": d.bundleSha256,
        "content-disposition": `attachment; filename="${d.bundleFileName}"`,
        "cache-control": "no-store",
      },
      body: buf,
    };
  }

  async function backupFileResponse(d: Downloadable | null): Promise<HttpResponse> {
    if (!d) return err(404, "no backup is ready");
    let text: Buffer;
    try {
      text = await readFile(d.backupPath);
    } catch {
      return err(404, "no backup is ready");
    }
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${d.backupFileName}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
      body: text,
    };
  }

  function noteDownloaded(d: Downloadable): void {
    if (downloadedNoted.has(d.archiveId)) return;
    downloadedNoted.add(d.archiveId);
    note("server.backup.downloaded", d.expiresAt === null ? "A saved backup was downloaded." : "The backup was downloaded.");
  }

  function mintLink(d: Downloadable | null): HttpResponse {
    if (!d) return err(404, "no backup is ready");
    let l = links.get(d.archiveId);
    if (!l) {
      l = { token: randomBytes(32).toString("hex"), approved: new Set() };
      links.set(d.archiveId, l);
    }
    return json(200, {
      path: `${DOWNLOAD_PATH}${l.token}`,
      backupFileName: d.backupFileName,
      dataFileName: d.dataFileName,
      bundleFileName: d.bundleFileName,
      bundleBytes: d.bundleBytes,
      bundleSha256: d.bundleSha256,
      bytes: d.bytes,
      sha256: d.sha256,
      expiresAt: d.expiresAt,
    });
  }

  async function byToken(token: string): Promise<{ d: Downloadable; link: { token: string; approved: Set<string> } } | null> {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const want = Buffer.from(token, "hex");
    for (const d of await allDownloadables()) {
      const l = links.get(d.archiveId);
      if (l && timingSafeEqual(Buffer.from(l.token, "hex"), want)) return { d, link: l };
    }
    return null;
  }

  /** `POST .../approve`: the owner's signed approval for one browser request. */
  async function approve(req: HttpRequest): Promise<HttpResponse> {
    let b: { approval?: unknown; signature?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    const a = parseArchiveDownloadApproval(b.approval);
    if (!a || typeof b.signature !== "string" || !/^[0-9a-f]{128}$/.test(b.signature)) return err(400, "malformed approval");
    const d = (await allDownloadables()).find((x) => x.archiveId === a.archiveId);
    const l = d ? links.get(d.archiveId) : undefined;
    if (!d || !l) return err(404, "that backup isn't ready on this server any more");
    if (a.serverDomain !== opts.build.serverFqdn) return err(403, "the approval is for a different server");
    if (Math.abs(now() - a.issuedAt) > 5 * 60_000) return err(403, "the approval is stale: approve again");
    if (!opts.authorizeDownload || !opts.authorizeDownload(a, Buffer.from(b.signature, "hex"))) return err(403, "invalid signature");
    l.approved.add(a.requestId);
    note("server.backup.download-approved", "A browser download of the backup was approved.");
    return json(200, { ok: true });
  }

  const html = (status: number, body: string, extra: Record<string, string> = {}): HttpResponse => ({
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      ...extra,
    },
    body,
  });

  /** The download link: the page, its status, and (approved only) the two files. */
  async function handleDownload(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0]!;
    const probed = serveProbe(path);
    if (probed) return probed;
    if (!path.startsWith(DOWNLOAD_PATH)) return null;
    const [token = "", kind = "", ...more] = path.slice(DOWNLOAD_PATH.length).split("/");
    if (more.length > 0 || !["", "status", "bundle"].includes(kind)) return err(404, "not found");
    const method = req.method.toUpperCase();
    if (method !== "GET" && (method !== "HEAD" || kind !== "bundle")) return err(405, "method not allowed");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const r = q.get("r") ?? "";
    const validR = /^[0-9a-f]{32}$/.test(r);
    await sweep();
    const found = await byToken(token);
    if (!found) {
      return kind === ""
        ? html(404, "<!doctype html><meta charset=utf-8><title>Link expired</title><p>This download link has expired or was replaced by a newer backup.</p>")
        : err(404, "this download link has expired or was replaced by a newer backup");
    }
    const { d, link } = found;
    const base = `${DOWNLOAD_PATH}${token}`;
    if (kind === "") {
      // A fresh request id per page, kept in the URL so a reload or a retry
      // keeps its approval.
      if (!validR) return { status: 303, headers: { location: `${base}?r=${randomBytes(16).toString("hex")}`, "cache-control": "no-store" }, body: "" };
      const appLinkBase = (opts.appLinkBase ?? "https://flagshipserver.com").replace(/\/+$/, "");
      return html(
        200,
        renderDownloadPage({
          appLink: `${appLinkBase}/app/backup-download#s=${encodeURIComponent(opts.build.serverFqdn)}&a=${d.archiveId}&r=${r}`,
          code: archiveDownloadCode(r),
          fileName: d.bundleFileName,
          sizeText: gb(d.bundleBytes),
          statusUrl: `${base}/status?r=${r}`,
          fileUrl: `${base}/bundle?r=${r}`,
          expiresText: d.expiresAt === null ? "the backup is removed from the server" : new Date(d.expiresAt).toUTCString(),
        }),
      );
    }
    if (!validR) return err(400, "r must be 16 bytes of lowercase hex");
    const approved = link.approved.has(r);
    if (kind === "status") return json(200, { approved });
    if (!approved) return err(403, "this download hasn't been approved: scan the QR on the download page with the Flagship app");
    // The one `.flagship` file, streamed as header + backup file + data file (no copy on disk).
    const size = d.bundleBytes;
    const etag = `"${d.bundleSha256 || d.archiveId}"`;
    const fileHeaders: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${d.bundleFileName}"`,
      "accept-ranges": "bytes",
      etag,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    const ifRange = req.headers["if-range"];
    const range = ifRange && ifRange !== etag ? null : parseRange(req.headers["range"], size);
    if (range === "unsatisfiable") {
      return { status: 416, headers: { ...fileHeaders, "content-range": `bytes */${size}` }, body: "" };
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (method === "GET" && end === size - 1) noteDownloaded(d);
    return {
      status: range ? 206 : 200,
      headers: { ...fileHeaders, ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) },
      body: "",
      stream: {
        length: end - start + 1,
        open: () => bundleStream(d, start, end),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Saved backups: Back up now into the list, and the schedule
  // -------------------------------------------------------------------------

  const store = opts.saved ? new SavedBackups(opts.saved.dir) : null;
  let savedState: SavedState | null = null;
  let keyPool: Array<{ archiveId: string; kekHex: string }> = [];
  let savedJob: {
    archiveId: string;
    trigger: "schedule" | "now";
    startedAt: number;
    progress: { done: number; total: number; app: string };
    estimatedBytes?: number;
  } | null = null;
  /** The peer engine's hooks: it builds bricks from saved backups and pins the ones it uses. */
  let hooks: {
    onArchiveSaved?: (meta: SavedBackupMeta, files: { dataPath: string; backupPath: string }) => void;
    pinnedArchiveIds?: () => Set<string>;
  } = {};
  function pinned(): Set<string> {
    const out = new Set<string>();
    try {
      for (const id of hooks.pinnedArchiveIds?.() ?? []) out.add(id);
    } catch {
      /* the hook never fails a backup */
    }
    // The backup a move is carrying stays until the move ends.
    const moving = opts.migrate?.pause.pinnedArchiveId();
    if (moving) out.add(moving);
    return out;
  }
  const NO_KEYS =
    "an admin device of your account hasn't approved backups for this server yet: open this server in the Flagship app on an admin device";

  async function state(): Promise<SavedState> {
    if (!savedState) savedState = await store!.loadState();
    return savedState;
  }

  async function diskBytes(): Promise<number> {
    if (opts.saved?.diskBytes) return opts.saved.diskBytes(opts.saved.dir);
    const s = await statfsNearest(opts.saved!.dir);
    return Number(s.blocks) * Number(s.bsize);
  }

  /** Drop saved backups the schedule no longer keeps. */
  async function applyRetention(): Promise<void> {
    const s = await state();
    const all = await store!.list();
    const keep = retained(all.map((m) => ({ id: m.archiveId, createdAt: m.createdAt })), s.schedule);
    const held = pinned();
    for (const m of all) {
      if (keep.has(m.archiveId) || held.has(m.archiveId)) continue;
      await store!.remove(m.archiveId);
      links.delete(m.archiveId);
    }
  }

  /**
   * Room for a new saved backup: drop the oldest saved ones (never the newest)
   * while the disk is short, or while saved backups would take more than their
   * share of the disk.
   */
  async function makeRoomForSaved(need: number, estimate: number): Promise<number> {
    const share = opts.saved?.maxDiskShare ?? 0.5;
    const cap = share * (await diskBytes());
    let all = await store!.list();
    let have = await free(opts.dir);
    const held = pinned();
    const used = () => all.reduce((n, m) => n + m.bytes + m.backupBytes, 0);
    while (have < need || used() + estimate > cap) {
      // The oldest that is neither the newest nor in use by the peer engine.
      const oldest = [...all.slice(1)].reverse().find((m) => !held.has(m.archiveId));
      if (!oldest) break;
      await store!.remove(oldest.archiveId);
      links.delete(oldest.archiveId);
      note("server.backup.removed", `Removed the backup from ${new Date(oldest.createdAt).toISOString().slice(0, 10)} to make room for a new one.`);
      all = all.filter((m) => m.archiveId !== oldest.archiveId);
      have = await free(opts.dir);
    }
    return have;
  }

  function savedStem(at: number): string {
    const label = (opts.build.serverFqdn.split(".")[0] ?? "").replace(/[^A-Za-z0-9-]/g, "") || "server";
    const iso = new Date(at).toISOString();
    return `${label}-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  }

  /** Start a saved backup now (Back up now, or the schedule). */
  async function runSaved(trigger: "schedule" | "now", purpose: "backup" | "migrate" = "backup"): Promise<HttpResponse> {
    if (!store) return err(404, "this server doesn't keep backups");
    if (running) return err(409, "a backup or restore is already running here");
    if (purpose === "migrate" && !opts.migrate) return err(404, "this server can't be moved yet: update it first");
    const s = await state();
    const k = keyPool[0];
    if (!k) return err(409, NO_KEYS, { code: "no-keys" });
    // Migrate: pause every app first, so nothing is written after the backup.
    if (purpose === "migrate") await opts.migrate!.pause.pause();
    // The key leaves the pool (on disk) before it is used, so it is never used twice.
    keyPool = keyPool.slice(1);
    await store.saveKeys(keyPool);
    s.usedIds.push(k.archiveId);
    const startedAt = now();
    if (trigger === "schedule") {
      const slot = slotStartAtOrBefore(s.schedule, startedAt);
      s.history.triesThisSlot = s.history.triesSlot === slot ? s.history.triesThisSlot + 1 : 1;
      s.history.triesSlot = slot;
    }
    s.history.lastAttemptAt = startedAt;
    await store.saveState(s);
    running = true;
    const job = { archiveId: k.archiveId, trigger, startedAt, progress: { done: 0, total: 0, app: "" } } as NonNullable<typeof savedJob>;
    savedJob = job;
    const key = randomBytes(32);
    const kek = Buffer.from(k.kekHex, "hex");
    const stem = savedStem(startedAt);
    const dir = store.buildingDir(k.archiveId);
    void (async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const slot = wrapAccountSlot(k.archiveId, key, kek, randomBytes(12));
      kek.fill(0);
      return makeArchive({
        archiveId: k.archiveId,
        key,
        slots: [slot],
        dataPath: join(dir, SAVED_DATA_FILE),
        backupPath: join(dir, SAVED_BACKUP_FILE),
        dataName: `${stem}.flagship-data`,
        job,
        makeRoom: makeRoomForSaved,
      });
    })()
      .then(async (r) => {
        // "Saved" means read back and opened, not just written.
        try {
          await checkDataFile(join(dir, SAVED_DATA_FILE), key, k.archiveId, { bytes: r.bytes, sha256: r.sha256 });
        } catch (e) {
          throw new Error(`the backup was written but did not pass its check, so it was not kept: ${(e as Error).message}`);
        }
        const meta: SavedBackupMeta = {
          archiveId: k.archiveId,
          createdAt: startedAt,
          checkedAt: now(),
          trigger,
          bytes: r.bytes,
          sha256: r.sha256,
          backupBytes: r.backupBytes,
          bundleFileName: `${stem}.flagship`,
          bundleBytes: BACKUP_BUNDLE_HEADER_BYTES + r.backupBytes + r.bytes,
          bundleSha256: r.bundleSha256,
          backupFileName: `${stem}.flagship-backup`,
          dataFileName: `${stem}.flagship-data`,
          apps: r.apps,
          left: r.left,
        };
        await store.commit(meta);
        if (purpose === "migrate") await opts.migrate!.pause.setArchive(meta.archiveId);
        s.history.lastOk = true;
        s.lastRun = { at: startedAt, ok: true, trigger, archiveId: k.archiveId };
        await store.saveState(s);
        try {
          hooks.onArchiveSaved?.(meta, {
            dataPath: join(store.entryDir(meta.archiveId), SAVED_DATA_FILE),
            backupPath: join(store.entryDir(meta.archiveId), SAVED_BACKUP_FILE),
          });
        } catch (e) {
          log(`[server-archive] the saved-backup hook failed: ${(e as Error).message}`);
        }
        await applyRetention();
        note(
          "server.backup.created",
          `${trigger === "schedule" ? "Scheduled backup" : "Backup"} saved and checked on this server: ${r.apps.length} app${r.apps.length === 1 ? "" : "s"}.` +
            (r.left.length > 0 ? ` Left out: ${r.left.map((x) => x.name).join(", ")} (no source to rebuild from).` : ""),
          r.left.length === 0,
        );
        log(`[server-archive] saved backup ${k.archiveId} ready (${r.bytes} bytes)`);
      })
      .catch(async (e: Error) => {
        const reason = e.message || "the backup couldn't be made";
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        s.history.lastOk = false;
        s.lastRun = { at: startedAt, ok: false, trigger, reason };
        await store.saveState(s).catch(() => {});
        note("server.backup.failed", `The ${trigger === "schedule" ? "scheduled " : ""}backup failed: ${reason}`, false);
        log(`[server-archive] saved backup failed: ${reason}`);
        if (purpose === "migrate") await opts.migrate!.pause.resume("The backup for the move failed, so this server's apps are running again.").catch(() => {});
      })
      .finally(async () => {
        key.fill(0);
        savedJob = null;
        running = false;
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      });
    return json(202, { archiveId: k.archiveId });
  }

  async function savedView() {
    const s = await state();
    const backups = await store!.list();
    const t = now();
    const active = opts.saved?.scheduleActive ? opts.saved.scheduleActive() : true;
    return {
      schedule: s.schedule,
      /** False while the backup policy isn't phone-side: the schedule doesn't run (Back up now still does). */
      scheduleActive: active,
      nextRunAt: keyPool.length === 0 || !active ? null : nextRunAt(s.schedule, s.history, t),
      lastRun: s.lastRun,
      running: savedJob
        ? { archiveId: savedJob.archiveId, trigger: savedJob.trigger, startedAt: savedJob.startedAt, progress: savedJob.progress, ...(savedJob.estimatedBytes !== undefined ? { estimatedBytes: savedJob.estimatedBytes } : {}) }
        : null,
      keysLeft: keyPool.length,
      /** Set while Migrate has this server's apps paused. */
      migratePause: opts.migrate?.pause.current() ?? null,
      /** How many keys the apps should send (one approval), 0 while the pool is full enough. */
      keysWanted: keyPool.length < KEY_POOL_LOW ? Math.min(400, KEY_POOL_MAX - keyPool.length) : 0,
      ...(keyPool.length === 0 && s.schedule.frequency !== "off" ? { waitingReason: NO_KEYS } : {}),
      usedBytes: backups.reduce((n, m) => n + m.bytes + m.backupBytes, 0),
      backups,
    };
  }

  async function putSchedule(req: HttpRequest): Promise<HttpResponse> {
    let body: unknown;
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return err(400, "invalid json");
    }
    const parsed = parseSchedule(body);
    if (typeof parsed === "string") return err(400, parsed);
    const s = await state();
    s.schedule = parsed;
    await store!.saveState(s);
    await applyRetention();
    note(
      "server.backup.schedule",
      parsed.frequency === "off"
        ? "Scheduled backups were turned off."
        : `Scheduled backups: ${parsed.frequency}, keeping ${parsed.keepDaily} daily and ${parsed.keepWeekly} weekly.`,
    );
    return json(200, await savedView());
  }

  async function depositKeys(req: HttpRequest): Promise<HttpResponse> {
    let b: { deposit?: unknown; signature?: unknown; keys?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    const d: ArchiveKeysDeposit | null = parseArchiveKeysDeposit(b.deposit);
    const keys = parseArchiveKeys(b.keys);
    if (!d || !keys || typeof b.signature !== "string" || !/^[0-9a-f]{128}$/.test(b.signature)) return err(400, "malformed keys");
    if (d.serverDomain !== opts.build.serverFqdn) return err(403, "these keys are for a different server");
    if (d.count !== keys.length || d.digest !== archiveKeysDigest(keys)) return err(400, "the keys don't match their signature");
    if (Math.abs(now() - d.issuedAt) > 10 * 60_000) return err(403, "the approval is stale: approve again");
    if (!opts.saved!.authorizeKeys(d, Buffer.from(b.signature, "hex"))) return err(403, "only an admin device of this account can approve backups");
    const s = await state();
    const have = new Set([...keyPool.map((k) => k.archiveId), ...s.usedIds]);
    const fresh = keys.filter((k) => !have.has(k.archiveId));
    keyPool = [...keyPool, ...fresh].slice(0, KEY_POOL_MAX);
    await store!.saveKeys(keyPool);
    return json(200, await savedView());
  }

  /** The schedule's tick: start a run when one is due. */
  async function tick(): Promise<void> {
    if (!store || running || keyPool.length === 0) return;
    if (opts.saved?.scheduleActive && !opts.saved.scheduleActive()) return;
    const s = await state();
    if (!isDue(s.schedule, s.history, now())) return;
    await runSaved("schedule");
  }

  async function handleSaved(path: string, method: string, req: HttpRequest): Promise<HttpResponse> {
    if (!store) return err(404, "this server doesn't keep backups");
    const rest = path.slice(SAVED_PATH.length);
    if (rest === "" && method === "GET") return json(200, await savedView());
    if (rest === "/schedule" && method === "PUT") return putSchedule(req);
    if (rest === "/keys" && method === "POST") return depositKeys(req);
    if (rest === "/run" && method === "POST") {
      let purpose: "backup" | "migrate" = "backup";
      try {
        const b = req.body.length > 0 ? (JSON.parse(req.body.toString("utf8")) as { purpose?: unknown }) : {};
        if (b.purpose === "migrate") purpose = "migrate";
      } catch {
        return err(400, "invalid json");
      }
      return runSaved("now", purpose);
    }
    if (rest === "/resume" && method === "POST") {
      if (!opts.migrate) return err(404, "not found");
      await opts.migrate.pause.resume("The move was stopped, so this server's apps are running again.");
      return json(200, await savedView());
    }
    if (rest === "/estimate" && method === "GET") {
      const est = await estimateServerArchive(opts.build);
      return json(200, { archiveBytes: est?.archiveBytes ?? null, apps: opts.build.apps().length });
    }
    const m = /^\/([0-9a-f]{32})(\/backup-file|\/chunk|\/bundle|\/link)?$/.exec(rest);
    if (!m) return err(404, "not found");
    const id = m[1]!;
    const sub = m[2] ?? "";
    if (sub === "" && method === "DELETE") {
      if (savedJob?.archiveId === id) return err(409, "the backup is still being made");
      if (!(await savedById(id))) return err(404, "that backup isn't on this server");
      if (pinned().has(id)) return err(409, "this backup is the one kept on other servers right now, so it can't be deleted until a newer one replaces it");
      await store.remove(id);
      links.delete(id);
      note("server.backup.removed", "A saved backup was deleted.");
      return json(200, await savedView());
    }
    if (sub === "/backup-file" && method === "GET") return backupFileResponse(await savedById(id));
    if (sub === "/chunk" && method === "GET") return chunk(await savedById(id), req);
    if (sub === "/bundle" && method === "GET") return bundleChunk(await savedById(id), req);
    if (sub === "/link" && method === "POST") return mintLink(await savedById(id));
    return err(405, "method not allowed");
  }

  function backupView() {
    if (!backup) return null;
    return {
      archiveId: backup.archiveId,
      state: backup.state,
      startedAt: backup.startedAt,
      progress: backup.progress,
      backupFileName: backupFileName(opts.build.serverFqdn, backup.startedAt),
      dataFileName: dataFileName(opts.build.serverFqdn, backup.startedAt),
      ...(backup.bytes !== undefined ? { bytes: backup.bytes } : {}),
      ...(backup.backupBytes !== undefined ? { backupBytes: backup.backupBytes } : {}),
      ...(backup.bytes !== undefined && backup.backupBytes !== undefined
        ? {
            bundleFileName: backupBundleFileName(dataFileName(opts.build.serverFqdn, backup.startedAt)),
            bundleBytes: BACKUP_BUNDLE_HEADER_BYTES + backup.backupBytes + backup.bytes,
            bundleSha256: backup.bundleSha256 ?? "",
          }
        : {}),
      ...(backup.estimatedBytes !== undefined ? { estimatedBytes: backup.estimatedBytes } : {}),
      ...(backup.sha256 ? { sha256: backup.sha256 } : {}),
      ...(backup.apps ? { apps: backup.apps } : {}),
      ...(backup.left ? { left: backup.left } : {}),
      ...(backup.reason ? { reason: backup.reason } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  function waiting() {
    const w = opts.wait?.current();
    return w ? { archiveId: w.order.archiveId, bytes: w.order.bytes, sha256: w.order.sha256 } : null;
  }

  async function uploadedBytes(): Promise<number> {
    try {
      return (await stat(uploadFile)).size;
    } catch {
      return 0;
    }
  }

  async function startRestore(req: HttpRequest): Promise<HttpResponse> {
    let b: { archiveId?: unknown; bytes?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    const w = waiting();
    if (!w) return err(409, "this server isn't waiting for a backup", { code: "not-waiting" });
    if (b.archiveId !== w.archiveId || b.bytes !== w.bytes) {
      return err(409, "this server is waiting for a different backup", { code: "other-backup" });
    }
    if (running) return err(409, "a backup or restore is already running here");
    const capRefusal = opts.admitIncoming?.(w.bytes) ?? null;
    if (capRefusal) return err(507, capRefusal, { code: "over-backup-limit" });
    // An upload of this backup already under way (the app closed, or the box
    // restarted): carry on from where it stopped.
    if (restore && restore.archiveId === w.archiveId && (restore.state === "uploading" || restore.state === "ready")) {
      return json(202, { archiveId: w.archiveId, received: restore.received });
    }
    await ensureDir(uploadDir);
    const have = await uploadedBytes();
    const received = have <= w.bytes ? have : 0;
    if (received === 0) await rm(uploadFile, { force: true }).catch(() => {});
    // The data file, then the same again unpacked, with room to spare.
    if ((await free(uploadDir)) + received < w.bytes * 2.2 + MIN_FREE_BYTES / 4) {
      return err(507, "this server doesn't have enough free disk space for that backup");
    }
    restore = {
      archiveId: w.archiveId,
      state: received === w.bytes ? "ready" : "uploading",
      bytes: w.bytes,
      received,
      apps: [],
      startedAt: now(),
    };
    return json(202, { archiveId: w.archiveId, received });
  }

  async function putChunk(req: HttpRequest): Promise<HttpResponse> {
    if (!restore || restore.state !== "uploading") return err(409, "no restore is waiting for data");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const offset = Number(q.get("offset") ?? "");
    if (!Number.isSafeInteger(offset) || offset !== restore.received) {
      return err(409, "chunk out of order", { received: restore.received });
    }
    if (req.body.length === 0 || req.body.length > ARCHIVE_CHUNK_BYTES || offset + req.body.length > restore.bytes) return err(400, "bad chunk size");
    const fh = await open(uploadFile, offset === 0 ? "w" : "r+", 0o600);
    try {
      await fh.write(req.body, 0, req.body.length, offset);
      await fh.sync();
    } finally {
      await fh.close();
    }
    restore.received += req.body.length;
    if (restore.received === restore.bytes) restore.state = "ready";
    return json(200, { received: restore.received, ready: restore.state === "ready" });
  }

  async function sha256Of(path: string): Promise<string> {
    const h = createHash("sha256");
    await pipeline(createReadStream(path), async function* (src: AsyncIterable<Buffer>) {
      for await (const d of src) h.update(d);
    });
    return h.digest("hex");
  }

  async function commitRestore(req: HttpRequest): Promise<HttpResponse> {
    const w = waiting();
    if (!w) return err(409, "this server isn't waiting for a backup", { code: "not-waiting" });
    if (!restore || restore.state !== "ready" || restore.archiveId !== w.archiveId) return err(409, "upload the whole data file first");
    let b: { key?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    if (typeof b.key !== "string" || !/^[0-9a-f]{64}$/.test(b.key)) return err(400, "key must be 32 bytes of lowercase hex");
    if (running) return err(409, "a backup or restore is already running here");
    running = true;
    const job = restore;
    job.state = "checking";
    job.reason = undefined;
    const key = Buffer.from(b.key, "hex");
    opts.wait?.setRestoring(true);
    note("server.restore.started", "Restoring this server's backup.");
    void (async () => {
      try {
        // The file must be the one the owner signed for this server, before
        // any of it is opened.
        if ((await uploadedBytes()) !== w.bytes || (await sha256Of(uploadFile)) !== w.sha256) {
          await rm(uploadFile, { force: true }).catch(() => {});
          throw new ArchiveError("the data file isn't the one this server is waiting for (its size or SHA-256 differs): send it again");
        }
        const contents = await unpackArchive({ ...opts.restore, workDir: scratch }, uploadFile, key, w.archiveId, unpackDir);
        await rm(uploadFile, { force: true }).catch(() => {});
        job.apps = contents.metas.map((m) => ({ serviceId: m.serviceId, name: m.name, state: "waiting" as const }));
        job.state = "restoring";
        const results = await installArchive({ ...opts.restore, workDir: scratch }, unpackDir, contents, (r) => {
          job.apps = r.map((x) => ({ ...x }));
        });
        job.apps = results;
        job.state = "done";
        await opts.wait?.finish(w.archiveId);
        const ok = results.filter((r) => r.state === "done").length;
        const failed = results.filter((r) => r.state === "failed").length;
        const failedText = results
          .filter((r) => r.state === "failed")
          .map((r) => `${r.name} (${(r.reason ?? "it couldn't be restored").replace(/[.\s]+$/, "")})`)
          .join(", ");
        note(
          "server.restore.finished",
          `Backup restored: ${ok} app${ok === 1 ? "" : "s"}.` + (failed > 0 ? ` Couldn't restore: ${failedText}.` : ""),
          failed === 0,
        );
      } catch (e) {
        job.state = "failed";
        job.reason = e instanceof ArchiveError ? e.message : `the restore failed: ${(e as Error).message}`;
        // A data file that doesn't open has to be sent again.
        await rm(uploadFile, { force: true }).catch(() => {});
        opts.wait?.setRestoring(false);
        note("server.restore.failed", `${job.reason}. This server is still waiting for its backup.`, false);
        log(`[server-archive] restore failed: ${job.reason}`);
      } finally {
        key.fill(0);
        running = false;
        await rm(unpackDir, { recursive: true, force: true }).catch(() => {});
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return json(202, { archiveId: job.archiveId });
  }

  // -------------------------------------------------------------------------
  // Migrate on the archive path (docs/server-migration.md, "Data path")
  // -------------------------------------------------------------------------

  /** `POST .../server-restore/order`: a restore order sent after pairing, on a server with no apps yet. */
  async function lateOrder(req: HttpRequest): Promise<HttpResponse> {
    if (!opts.wait) return err(404, "this server can't take a backup");
    let b: { order?: unknown; signatureHex?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    if (opts.build.apps().length > 0 && !waiting()) {
      return err(409, "this server already has apps, so it can't take a whole server's backup: use a new server", { code: "has-apps" });
    }
    const refused = await opts.wait.adoptOrder(b.order, b.signatureHex);
    if (refused) return err(/admin device|different server/.test(refused) ? 403 : 409, refused);
    return json(200, restoreView());
  }

  /**
   * `POST .../server-restore/pull { url, requestId }`: fetch the backup this
   * server waits for straight from the old server's approved download link
   * (`<url>/bundle?r=<requestId>`), its data part only, resuming where the
   * upload stands. The commit checks its size and SHA-256 as for an upload.
   */
  async function pull(req: HttpRequest): Promise<HttpResponse> {
    let b: { url?: unknown; requestId?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    const w = waiting();
    if (!w) return err(409, "this server isn't waiting for a backup", { code: "not-waiting" });
    if (typeof b.url !== "string" || !/^https:\/\/[a-z0-9.-]+\/api\/archive-download\/[0-9a-f]{64}$/.test(b.url)) return err(400, "url must be a server's backup download link");
    if (typeof b.requestId !== "string" || !/^[0-9a-f]{32}$/.test(b.requestId)) return err(400, "requestId must be 16 bytes of lowercase hex");
    const started = await startRestore({ ...req, body: Buffer.from(JSON.stringify({ archiveId: w.archiveId, bytes: w.bytes })) });
    if (started.status !== 202) return started;
    const job = restore!;
    if (job.state === "ready") return json(202, { archiveId: w.archiveId, received: job.received });
    if (pulling) return json(202, { archiveId: w.archiveId, received: job.received });
    pulling = true;
    job.reason = undefined;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const src = `${b.url}/bundle?r=${b.requestId}`;
    void (async () => {
      const head = await fetchImpl(src, { headers: { range: `bytes=0-${BACKUP_BUNDLE_HEADER_BYTES - 1}` } });
      if (head.status !== 206 && head.status !== 200) throw new ArchiveError(`the old server refused the download (${head.status})`);
      const headBytes = new Uint8Array(await head.arrayBuffer()).subarray(0, BACKUP_BUNDLE_HEADER_BYTES);
      const total = Number(/\/(\d+)$/.exec(head.headers.get("content-range") ?? "")?.[1] ?? head.headers.get("content-length") ?? 0);
      const parts = parseBackupBundleHeader(headBytes, total);
      if (parts.dataLength !== job.bytes) throw new ArchiveError("the old server's backup isn't the one this server is waiting for (its size differs)");
      const from = parts.dataOffset + job.received;
      const res = await fetchImpl(src, { headers: { range: `bytes=${from}-` } });
      if (res.status !== 206 || !res.body) throw new ArchiveError(`the old server didn't resume the download (${res.status})`);
      const fh = await open(uploadFile, job.received === 0 ? "w" : "r+", 0o600);
      try {
        let at = job.received;
        for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (at + c.length > job.bytes) throw new ArchiveError("the old server sent more than the backup holds");
          await fh.write(c, 0, c.length, at);
          at += c.length;
          job.received = at;
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (job.received !== job.bytes) throw new ArchiveError("the download from the old server stopped early: it resumes when you try again");
      job.state = "ready";
      note("server.restore.pulled", "The backup arrived from the old server.");
    })()
      .catch((e: Error) => {
        job.reason = e instanceof ArchiveError || e instanceof Error ? e.message : String(e);
        log(`[server-archive] pull failed: ${job.reason}`);
      })
      .finally(() => {
        pulling = false;
      });
    return json(202, { archiveId: w.archiveId, received: job.received });
  }

  /** The peer engine's fetch of a lost server's backup from the bricks on other servers (setPeerFetcher). */
  let peerFetcher:
    | ((w: { serverId: string; pbk: Uint8Array; archiveId: string; bytes: number; sha256: string; outPath: string; onProgress?: (received: number) => void }) => Promise<{ dataPath: string }>)
    | null = null;

  /**
   * `POST .../server-restore/from-peers { serverId, pbkHex }`: the backup this
   * server waits for comes from the peer engine instead of an upload (the
   * lost server's id and its PBK from the owner's device). The commit checks
   * it as for an upload.
   */
  async function fromPeers(req: HttpRequest): Promise<HttpResponse> {
    if (!peerFetcher) return err(404, "this server can't restore from peer backups");
    let b: { serverId?: unknown; pbkHex?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    const w = waiting();
    if (!w) return err(409, "this server isn't waiting for a backup", { code: "not-waiting" });
    if (typeof b.serverId !== "string" || !/^[a-z0-9.-]+$/.test(b.serverId)) return err(400, "serverId must be the lost server's address");
    if (typeof b.pbkHex !== "string" || !/^[0-9a-f]{64}$/.test(b.pbkHex)) return err(400, "pbkHex must be 32 bytes of lowercase hex");
    const started = await startRestore({ ...req, body: Buffer.from(JSON.stringify({ archiveId: w.archiveId, bytes: w.bytes })) });
    if (started.status !== 202) return started;
    const job = restore!;
    if (job.state === "ready" || pulling) return json(202, { archiveId: w.archiveId, received: job.received });
    pulling = true;
    job.reason = undefined;
    const fetcher = peerFetcher;
    const pbk = Buffer.from(b.pbkHex, "hex");
    void (async () => {
      const out = await fetcher({
        serverId: b.serverId as string,
        pbk,
        archiveId: w.archiveId,
        bytes: w.bytes,
        sha256: w.sha256,
        outPath: uploadFile,
        onProgress: (n) => {
          job.received = Math.min(n, job.bytes);
        },
      });
      if (out.dataPath !== uploadFile) await rename(out.dataPath, uploadFile);
      if ((await uploadedBytes()) !== job.bytes) throw new ArchiveError("the backup from other servers came back the wrong size");
      job.received = job.bytes;
      job.state = "ready";
      note("server.restore.pulled", "The backup arrived from the servers keeping its pieces.");
    })()
      .catch((e: Error) => {
        job.reason = e.message || "the backup couldn't be fetched from other servers";
        log(`[server-archive] from-peers failed: ${job.reason}`);
      })
      .finally(() => {
        pbk.fill(0);
        pulling = false;
      });
    return json(202, { archiveId: w.archiveId, received: job.received });
  }

  /** `POST .../server-restore/probe { url }`: how fast this server reads from the old one (for the downtime estimate). */
  async function probe(req: HttpRequest): Promise<HttpResponse> {
    let b: { url?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    if (typeof b.url !== "string" || !/^https:\/\/[a-z0-9.-]+\/api\/archive-probe\/[0-9a-f]{64}$/.test(b.url)) return err(400, "url must be a server's probe link");
    const fetchImpl = opts.fetchImpl ?? fetch;
    const t0 = now();
    let n = 0;
    try {
      const res = await fetchImpl(b.url);
      if (res.status !== 200 || !res.body) return err(502, `the old server didn't answer the speed check (${res.status})`);
      for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) n += c.length;
    } catch (e) {
      return err(502, `the old server couldn't be reached: ${(e as Error).message}`);
    }
    const ms = Math.max(1, now() - t0);
    return json(200, { bytes: n, ms, bytesPerSecond: Math.round((n * 1000) / ms) });
  }

  /** Probe links on the old server: a few MiB of zeros for the new one to time. */
  const probes = new Map<string, number>();
  const PROBE_BYTES = 8 * 1024 * 1024;
  function mintProbe(): HttpResponse {
    const token = randomBytes(32).toString("hex");
    probes.set(token, now() + 10 * 60_000);
    return json(200, { path: `${PROBE_PATH}${token}`, bytes: PROBE_BYTES });
  }
  function serveProbe(path: string): HttpResponse | null {
    if (!path.startsWith(PROBE_PATH)) return null;
    const token = path.slice(PROBE_PATH.length);
    const until = probes.get(token);
    if (!until || until < now()) return err(404, "this speed-check link has expired");
    probes.delete(token);
    const zero = Buffer.alloc(1024 * 1024);
    return {
      status: 200,
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
      body: "",
      stream: {
        length: PROBE_BYTES,
        open: () =>
          Readable.from(
            (function* () {
              for (let i = 0; i < PROBE_BYTES / zero.length; i++) yield zero;
            })(),
          ),
      },
    };
  }
  function restoreView() {
    const r = restore
      ? {
          archiveId: restore.archiveId,
          state: restore.state,
          bytes: restore.bytes,
          received: restore.received,
          apps: restore.apps,
          startedAt: restore.startedAt,
          pulling,
          ...(restore.reason ? { reason: restore.reason } : {}),
        }
      : null;
    return { waiting: waiting(), restore: r };
  }

  return {
    async handle(path: string, method: string, req: HttpRequest, ctx: { companion: boolean }): Promise<HttpResponse | null> {
      if (!isServerArchivePath(path)) return null;
      if (ctx.companion) return err(403, "companion sessions can't back up or restore a server: open your owner app", { code: "companion-write-not-allowed" });
      await sweep();
      if (path === SAVED_PATH || path.startsWith(`${SAVED_PATH}/`)) return handleSaved(path, method, req);
      switch (`${method} ${path}`) {
        case `POST ${ARCHIVE_PATH}/start`:
          return startBackup(req);
        case `GET ${ARCHIVE_PATH}`:
          return json(200, { archive: backupView() });
        case `GET ${ARCHIVE_PATH}/backup-file`:
          return backupFileResponse(manualDownloadable());
        case `GET ${ARCHIVE_PATH}/chunk`:
          return chunk(manualDownloadable(), req);
        case `GET ${ARCHIVE_PATH}/bundle`:
          return bundleChunk(manualDownloadable(), req);
        case `POST ${ARCHIVE_PATH}/link`:
          return mintLink(manualDownloadable());
        case `POST ${ARCHIVE_PATH}/approve`:
          return approve(req);
        case `DELETE ${ARCHIVE_PATH}`:
          if (backup?.state === "building") return err(409, "the backup is still being made");
          if (backup) links.delete(backup.archiveId);
          backup = null;
          await dropBackupFiles();
          return json(200, { ok: true });
        case `POST ${RESTORE_PATH}/order`:
          return lateOrder(req);
        case `POST ${RESTORE_PATH}/pull`:
          return pull(req);
        case `POST ${RESTORE_PATH}/probe`:
          return probe(req);
        case `POST ${RESTORE_PATH}/from-peers`:
          return fromPeers(req);
        case `POST ${ARCHIVE_PATH}/probe-link`:
          return mintProbe();
        case `POST ${RESTORE_PATH}/start`:
          return startRestore(req);
        case `POST ${RESTORE_PATH}/chunk`:
          return putChunk(req);
        case `POST ${RESTORE_PATH}/commit`:
          return commitRestore(req);
        case `GET ${RESTORE_PATH}`:
          return json(200, restoreView());
        default:
          return err(405, "method not allowed");
      }
    },
    /** `GET|HEAD /api/archive-download/<token>`: mount OUTSIDE the session gate. */
    handleDownload,
    /** Drop the files a previous run left behind (a restart ends a running backup).
     *  A restore's upload survives while this server still waits for it. */
    async init(): Promise<void> {
      await rm(opts.dir, { recursive: true, force: true }).catch(() => {});
      if (!opts.wait?.current()) await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
      if (store) {
        await store.init();
        savedState = await store.loadState();
        keyPool = await store.loadKeys();
      }
    },
    /** One look at the schedule (the daemon calls it every few minutes). */
    tick,
    /** The peer engine plugs in here: told of each saved backup, and asked which it still needs. */
    setSavedHooks(h: typeof hooks): void {
      hooks = h;
    },
    /** The peer engine plugs in its fetch of a lost server's backup (POST .../server-restore/from-peers). */
    setPeerFetcher(fn: typeof peerFetcher): void {
      peerFetcher = fn;
    },
    /** Check the schedule every `everyMs` (default 5 minutes) until stopped. */
    startSchedule(everyMs = 5 * 60_000): () => void {
      const t = setInterval(() => void tick().catch((e: Error) => log(`[server-archive] schedule tick failed: ${e.message}`)), everyMs);
      if (typeof t.unref === "function") t.unref();
      return () => clearInterval(t);
    },
    /** Wait for a running job (tests). */
    async settle(): Promise<void> {
      while (running) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

export type ServerArchiveService = ReturnType<typeof buildServerArchiveService>;
