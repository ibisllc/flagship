/**
 * The current code of a service built on this box, read back from its working
 * tree (`<app-clones>/<serviceId>/`, rewritten on every deploy) so an edit
 * starts from exactly what is running. Text files only, within the limits a
 * build workspace accepts.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const MAX_SOURCE_FILES = 500;
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv"]);

export type ServiceSource =
  | { ok: true; files: Record<string, string>; bytes: number }
  | { ok: false; reason: string };

export async function readServiceSource(workingDir: string, serviceId: string): Promise<ServiceSource> {
  if (!/^[a-z0-9-]+$/.test(serviceId)) return { ok: false, reason: "bad service id" };
  const root = join(workingDir, serviceId);
  try {
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    return { ok: false, reason: "This server has no source for that service; it wasn't built here." };
  }
  const files: Record<string, string> = {};
  let bytes = 0;
  let count = 0;
  const walk = async (dir: string): Promise<string | null> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const err = await walk(full);
        if (err) return err;
      } else if (e.isFile()) {
        if (++count > MAX_SOURCE_FILES) return `It has more than ${MAX_SOURCE_FILES} files.`;
        const buf = await readFile(full);
        if (buf.length > MAX_SOURCE_FILE_BYTES || buf.includes(0)) continue;
        files[relative(root, full).split(sep).join("/")] = buf.toString("utf8");
        bytes += buf.length;
      }
    }
    return null;
  };
  const err = await walk(root);
  if (err) return { ok: false, reason: err };
  if (!files["flagship.app.json"]) return { ok: false, reason: "Its source has no flagship.app.json." };
  return { ok: true, files, bytes };
}
