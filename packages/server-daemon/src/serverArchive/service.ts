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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  archiveDownloadCode,
  parseArchiveDownloadApproval,
  parseBackupSlots,
  type ArchiveDownloadApproval,
  type BackupBody,
  type BackupSlot,
} from "@flagship/protocol";
import { renderDownloadPage } from "./downloadPage.js";
import { mkdir, open, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { ARCHIVE_EXCLUDES, ARCHIVE_INCLUDES, buildServerArchive, estimateServerArchive, type ArchiveBuildDeps } from "./build.js";
import { ARCHIVE_FRAME_BYTES, ArchiveError, writeBackupFile } from "./format.js";
import { installArchive, unpackArchive, type ArchiveRestoreDeps, type RestoreAppResult } from "./restore.js";
import type { RestoreWait } from "./restoreWait.js";

export const ARCHIVE_PATH = "/api/screens/server-archive";
export const DOWNLOAD_PATH = "/api/archive-download/";
export const RESTORE_PATH = "/api/screens/server-restore";
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
  /** What the box expects the data file to take, once it has sized it. */
  estimatedBytes?: number;
  apps?: Array<{ serviceId: string; name: string }>;
  /** Apps that couldn't go in (no source, no public image), with why. */
  left?: Array<{ serviceId: string; name: string; reason: string }>;
  reason?: string;
  /** Download-link token (hex), minted on request; dies with the backup. */
  linkToken?: string;
  downloadedNoted?: boolean;
  /** Browser requests the owner approved with a signature. */
  approved?: Set<string>;
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

  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra });
  const free = opts.freeBytes ?? (async (dir: string) => {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  });

  async function ensureDir(dir: string = opts.dir): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async function dropBackupFiles(): Promise<void> {
    await rm(dataFile, { force: true }).catch(() => {});
    await rm(backupFile, { force: true }).catch(() => {});
  }

  async function sweep(): Promise<void> {
    if (backup && backup.state !== "building" && now() - backup.startedAt > KEEP_MS) {
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
      if (running) return err(409, "a backup or restore is already running here");
      await ensureDir();
      if ((await free(opts.dir)) < MIN_FREE_BYTES) return err(507, "this server doesn't have enough free disk space to make a backup");
      running = true;
      const job: BackupJob = { archiveId: b.archiveId, state: "building", startedAt: now(), progress: { done: 0, total: 0, app: "" } };
      backup = job;
      await dropBackupFiles();
      note("server.backup.started", "Started a backup of this server.");
      const key = Buffer.from(b.key, "hex");
      const archiveId = b.archiveId;
      void (async () => {
        // Size it first: the data file, one app's scratch, and headroom so
        // the apps keep working. A box that can't size something goes ahead
        // on the flat minimum it already passed.
        job.progress = { done: 0, total: 0, app: "Checking free space" };
        const est = await estimateServerArchive({ ...opts.build, workDir: scratch });
        if (est) {
          job.estimatedBytes = est.archiveBytes;
          const need = est.archiveBytes + est.largestAppBytes + HEADROOM_BYTES;
          const have = await free(opts.dir);
          if (have < need) {
            throw new NotEnoughSpace(
              `this server needs about ${gb(need)} free to make this backup and has ${gb(have)}. Free some space (or remove apps you don't need) and try again`,
            );
          }
        }
        const r = await buildServerArchive(
          { ...opts.build, workDir: scratch },
          {
            archiveId,
            key,
            outPath: dataFile,
            onProgress: (done, total, app) => {
              job.progress = { done, total, app };
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
          data: { fileName: dataFileName(fqdn, job.startedAt), bytes: r.bytes, sha256: r.sha256, frameBytes: ARCHIVE_FRAME_BYTES },
        };
        const written = await writeBackupFile(backupFile, { archiveId, key, slots, body, nonce: randomBytes(12) });
        return { ...r, backupBytes: written.bytes };
      })()
        .then((r) => {
          job.state = "ready";
          job.bytes = r.bytes;
          job.sha256 = r.sha256;
          job.backupBytes = r.backupBytes;
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

  async function chunk(req: HttpRequest): Promise<HttpResponse> {
    if (!backup || backup.state !== "ready") return err(404, "no backup is ready");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const offset = Number(q.get("offset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > (backup.bytes ?? 0)) return err(400, "bad offset");
    const len = Math.min(ARCHIVE_CHUNK_BYTES, (backup.bytes ?? 0) - offset);
    const buf = Buffer.alloc(len);
    const fh = await open(dataFile, "r");
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
    if (offset + len >= (backup.bytes ?? 0)) noteDownloaded(backup);
    return {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-flagship-archive-bytes": String(backup.bytes),
        "x-flagship-archive-sha256": backup.sha256 ?? "",
        "cache-control": "no-store",
      },
      body: buf,
    };
  }

  async function readBackupFile(): Promise<Buffer | null> {
    try {
      const fh = await open(backupFile, "r");
      try {
        return await fh.readFile();
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  async function backupFileResponse(job: BackupJob): Promise<HttpResponse> {
    const text = await readBackupFile();
    if (!text) return err(404, "no backup is ready");
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${backupFileName(opts.build.serverFqdn, job.startedAt)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
      body: text,
    };
  }

  function noteDownloaded(job: BackupJob): void {
    if (job.downloadedNoted) return;
    job.downloadedNoted = true;
    note("server.backup.downloaded", "The backup was downloaded.");
  }

  function mintLink(): HttpResponse {
    if (!backup || backup.state !== "ready") return err(404, "no backup is ready");
    backup.linkToken ??= randomBytes(32).toString("hex");
    return json(200, {
      path: `${DOWNLOAD_PATH}${backup.linkToken}`,
      backupFileName: backupFileName(opts.build.serverFqdn, backup.startedAt),
      dataFileName: dataFileName(opts.build.serverFqdn, backup.startedAt),
      bytes: backup.bytes,
      sha256: backup.sha256,
      expiresAt: backup.startedAt + KEEP_MS,
    });
  }

  function tokenMatches(job: BackupJob | null, token: string): job is BackupJob & { linkToken: string } {
    if (!job?.linkToken || !/^[0-9a-f]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(job.linkToken, "hex"), Buffer.from(token, "hex"));
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
    if (!backup || backup.state !== "ready" || a.archiveId !== backup.archiveId) return err(404, "that backup isn't ready on this server any more");
    if (a.serverDomain !== opts.build.serverFqdn) return err(403, "the approval is for a different server");
    if (Math.abs(now() - a.issuedAt) > 5 * 60_000) return err(403, "the approval is stale: approve again");
    if (!opts.authorizeDownload || !opts.authorizeDownload(a, Buffer.from(b.signature, "hex"))) return err(403, "invalid signature");
    (backup.approved ??= new Set()).add(a.requestId);
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
    if (!path.startsWith(DOWNLOAD_PATH)) return null;
    const [token = "", kind = "", ...more] = path.slice(DOWNLOAD_PATH.length).split("/");
    if (more.length > 0 || !["", "status", "file", "backup"].includes(kind)) return err(404, "not found");
    const method = req.method.toUpperCase();
    if (method !== "GET" && (method !== "HEAD" || kind !== "file")) return err(405, "method not allowed");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const r = q.get("r") ?? "";
    const validR = /^[0-9a-f]{32}$/.test(r);
    await sweep();
    const job = backup;
    if (!tokenMatches(job, token) || job.state !== "ready" || job.bytes === undefined) {
      return kind === ""
        ? html(404, "<!doctype html><meta charset=utf-8><title>Link expired</title><p>This download link has expired or was replaced by a newer backup.</p>")
        : err(404, "this download link has expired or was replaced by a newer backup");
    }
    const base = `${DOWNLOAD_PATH}${token}`;
    if (kind === "") {
      // A fresh request id per page, kept in the URL so a reload or a retry
      // keeps its approval.
      if (!validR) return { status: 303, headers: { location: `${base}?r=${randomBytes(16).toString("hex")}`, "cache-control": "no-store" }, body: "" };
      const appLinkBase = (opts.appLinkBase ?? "https://flagshipserver.com").replace(/\/+$/, "");
      return html(
        200,
        renderDownloadPage({
          appLink: `${appLinkBase}/app/backup-download#s=${encodeURIComponent(opts.build.serverFqdn)}&a=${job.archiveId}&r=${r}`,
          code: archiveDownloadCode(r),
          backupFileName: backupFileName(opts.build.serverFqdn, job.startedAt),
          dataFileName: dataFileName(opts.build.serverFqdn, job.startedAt),
          sizeText: gb(job.bytes),
          statusUrl: `${base}/status?r=${r}`,
          backupUrl: `${base}/backup?r=${r}`,
          fileUrl: `${base}/file?r=${r}`,
          expiresText: new Date(job.startedAt + KEEP_MS).toUTCString(),
        }),
      );
    }
    if (!validR) return err(400, "r must be 16 bytes of lowercase hex");
    const approved = job.approved?.has(r) === true;
    if (kind === "status") return json(200, { approved });
    if (!approved) return err(403, "this download hasn't been approved: scan the QR on the download page with the Flagship app");
    if (kind === "backup") return backupFileResponse(job);
    const size = job.bytes;
    const etag = `"${job.sha256 ?? job.archiveId}"`;
    const fileHeaders: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${dataFileName(opts.build.serverFqdn, job.startedAt)}"`,
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
    if (method === "GET" && end === size - 1) noteDownloaded(job);
    return {
      status: range ? 206 : 200,
      headers: { ...fileHeaders, ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) },
      body: "",
      stream: {
        length: size === 0 ? 0 : end - start + 1,
        open: () => createReadStream(dataFile, { start, end }),
      },
    };
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
        note("server.restore.finished", `Backup restored: ${ok} app${ok === 1 ? "" : "s"}${failed > 0 ? `, ${failed} failed` : ""}.`, failed === 0);
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

  function restoreView() {
    const r = restore
      ? {
          archiveId: restore.archiveId,
          state: restore.state,
          bytes: restore.bytes,
          received: restore.received,
          apps: restore.apps,
          startedAt: restore.startedAt,
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
      switch (`${method} ${path}`) {
        case `POST ${ARCHIVE_PATH}/start`:
          return startBackup(req);
        case `GET ${ARCHIVE_PATH}`:
          return json(200, { archive: backupView() });
        case `GET ${ARCHIVE_PATH}/backup-file`:
          return backup?.state === "ready" ? backupFileResponse(backup) : err(404, "no backup is ready");
        case `GET ${ARCHIVE_PATH}/chunk`:
          return chunk(req);
        case `POST ${ARCHIVE_PATH}/link`:
          return mintLink();
        case `POST ${ARCHIVE_PATH}/approve`:
          return approve(req);
        case `DELETE ${ARCHIVE_PATH}`:
          if (backup?.state === "building") return err(409, "the backup is still being made");
          backup = null;
          await dropBackupFiles();
          return json(200, { ok: true });
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
    },
    /** Wait for a running job (tests). */
    async settle(): Promise<void> {
      while (running) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

export type ServerArchiveService = ReturnType<typeof buildServerArchiveService>;
