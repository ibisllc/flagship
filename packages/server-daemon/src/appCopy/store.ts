/**
 * The target box's record of each copy it has run (docs/app-placement.md §5),
 * kept on disk so a daemon restart reports what happened instead of
 * forgetting: a copy still `copying` or `installing` at load becomes `failed`
 * ("interrupted") and is handed back for cleanup. Progress lives in memory;
 * the file changes on each state change.
 *
 * What the copy holds while it runs (`held`) names what to remove if it is
 * interrupted: the stores it made (names only, never passwords), the image it
 * loaded, and whether it wrote the app's env.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileDurable } from "../durableFile.js";

export type CopyState = "copying" | "installing" | "done" | "failed";

export interface CopyHeld {
  postgres?: Record<string, { database: string; role: string }>;
  filesVolume?: string;
  /** Set when this copy loaded the image (it wasn't on the box before). */
  image?: string;
  env?: boolean;
}

export interface CopyRecord {
  copyId: string;
  serviceId: string;
  appName: string;
  sourceServer: string;
  state: CopyState;
  progress?: number;
  reason?: string;
  startedAt: number;
  finishedAt?: number;
  /** How the data came: over the local network or through the relay. */
  route?: "lan" | "relay";
  /** Env names whose values couldn't come along (the owner sets them here). */
  pendingEnv?: string[];
  held?: CopyHeld;
}

export const COPY_RECORDS_KEPT = 20;
export const INTERRUPTED_REASON = "interrupted: the server restarted during the copy";

export class AppCopyStore {
  private records = new Map<string, CopyRecord>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Read the records; returns the copies a restart interrupted (now `failed`). */
  async load(): Promise<CopyRecord[]> {
    if (!this.path) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return [];
    }
    const list = Array.isArray((raw as { copies?: unknown })?.copies) ? (raw as { copies: unknown[] }).copies : [];
    const interrupted: CopyRecord[] = [];
    for (const r of list) {
      const rec = parseRecord(r);
      if (!rec) continue;
      if (rec.state === "copying" || rec.state === "installing") {
        rec.state = "failed";
        rec.reason = INTERRUPTED_REASON;
        rec.finishedAt = this.now();
        delete rec.progress;
        interrupted.push({ ...rec });
      }
      this.records.set(rec.copyId, rec);
    }
    if (interrupted.length > 0) await this.save();
    return interrupted;
  }

  list(): CopyRecord[] {
    return [...this.records.values()].map(clone).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(copyId: string): CopyRecord | null {
    const r = this.records.get(copyId);
    return r ? clone(r) : null;
  }

  /** The copy of this app still underway, if any. */
  active(serviceId: string): CopyRecord | null {
    for (const r of this.records.values()) {
      if (r.serviceId === serviceId && (r.state === "copying" || r.state === "installing")) return clone(r);
    }
    return null;
  }

  async create(r: CopyRecord): Promise<void> {
    this.records.set(r.copyId, clone(r));
    this.prune();
    await this.save();
  }

  /** In memory only (progress ticks). */
  setProgress(copyId: string, progress: number): void {
    const r = this.records.get(copyId);
    if (r && (r.state === "copying" || r.state === "installing")) r.progress = Math.max(0, Math.min(1, progress));
  }

  async update(copyId: string, patch: Partial<Omit<CopyRecord, "copyId">>): Promise<void> {
    const r = this.records.get(copyId);
    if (!r) return;
    Object.assign(r, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (r as unknown as Record<string, unknown>)[k];
    await this.save();
  }

  private prune(): void {
    const finished = [...this.records.values()]
      .filter((r) => r.state === "done" || r.state === "failed")
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const r of finished.slice(COPY_RECORDS_KEPT)) this.records.delete(r.copyId);
  }

  private save(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    const body = JSON.stringify({ v: 1, copies: [...this.records.values()].map(({ progress: _p, ...r }) => r) });
    const next = this.chain.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileDurable(path, body);
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

function clone(r: CopyRecord): CopyRecord {
  return JSON.parse(JSON.stringify(r)) as CopyRecord;
}

function parseRecord(v: unknown): CopyRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const states: CopyState[] = ["copying", "installing", "done", "failed"];
  if (
    typeof r.copyId !== "string" ||
    typeof r.serviceId !== "string" ||
    typeof r.appName !== "string" ||
    typeof r.sourceServer !== "string" ||
    typeof r.startedAt !== "number" ||
    !states.includes(r.state as CopyState)
  ) {
    return null;
  }
  return clone(r as unknown as CopyRecord);
}
