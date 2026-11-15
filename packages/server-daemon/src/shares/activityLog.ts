/**
 * What happened on this box and who did it (docs/share-a-server.md §7).
 * Another account appears under the owner's label for it, never under
 * anything that identifies it elsewhere. Bodies, SQL, prompts and tokens are
 * never written. `<dataDir>/activity.jsonl`, mode 0600, newest 2000 kept.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ORG_LOG_GENESIS, orgBoxLogEntryHash } from "@flagship/protocol";
import { writeFileDurable } from "../durableFile.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** The chain's head: the last entry's sequence and the hash chained over every line up to it. */
export interface ActivityHead {
  seq: number;
  hash: string;
}

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
  /** What the apps fill their own translated sentence for `kind` with (app names, dates, counts, reason codes). */
  params?: Record<string, string | number>;
  ok: boolean;
}

export type ActivityInput = Omit<ActivityEntry, "ts" | "seq"> & { ts?: number };

const KEEP = 2000;

/**
 * Each line is chained (`flagship/org-box-log/v1|<seq>|<prevHash>|<sha256 of the line>`), so an org
 * box can sign its head (docs/enterprise-accounts.md §11). A trimmed file starts with a
 * `{"base":{"seq","hash"}}` line, the chain's hash just before its first kept entry.
 */
export class ActivityLog {
  private entries: ActivityEntry[] = [];
  /** The chain hash after each entry in `entries`. */
  private hashes: string[] = [];
  private base: ActivityHead = { seq: 0, hash: ORG_LOG_GENESIS };
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
    const hashes: string[] = [];
    let base: ActivityHead = { seq: 0, hash: ORG_LOG_GENESIS };
    let prev = base.hash;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ActivityEntry & { base?: ActivityHead };
        if (out.length === 0 && e.base && Number.isSafeInteger(e.base.seq) && /^[0-9a-f]{64}$/.test(String(e.base.hash))) {
          base = { seq: e.base.seq, hash: e.base.hash };
          prev = base.hash;
          continue;
        }
        if (typeof e.ts === "number" && typeof e.action === "string" && e.actor) {
          const seq = typeof e.seq === "number" && Number.isSafeInteger(e.seq) && e.seq >= 0 ? e.seq : out.length + 1;
          out.push({ ...e, seq });
          prev = orgBoxLogEntryHash(seq, prev, sha256Hex(line));
          hashes.push(prev);
        }
      } catch {
        /* a torn last line from a crash */
      }
    }
    const drop = Math.max(0, out.length - KEEP);
    if (drop > 0) base = { seq: out[drop - 1]!.seq, hash: hashes[drop - 1]! };
    this.entries = out.slice(drop);
    this.hashes = hashes.slice(drop);
    this.base = base;
    this.nextSeq = this.entries.reduce((m, e) => Math.max(m, e.seq), base.seq) + 1;
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
      ...(entry.params ? { params: cleanParams(entry.params) } : {}),
      ok: entry.ok,
    };
    const line = JSON.stringify(e);
    const chained = orgBoxLogEntryHash(e.seq, this.head().hash, sha256Hex(line));
    this.entries.push(e);
    this.hashes.push(chained);
    if (this.entries.length > KEEP) {
      const n = this.entries.length - KEEP;
      this.base = { seq: this.entries[n - 1]!.seq, hash: this.hashes[n - 1]! };
      this.entries.splice(0, n);
      this.hashes.splice(0, n);
    }
    if (!this.path) return;
    const path = this.path;
    const trim = ++this.appendsSinceTrim >= 200;
    if (trim) this.appendsSinceTrim = 0;
    const snapshot = trim ? [JSON.stringify({ base: this.base }), ...this.entries.map((x) => JSON.stringify(x))].join("\n") + "\n" : null;
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        if (snapshot !== null) {
          await writeFileDurable(path, snapshot);
        } else {
          await appendFile(path, `${line}\n`, { mode: 0o600 });
        }
      })
      .catch((err: Error) => console.warn(`[activity] write failed: ${err.message}`));
  }

  /** The chain's head (the base when the log is empty). */
  head(): ActivityHead {
    const n = this.entries.length;
    return n === 0 ? { ...this.base } : { seq: this.entries[n - 1]!.seq, hash: this.hashes[n - 1]! };
  }

  /** Newest first; `before` is a `seq` cursor (entries strictly older). */
  recent(limit = 200, before?: number): ActivityEntry[] {
    const older = before === undefined ? this.entries : this.entries.filter((e) => e.seq < before);
    return older.slice(-Math.max(1, Math.min(limit, KEEP))).reverse();
  }

  /** Record something the box itself did (not an owner or share request). */
  note(kind: string, detail: string, opts: { ok?: boolean; target?: string; params?: Record<string, string | number> } = {}): void {
    this.record({
      actor: { kind: "owner" },
      action: kind,
      kind,
      detail,
      ok: opts.ok ?? true,
      ...(opts.target ? { target: opts.target } : {}),
      ...(opts.params ? { params: opts.params } : {}),
    });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

export function defaultActivityLogPath(dataDir: string): string {
  return join(dataDir, "activity.jsonl");
}

/** At most 8 parameters: short keys, strings cut to 120 characters, finite numbers. */
function cleanParams(p: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p).slice(0, 8)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
