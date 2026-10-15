/**
 * "Backup/clone server" on the box (owner sessions only, behind the screens gate).
 *
 * Backup:
 *   POST   /api/screens/server-archive/start   { archiveId, key }   → 202   (key = the phone's derived 32-byte key, hex)
 *   GET    /api/screens/server-archive                              → { archive: {...} | null }
 *   GET    /api/screens/server-archive/chunk?offset=N               → ≤ 4 MiB of the sealed file
 *   DELETE /api/screens/server-archive                              → forget it (and delete the file)
 * Import onto THIS server (any name; the apps install under it):
 *   POST   /api/screens/server-restore/start   { archiveId, bytes } → 202
 *   POST   /api/screens/server-restore/chunk?offset=N  (raw bytes)  → { received }
 *   POST   /api/screens/server-restore/commit  { key }              → 202
 *   GET    /api/screens/server-restore                              → status
 *
 * One backup and one import at a time. The file is sealed on the box with a
 * key only the owner's devices can derive (the box sees it only for the
 * minutes it needs it and never keeps it); the phone downloads it in chunks
 * (over the LAN when it can), the user keeps it wherever they like, and a
 * chunked upload puts it on the server it is imported into.
 */
import { createReadStream } from "node:fs";
import { mkdir, open, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { buildServerArchive, type ArchiveBuildDeps } from "./build.js";
import { ArchiveError, readHeader } from "./format.js";
import { installArchive, unpackArchive, type ArchiveRestoreDeps, type RestoreAppResult } from "./restore.js";
import { createHash } from "node:crypto";

export const ARCHIVE_PATH = "/api/screens/server-archive";
export const RESTORE_PATH = "/api/screens/server-restore";
export const ARCHIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60_000;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;

export function isServerArchivePath(path: string): boolean {
  return path === ARCHIVE_PATH || path.startsWith(`${ARCHIVE_PATH}/`) || path === RESTORE_PATH || path.startsWith(`${RESTORE_PATH}/`);
}

export interface ServerArchiveServiceOptions {
  /** `<dataDir>/archives`: the sealed file and the import's scratch. */
  dir: string;
  build: Omit<ArchiveBuildDeps, "workDir">;
  restore: Omit<ArchiveRestoreDeps, "workDir">;
  /** Activity feed: kind, one readable line, ok. */
  note?: (kind: string, detail: string, ok?: boolean) => void;
  freeBytes?: (dir: string) => Promise<number>;
  now?: () => number;
  log?: (m: string) => void;
}

interface BackupJob {
  archiveId: string;
  state: "building" | "ready" | "failed";
  startedAt: number;
  progress: { done: number; total: number; app: string };
  bytes?: number;
  sha256?: string;
  apps?: Array<{ serviceId: string; name: string }>;
  reason?: string;
}

interface RestoreJob {
  archiveId: string;
  state: "uploading" | "ready" | "opening" | "restoring" | "done" | "failed";
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
  const archiveFile = join(opts.dir, "server-archive.fsa");
  const uploadFile = join(opts.dir, "import.fsa");
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

  async function ensureDir(): Promise<void> {
    await mkdir(opts.dir, { recursive: true, mode: 0o700 });
  }

  async function sweep(): Promise<void> {
    if (backup && backup.state !== "building" && now() - backup.startedAt > KEEP_MS) {
      backup = null;
      await rm(archiveFile, { force: true }).catch(() => {});
    }
  }

  function startBackup(req: HttpRequest): Promise<HttpResponse> {
    return (async () => {
      let b: { archiveId?: unknown; key?: unknown };
      try {
        b = JSON.parse(req.body.toString("utf8")) as typeof b;
      } catch {
        return err(400, "invalid json");
      }
      if (typeof b.archiveId !== "string" || !/^[0-9a-f]{32}$/.test(b.archiveId)) return err(400, "archiveId must be 16 bytes of lowercase hex");
      if (typeof b.key !== "string" || !/^[0-9a-f]{64}$/.test(b.key)) return err(400, "key must be 32 bytes of lowercase hex");
      if (running) return err(409, "a backup or import is already running here");
      await ensureDir();
      if ((await free(opts.dir)) < MIN_FREE_BYTES) return err(507, "this server doesn't have enough free disk space to make a backup");
      running = true;
      const job: BackupJob = { archiveId: b.archiveId, state: "building", startedAt: now(), progress: { done: 0, total: 0, app: "" } };
      backup = job;
      await rm(archiveFile, { force: true }).catch(() => {});
      note("server.backup.started", "Started a backup of this server.");
      const key = Buffer.from(b.key, "hex");
      void buildServerArchive(
        { ...opts.build, workDir: scratch },
        {
          archiveId: b.archiveId,
          key,
          outPath: archiveFile,
          onProgress: (done, total, app) => {
            job.progress = { done, total, app };
          },
        },
      )
        .then((r) => {
          job.state = "ready";
          job.bytes = r.bytes;
          job.sha256 = r.sha256;
          job.apps = r.apps;
          key.fill(0);
          note("server.backup.created", `Backup ready: ${r.apps.length} app${r.apps.length === 1 ? "" : "s"}.`);
          log(`[server-archive] backup ready (${r.bytes} bytes)`);
        })
        .catch((e: Error) => {
          job.state = "failed";
          job.reason = e.message || "the backup couldn't be made";
          key.fill(0);
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
    const fh = await open(archiveFile, "r");
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
    if (offset + len >= (backup.bytes ?? 0)) note("server.backup.downloaded", "The backup was downloaded.");
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

  function backupView() {
    if (!backup) return null;
    return {
      archiveId: backup.archiveId,
      state: backup.state,
      startedAt: backup.startedAt,
      progress: backup.progress,
      ...(backup.bytes !== undefined ? { bytes: backup.bytes } : {}),
      ...(backup.sha256 ? { sha256: backup.sha256 } : {}),
      ...(backup.apps ? { apps: backup.apps } : {}),
      ...(backup.reason ? { reason: backup.reason } : {}),
    };
  }

  async function startRestore(req: HttpRequest): Promise<HttpResponse> {
    let b: { archiveId?: unknown; bytes?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    if (typeof b.archiveId !== "string" || !/^[0-9a-f]{32}$/.test(b.archiveId)) return err(400, "archiveId must be 16 bytes of lowercase hex");
    if (typeof b.bytes !== "number" || !Number.isSafeInteger(b.bytes) || b.bytes < 1) return err(400, "bytes required");
    if (running) return err(409, "a backup or import is already running here");
    await ensureDir();
    // The sealed file, then the same again unpacked, with room to spare.
    if ((await free(opts.dir)) < b.bytes * 2.2 + MIN_FREE_BYTES / 4) return err(507, "this server doesn't have enough free disk space to import that backup");
    await rm(uploadFile, { force: true }).catch(() => {});
    await rm(unpackDir, { recursive: true, force: true }).catch(() => {});
    restore = { archiveId: b.archiveId, state: "uploading", bytes: b.bytes, received: 0, apps: [], startedAt: now() };
    return json(202, { archiveId: b.archiveId });
  }

  async function putChunk(req: HttpRequest): Promise<HttpResponse> {
    if (!restore || restore.state !== "uploading") return err(409, "no import is waiting for data");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const offset = Number(q.get("offset") ?? "");
    if (!Number.isSafeInteger(offset) || offset !== restore.received) {
      return err(409, "chunk out of order", { received: restore.received });
    }
    if (req.body.length === 0 || offset + req.body.length > restore.bytes) return err(400, "bad chunk size");
    const fh = await open(uploadFile, offset === 0 ? "w" : "r+", 0o600);
    try {
      await fh.write(req.body, 0, req.body.length, offset);
    } finally {
      await fh.close();
    }
    restore.received += req.body.length;
    if (restore.received === restore.bytes) restore.state = "ready";
    return json(200, { received: restore.received, ready: restore.state === "ready" });
  }

  async function commitRestore(req: HttpRequest): Promise<HttpResponse> {
    if (!restore || restore.state !== "ready") return err(409, "upload the whole backup first");
    let b: { key?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    if (typeof b.key !== "string" || !/^[0-9a-f]{64}$/.test(b.key)) return err(400, "key must be 32 bytes of lowercase hex");
    // The header is public; the id in it must be the one the upload announced.
    let header;
    try {
      header = (await readHeader(uploadFile)).header;
    } catch (e) {
      return err(400, (e as Error).message);
    }
    if (header.archiveId !== restore.archiveId) return err(400, "that isn't the backup you announced");
    if (running) return err(409, "a backup or import is already running here");
    running = true;
    const job = restore;
    job.state = "opening";
    const key = Buffer.from(b.key, "hex");
    note("server.restore.started", `Importing a backup from ${header.sourceServer}.`);
    void (async () => {
      try {
        const contents = await unpackArchive({ ...opts.restore, workDir: scratch }, uploadFile, key, unpackDir);
        await rm(uploadFile, { force: true }).catch(() => {});
        job.apps = contents.metas.map((m) => ({ serviceId: m.serviceId, name: m.name, state: "waiting" as const }));
        job.state = "restoring";
        const results = await installArchive({ ...opts.restore, workDir: scratch }, unpackDir, contents, (r) => {
          job.apps = r.map((x) => ({ ...x }));
        });
        job.apps = results;
        job.state = "done";
        const ok = results.filter((r) => r.state === "done").length;
        const failed = results.filter((r) => r.state === "failed").length;
        note("server.restore.finished", `Import finished: ${ok} app${ok === 1 ? "" : "s"} restored${failed > 0 ? `, ${failed} failed` : ""}.`, failed === 0);
      } catch (e) {
        job.state = "failed";
        job.reason = e instanceof ArchiveError ? e.message : `the import failed: ${(e as Error).message}`;
        note("server.restore.failed", job.reason, false);
        log(`[server-archive] import failed: ${job.reason}`);
      } finally {
        key.fill(0);
        running = false;
        await rm(unpackDir, { recursive: true, force: true }).catch(() => {});
        await rm(uploadFile, { force: true }).catch(() => {});
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return json(202, { archiveId: job.archiveId });
  }

  function restoreView() {
    if (!restore) return { restore: null };
    const { archiveId, state, bytes, received, apps, reason, startedAt } = restore;
    return { restore: { archiveId, state, bytes, received, apps, startedAt, ...(reason ? { reason } : {}) } };
  }

  return {
    async handle(path: string, method: string, req: HttpRequest, ctx: { companion: boolean }): Promise<HttpResponse | null> {
      if (!isServerArchivePath(path)) return null;
      if (ctx.companion) return err(403, "companion sessions can't back up or import a server: open your owner app", { code: "companion-write-not-allowed" });
      await sweep();
      switch (`${method} ${path}`) {
        case `POST ${ARCHIVE_PATH}/start`:
          return startBackup(req);
        case `GET ${ARCHIVE_PATH}`:
          return json(200, { archive: backupView() });
        case `GET ${ARCHIVE_PATH}/chunk`:
          return chunk(req);
        case `DELETE ${ARCHIVE_PATH}`:
          if (backup?.state === "building") return err(409, "the backup is still being made");
          backup = null;
          await rm(archiveFile, { force: true }).catch(() => {});
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
    /** Drop any file a previous run left behind (a restart ends a running job). */
    async init(): Promise<void> {
      await rm(opts.dir, { recursive: true, force: true }).catch(() => {});
    },
    /** Wait for a running job (tests). */
    async settle(): Promise<void> {
      while (running) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

export type ServerArchiveService = ReturnType<typeof buildServerArchiveService>;

// Kept for tests that want the sealed file's hash without reading it twice.
export async function fileSha256(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src: AsyncIterable<Buffer>) {
    for await (const d of src) h.update(d);
  });
  return h.digest("hex");
}

