/**
 * What happened on this box and who did it (docs/share-a-server.md §7).
 * Another account appears under the owner's label for it, never under
 * anything that identifies it elsewhere. Bodies, SQL, prompts and tokens are
 * never written. `<dataDir>/activity.jsonl`, mode 0600, newest 2000 kept.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ActivityActor = { kind: "owner" } | { kind: "share"; shareId: string; label: string };

export interface ActivityEntry {
  ts: number;
  actor: ActivityActor;
  action: string;
  target?: string;
  ok: boolean;
}

const KEEP = 2000;

export class ActivityLog {
  private entries: ActivityEntry[] = [];
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
        if (typeof e.ts === "number" && typeof e.action === "string" && e.actor) out.push(e);
      } catch {
        /* a torn last line from a crash */
      }
    }
    this.entries = out.slice(-KEEP);
  }

  record(entry: Omit<ActivityEntry, "ts"> & { ts?: number }): void {
    const e: ActivityEntry = {
      ts: entry.ts ?? this.now(),
      actor: entry.actor,
      action: entry.action,
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
          await writeFile(`${path}.tmp`, snapshot, { mode: 0o600 });
          await rename(`${path}.tmp`, path);
        } else {
          await appendFile(path, `${JSON.stringify(e)}\n`, { mode: 0o600 });
        }
      })
      .catch((err: Error) => console.warn(`[activity] write failed: ${err.message}`));
  }

  /** Newest first. */
  recent(limit = 200): ActivityEntry[] {
    return this.entries.slice(-Math.max(1, Math.min(limit, KEEP))).reverse();
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

export function defaultActivityLogPath(dataDir: string): string {
  return join(dataDir, "activity.jsonl");
}
