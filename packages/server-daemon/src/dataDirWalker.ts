import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { FileToBack } from "./backupLoop.js";

const execFileP = promisify(execFile);

/**
 * The peer-backup data-dir walker — turns the box's content tree
 * (`/var/flagship/data/**`: app-clones, app-state, build workspaces, …) into
 * the `FileToBack[]` the BackupLoop ships. Until this existed every runOnce
 * caller passed `[]` (a ghost run that shipped nothing); the walker feeds BOTH
 * the periodic backup pass and the decommission/migration FINAL FLUSH (the v1
 * freeze is a simple full flush, per docs/server-migration.md's open-question
 * resolution — delta shipping is a v2).
 *
 * Scope + safety:
 *   - DATA ONLY. The walker is rooted at the data dir; keys/identity/config
 *     live OUTSIDE it (`/var/flagship/*.hex`, `identity`, `install-blob.json`)
 *     and can never enter a backup through here. Belt-and-braces, an exclusion
 *     list also drops key-shaped files (`*.key`, `*.pem`, `*.hex`, dotfiles)
 *     and restore/tmp droppings even if something ever writes one INSIDE data.
 *   - SYMLINKS ARE NEVER FOLLOWED (lstat), so a link inside the tree can't
 *     exfiltrate a file from outside the root into the backup set.
 *   - Deterministic: entries come back sorted by relative path, so an
 *     unchanged tree produces an identical file list (and the BackupLoop's
 *     unchanged-chunk skip actually fires).
 *   - Oversize files are SKIPPED with a log, not shipped partially — the
 *     chunker is whole-file today; a multi-GB media file would balloon every
 *     flush. Cap is injectable (default 64 MiB).
 *   - Best-effort per entry: an unreadable file is skipped + logged, never a
 *     thrown walk.
 */

export interface WalkDataDirOptions {
  /** Skip files larger than this many bytes (default 64 MiB). */
  maxFileBytes?: number;
  /**
   * Files whose relPath matches are subject to `raisedCapBytes` instead of the
   * default cap — for the consistent logical dumps under `_dumps/` that
   * legitimately exceed 64 MiB (a full pg_dumpall, a forgejo repos tar). Without
   * this the cap would silently truncate them out of the backup.
   */
  raiseCapFor?: (relPath: string) => boolean;
  /** Cap applied to `raiseCapFor` matches. Default 4 GiB. */
  raisedCapBytes?: number;
  /** Extra per-relative-path exclusion (return true to skip). */
  exclude?: (relPath: string) => boolean;
  onLog?: (msg: string) => void;
}

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_RAISED_CAP_BYTES = 4 * 1024 * 1024 * 1024;

/** Key-material / droppings that must never ride a backup even if misplaced. */
const EXCLUDED_SUFFIXES = [".key", ".pem", ".hex", ".restore-tmp", ".tmp"];

function isExcludedName(name: string): boolean {
  if (name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  if (lower.includes("identity")) return true;
  return EXCLUDED_SUFFIXES.some((s) => lower.endsWith(s));
}

export async function walkDataDir(
  rootDir: string,
  opts: WalkDataDirOptions = {},
): Promise<FileToBack[]> {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const raisedCap = opts.raisedCapBytes ?? DEFAULT_RAISED_CAP_BYTES;
  const log = opts.onLog ?? (() => {});
  const out: FileToBack[] = [];

  async function walk(dirAbs: string, relPrefix: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dirAbs);
    } catch {
      return; // missing/unreadable dir — nothing to back up here
    }
    for (const name of entries.sort()) {
      const abs = join(dirAbs, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (isExcludedName(name)) {
        log(`[backup-walk] excluded ${rel}`);
        continue;
      }
      if (opts.exclude?.(rel)) {
        log(`[backup-walk] excluded ${rel} (caller rule)`);
        continue;
      }
      let st: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        st = await fs.lstat(abs); // lstat: NEVER follow symlinks
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        log(`[backup-walk] skipping symlink ${rel}`);
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!st.isFile()) continue; // sockets/fifos/devices
      const cap = opts.raiseCapFor?.(rel) ? raisedCap : maxBytes;
      if (st.size > cap) {
        log(`[backup-walk] skipping oversize ${rel} (${st.size} bytes > ${cap})`);
        continue;
      }
      try {
        const content = new Uint8Array(await fs.readFile(abs));
        out.push({ path: rel, content });
      } catch (e) {
        log(`[backup-walk] unreadable ${rel}: ${(e as Error).message}`);
      }
    }
  }

  await walk(rootDir, "");
  // readdir order is already sorted per directory; sort the flat list too so
  // the output is globally deterministic regardless of traversal.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The v1 FREEZE quiesce (docs/server-migration.md phase 5, "concurrent-writes
 * at freeze"): stop the data-services stack (postgres/minio/redis/forgejo —
 * the writers) so the final full flush walks a WRITE-FROZEN tree. The chosen
 * v1 mechanism is stop-services-then-full-flush — no delta shipping, no
 * fs-level snapshot; the box is being retired immediately after, so services
 * never restart on it.
 *
 * ⚠️ The old implementation ran ONLY `systemctl stop flagship-data-services`,
 * but that unit is Type=oneshot + RemainAfterExit + (was) no ExecStop → the
 * `docker compose` containers it started KEPT RUNNING, so the "frozen" flush
 * still walked live, torn data. We now stop the containers DIRECTLY via
 * `docker compose … stop` (mirroring `realWipeContent`'s explicit compose
 * teardown) — reliable regardless of the unit's ExecStop. The `systemctl stop`
 * is kept first (harmless; also correct now that late-command adds ExecStop).
 *
 * With the volume-aware logical dumps taken BEFORE this runs, postgres/redis
 * are already captured consistently and don't NEED the freeze; it mainly gives
 * minio a stable window and provides a clean final point for any non-store
 * files under data/. Best-effort throughout (a missing systemctl / already-
 * stopped stack — dev runs — is not an error); the runner is injectable.
 */
export async function quiesceDataServices(
  onLog?: (msg: string) => void,
  runner?: (cmd: string, args: string[]) => Promise<void>,
  opts?: { composePath?: string; envFile?: string },
): Promise<void> {
  const run =
    runner ??
    (async (cmd: string, args: string[]) => {
      await execFileP(cmd, args, { timeout: 120_000 });
    });
  const composePath = opts?.composePath ?? "/opt/flagship/installer/data-services/docker-compose.yml";
  const envFile = opts?.envFile ?? "/var/flagship/data-services.env";
  try {
    await run("systemctl", ["stop", "flagship-data-services"]);
  } catch (e) {
    onLog?.(`[freeze] systemctl stop failed (continuing): ${(e as Error).message}`);
  }
  try {
    // The actual stop: the compose stack the unit launched. `stop` (not `down`)
    // leaves the containers + volumes intact — this is a freeze, not a wipe.
    await run("docker", ["compose", "-f", composePath, "--env-file", envFile, "stop"]);
    onLog?.("[freeze] data services stopped (write-frozen)");
  } catch (e) {
    onLog?.(`[freeze] docker compose stop failed (continuing): ${(e as Error).message}`);
  }
}
