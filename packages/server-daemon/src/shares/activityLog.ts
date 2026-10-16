/**
 * What happened on this box and who did it (docs/share-a-server.md §7).
 * Another account appears under the owner's label for it, never under
 * anything that identifies it elsewhere. Bodies, SQL, prompts and tokens are
 * never written. `<dataDir>/activity.jsonl`, mode 0600, newest 2000 kept.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileDurable } from "../durableFile.js";

export type ActivityActor = { kind: "owner" } | { kind: "share"; shareId: string; label: string };

export interface ActivityEntry {
  /** Monotonic per log; the paging cursor. */
  seq: number;
  ts: number;
  actor: ActivityActor;
  action: string;
  /** Stable dotted kind the apps label (`server.migration.taken-over`); absent on older entries. */
  kind?: string;
  /** One readable line, never a body, SQL, prompt or token. */
  detail?: string;
  target?: string;
  ok: boolean;
}

export type ActivityInput = Omit<ActivityEntry, "ts" | "seq"> & { ts?: number };

const KEEP = 2000;

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private nextSeq = 1;
  private chain: Promise<void> = Promise.resolve();
  private appendsSinceTrim = 0;

  /** `path` null ⇒ memory only (tests). */
  constructor(
    private readonly path: string | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    if (!this.path) return;
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const out: ActivityEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ActivityEntry;
        if (typeof e.ts === "number" && typeof e.action === "string" && e.actor) {
          out.push({ ...e, seq: typeof e.seq === "number" ? e.seq : out.length + 1 });
        }
      } catch {
        /* a torn last line from a crash */
      }
    }
    this.entries = out.slice(-KEEP);
    this.nextSeq = this.entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  }

  record(entry: ActivityInput): void {
    const e: ActivityEntry = {
      seq: this.nextSeq++,
      ts: entry.ts ?? this.now(),
      actor: entry.actor,
      action: entry.action,
      ...(entry.kind ? { kind: entry.kind } : {}),
      ...(entry.detail ? { detail: entry.detail.slice(0, 240) } : {}),
      ...(entry.target ? { target: entry.target } : {}),
      ok: entry.ok,
    };
    this.entries.push(e);
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    if (!this.path) return;
    const path = this.path;
    const trim = ++this.appendsSinceTrim >= 200;
    if (trim) this.appendsSinceTrim = 0;
    const snapshot = trim ? this.entries.map((x) => JSON.stringify(x)).join("\n") + "\n" : null;
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        if (snapshot !== null) {
          await writeFileDurable(path, snapshot);
        } else {
          await appendFile(path, `${JSON.stringify(e)}\n`, { mode: 0o600 });
        }
      })
      .catch((err: Error) => console.warn(`[activity] write failed: ${err.message}`));
  }

  /** Newest first; `before` is a `seq` cursor (entries strictly older). */
  recent(limit = 200, before?: number): ActivityEntry[] {
    const older = before === undefined ? this.entries : this.entries.filter((e) => e.seq < before);
    return older.slice(-Math.max(1, Math.min(limit, KEEP))).reverse();
  }

  /** Record something the box itself did (not an owner or share request). */
  note(kind: string, detail: string, opts: { ok?: boolean; target?: string } = {}): void {
    this.record({
      actor: { kind: "owner" },
      action: kind,
      kind,
      detail,
      ok: opts.ok ?? true,
      ...(opts.target ? { target: opts.target } : {}),
    });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

export function defaultActivityLogPath(dataDir: string): string {
  return join(dataDir, "activity.jsonl");
}
