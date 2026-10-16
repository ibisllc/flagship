import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * The one way the daemon replaces a state file. Writes to a path run one at a
 * time (in the order they were asked for) through a temp name no other write
 * shares: two overlapping writes through one fixed `<file>.tmp` both
 * truncated it and wrote from offset 0, leaving a torn mix of the two, and the
 * second rename failed with ENOENT. A torn security file then loaded as
 * corrupt, and some stores fell back to their permissive default.
 *
 * Every write is also durable: home2 was force-stopped 2 s after its update
 * marker was written and came back with a 0-byte marker (and a 0-byte daemon
 * entry point), because a plain writeFile leaves the bytes in the page cache
 * for up to ~30 s. So: write the temp file, fsync it, rename it over the
 * target, then fsync the directory so the rename sticks.
 */

const tails = new Map<string, Promise<unknown>>();
let tempSeq = 0;

/**
 * Run `fn` while holding `path`'s lock, after every earlier holder. Use it for
 * a read-modify-write of a file; `write` replaces the file without asking for
 * the lock again (calling {@link writeFileDurable} on the same path inside
 * `fn` would wait for itself).
 */
export function withFileLock<T>(
  path: string,
  fn: (write: (data: string | Uint8Array, mode?: number) => Promise<void>) => Promise<T>,
): Promise<T> {
  const key = resolve(path);
  const prev = tails.get(key) ?? Promise.resolve();
  const turn = () => fn((data, mode) => replaceFile(key, data, mode ?? 0o600));
  const run = prev.then(turn, turn);
  const tail = run.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/** Replace `path` with `data`, durably, after every earlier write to it. */
export function writeFileDurable(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  return withFileLock(path, (write) => write(data, mode));
}

/** Remove a file and make the removal durable (in turn with writes to it). */
export function removeDurable(path: string): Promise<void> {
  return withFileLock(path, async () => {
    await rm(path, { force: true });
    await syncDir(dirname(path));
  });
}

async function replaceFile(path: string, data: string | Uint8Array, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${++tempSeq}.tmp`;
  try {
    const fh = await open(tmp, "w", mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await syncDir(dirname(path));
}

async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// ── Corrupt state ─────────────────────────────────────────────────────

export interface CorruptStateReport {
  /** The file that couldn't be read. */
  path: string;
  /** Where it was kept for forensics, or null when moving it failed. */
  keptAs: string | null;
  error: string;
  /** What the box does instead, in the owner's words. */
  effect: string;
}

let corruptListener: ((r: CorruptStateReport) => void) | null = null;
const unreported: CorruptStateReport[] = [];

/** Who hears about corrupt state (the activity log); reports made earlier are replayed. */
export function onCorruptState(listener: ((r: CorruptStateReport) => void) | null): void {
  corruptListener = listener;
  if (!listener) return;
  for (const r of unreported.splice(0)) {
    try {
      listener(r);
    } catch {
      /* reporting never breaks a load */
    }
  }
}

/**
 * A state file couldn't be read: move it aside to `<path>.corrupt-<ms>` (so the
 * next write can't destroy the evidence), log it and tell the owner. Callers
 * decide the fail-closed state they load instead.
 */
export async function keepCorruptAside(path: string, error: unknown, effect: string): Promise<CorruptStateReport> {
  const message = String((error as Error)?.message ?? error);
  const keptAs = await withFileLock(path, async () => {
    const aside = `${path}.corrupt-${Date.now()}`;
    try {
      await rename(path, aside);
      await syncDir(dirname(path));
      return aside;
    } catch {
      return null;
    }
  });
  const report: CorruptStateReport = { path, keptAs, error: message, effect };
  console.error(
    `[state] ${path} is unreadable (${message}); ${keptAs ? `kept as ${keptAs}` : "left in place"}. ${effect}`,
  );
  if (corruptListener) {
    try {
      corruptListener(report);
    } catch {
      /* reporting never breaks a load */
    }
  } else {
    unreported.push(report);
  }
  return report;
}

export type StateFileRead = { kind: "missing" } | { kind: "ok"; text: string } | { kind: "unreadable"; error: unknown };

/** Read a state file, telling "never written" apart from "there but unreadable". */
export async function readStateFile(path: string): Promise<StateFileRead> {
  try {
    return { kind: "ok", text: await readFile(path, "utf8") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", error: e };
  }
}
