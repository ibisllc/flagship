/**
 * File-backed implementation of the J.4 undo journal.
 *
 * Each row lands on disk as a single JSON line (JSONL). Append is O(1):
 * we open the file in append mode and write the row + newline. List
 * is O(n): the daemon expects the journal to stay small (a handful of
 * rows per recovered user, 7-day TTL), and the read path only fires
 * when the user inspects the undo screen. Delete-older-than is also
 * O(n): we read, filter, atomically rewrite. Atomic via
 * write-temp-then-rename so a crash mid-prune can't corrupt the
 * journal — the worst case is a duplicate-write of one row, which
 * the reader tolerates.
 *
 * On-disk path: `<dataDir>/post-recovery-journal.jsonl`. Permissions
 * 0o600 + parent directory 0o700, matching the rest of the daemon's
 * sensitive-state files.
 *
 * The plaintext shape (`EncryptedJournalRow`) is itself encrypted —
 * the file contains no recoverable IRK→IRK mapping without the
 * journal salt + the daemon's SWK, both of which live elsewhere.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EncryptedJournalRow, JournalStore } from "./stableIdReissuer.js";

export class FileJournalStore implements JournalStore {
  constructor(private readonly path: string) {}

  async append(row: EncryptedJournalRow): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(row) + "\n";
    await appendFile(this.path, line, { mode: 0o600 });
  }

  async listAll(): Promise<EncryptedJournalRow[]> {
    if (!existsSync(this.path)) return [];
    const raw = await readFile(this.path, "utf8");
    const out: EncryptedJournalRow[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as EncryptedJournalRow;
        if (
          typeof parsed.serviceId === "string" &&
          typeof parsed.ivHex === "string" &&
          typeof parsed.ciphertextHex === "string" &&
          typeof parsed.tagHex === "string" &&
          typeof parsed.rewrittenAt === "number"
        ) {
          out.push(parsed);
        }
      } catch {
        // skip malformed lines — keep the rest of the journal usable
      }
    }
    return out;
  }

  async deleteOlderThan(cutoffMs: number): Promise<number> {
    if (!existsSync(this.path)) return 0;
    const all = await this.listAll();
    const kept = all.filter((r) => r.rewrittenAt >= cutoffMs);
    const removed = all.length - kept.length;
    if (removed === 0) return 0;
    await this.atomicRewrite(kept);
    return removed;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
  }

  private async atomicRewrite(rows: EncryptedJournalRow[]): Promise<void> {
    await this.ensureDir();
    const tmp = `${this.path}.tmp`;
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

export function defaultJournalPath(dataDir: string): string {
  return join(dataDir, "post-recovery-journal.jsonl");
}

/**
 * Periodic prune timer. Wraps `setInterval`; returns a `stop()` for
 * graceful shutdown. The default 7-day TTL matches the design's undo
 * window; the default 1-hour cadence is conservative — a missed
 * prune for a few hours doesn't change the user-facing behavior
 * (the screen filters by expiry anyway).
 */
export function startJournalPruner(opts: {
  store: JournalStore;
  intervalMs?: number;
  ttlMs?: number;
  now?: () => number;
  onPrune?: (removed: number) => void;
}): { stop: () => void; firstPrune: Promise<number> } {
  const intervalMs = opts.intervalMs ?? 60 * 60_000;       // 1h
  const ttlMs = opts.ttlMs ?? 7 * 24 * 60 * 60_000;        // 7d
  const now = opts.now ?? (() => Date.now());
  const tick = async () => {
    try {
      const removed = await opts.store.deleteOlderThan(now() - ttlMs);
      opts.onPrune?.(removed);
      return removed;
    } catch {
      // Best-effort; a transient FS error shouldn't kill the loop.
      return 0;
    }
  };
  // Fire once on start so a daemon that's been off for >7d catches up.
  // Returning the first-tick promise lets tests await prune completion
  // without sleeping (the previous setTimeout-based wait was flaky
  // under full-suite contention).
  const firstPrune = tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  return { stop: () => clearInterval(timer), firstPrune };
}
