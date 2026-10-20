/**
 * The server's saved backups on its own disk (docs/server-backup-and-clone.md,
 * "Scheduled backups"): `<dir>/<archiveId>/` holds the two files and a
 * `meta.json`, `<dir>/state.json` the schedule and the last runs, and
 * `<dir>/keys.json` (0600) the unused account-slot keys an admin device
 * deposited. Each key is used for one backup and deleted before it is used.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveKey } from "@flagship/protocol";
import { DEFAULT_SCHEDULE, parseSchedule, type BackupSchedule, type RunHistory } from "./schedule.js";

export const SAVED_BACKUP_FILE = "backup.flagship-backup";
export const SAVED_DATA_FILE = "data.flagship-data";
/** The pool holds at most this many unused keys. */
export const KEY_POOL_MAX = 800;
/** Below this many unused keys the apps top the pool up (one approval). */
export const KEY_POOL_LOW = 30;
/** Ids already used, remembered so a replayed deposit can't reuse one. */
const USED_IDS_MAX = 4000;

export interface SavedBackupMeta {
  archiveId: string;
  createdAt: number;
  /** "schedule" for a scheduled run, "now" for Back up now. */
  trigger: "schedule" | "now";
  bytes: number;
  sha256: string;
  backupBytes: number;
  /** The one `.flagship` file the owner downloads: header + backup file + data file. */
  bundleFileName: string;
  bundleBytes: number;
  bundleSha256: string;
  backupFileName: string;
  dataFileName: string;
  apps: Array<{ serviceId: string; name: string }>;
  left: Array<{ serviceId: string; name: string; reason: string }>;
}

export interface LastRun {
  at: number;
  ok: boolean;
  trigger: "schedule" | "now";
  archiveId?: string;
  /** The box's sentence when it failed. */
  reason?: string;
}

export interface SavedState {
  schedule: BackupSchedule;
  history: RunHistory;
  lastRun: LastRun | null;
  usedIds: string[];
}

const EMPTY_HISTORY: RunHistory = { lastAttemptAt: null, lastOk: null, triesThisSlot: 0, triesSlot: null };

export function freshState(): SavedState {
  return { schedule: { ...DEFAULT_SCHEDULE }, history: { ...EMPTY_HISTORY }, lastRun: null, usedIds: [] };
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

export class SavedBackups {
  constructor(readonly dir: string) {}

  private statePath() {
    return join(this.dir, "state.json");
  }
  private keysPath() {
    return join(this.dir, "keys.json");
  }
  entryDir(archiveId: string) {
    return join(this.dir, archiveId);
  }
  buildingDir(archiveId: string) {
    return join(this.dir, `.building-${archiveId}`);
  }

  /** Make the folder and drop what an interrupted run left behind. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.dir)) {
      if (name.startsWith(".building-") || name.endsWith(".tmp")) await rm(join(this.dir, name), { recursive: true, force: true });
    }
  }

  async loadState(): Promise<SavedState> {
    try {
      const raw = JSON.parse(await readFile(this.statePath(), "utf8")) as Partial<SavedState>;
      const schedule = parseSchedule(raw.schedule);
      const base = freshState();
      return {
        schedule: typeof schedule === "string" ? base.schedule : schedule,
        history: { ...base.history, ...(raw.history ?? {}) },
        lastRun: raw.lastRun ?? null,
        usedIds: Array.isArray(raw.usedIds) ? raw.usedIds.filter((x) => typeof x === "string") : [],
      };
    } catch {
      return freshState();
    }
  }

  async saveState(s: SavedState): Promise<void> {
    if (s.usedIds.length > USED_IDS_MAX) s.usedIds = s.usedIds.slice(-USED_IDS_MAX);
    await writeAtomic(this.statePath(), JSON.stringify(s));
  }

  async loadKeys(): Promise<ArchiveKey[]> {
    try {
      const raw = JSON.parse(await readFile(this.keysPath(), "utf8")) as unknown;
      return Array.isArray(raw) ? (raw as ArchiveKey[]) : [];
    } catch {
      return [];
    }
  }

  async saveKeys(keys: ArchiveKey[]): Promise<void> {
    await writeAtomic(this.keysPath(), JSON.stringify(keys));
  }

  /** Every complete saved backup, newest first. */
  async list(): Promise<SavedBackupMeta[]> {
    const out: SavedBackupMeta[] = [];
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    for (const name of names) {
      if (!/^[0-9a-f]{32}$/.test(name)) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.dir, name, "meta.json"), "utf8")) as SavedBackupMeta;
        await stat(join(this.dir, name, SAVED_DATA_FILE));
        out.push(meta);
      } catch {
        /* a half-written entry is not a backup */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Move a finished build into place under its id. */
  async commit(meta: SavedBackupMeta): Promise<void> {
    const from = this.buildingDir(meta.archiveId);
    await writeFile(join(from, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
    await rename(from, this.entryDir(meta.archiveId));
  }

  async remove(archiveId: string): Promise<void> {
    await rm(this.entryDir(archiveId), { recursive: true, force: true });
  }
}
