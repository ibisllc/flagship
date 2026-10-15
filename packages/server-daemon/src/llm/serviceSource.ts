/**
 * The current code of a service built on this box, read back from its working
 * tree (`<app-clones>/<serviceId>/`, rewritten on every deploy) so an edit
 * starts from exactly what is running. Text files only, within the limits a
 * build workspace accepts; the rest (images, fonts) is carried across a
 * redeploy by `readCarriedBinaries`.
 */

import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const MAX_SOURCE_FILES = 2000;
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "__pycache__", ".venv", "venv"]);

const isText = (buf: Buffer) => buf.length <= MAX_SOURCE_FILE_BYTES && !buf.includes(0);

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
        const buf = await readFile(full);
        if (!isText(buf)) continue;
        if (++count > MAX_SOURCE_FILES) return `It has more than ${MAX_SOURCE_FILES} files.`;
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

/**
 * The files of a service's working tree that aren't its editable text, so a
 * redeploy that rewrites the tree from text keeps them. Empty when there is
 * no tree yet.
 */
export async function readCarriedBinaries(appDir: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && (await lstat(full)).isFile()) {
        const buf = await readFile(full);
        if (!isText(buf)) out[relative(appDir, full).split(sep).join("/")] = buf;
      }
    }
  };
  await walk(appDir);
  return out;
}

/**
 * Rewrite a service's working tree from its text `files` (so a deploy is
 * reproducible), plus `binaries` from the build and, for an edit, the
 * binaries the running version already had. Text wins on a clash. Returns
 * the offending path for an unsafe one.
 */
export async function writeSourceTree(
  appDir: string,
  files: Record<string, string>,
  opts: { binaries?: Record<string, Buffer>; keepBinaries?: boolean } = {},
): Promise<{ ok: true } | { ok: false; unsafePath: string }> {
  const all = [...Object.keys(files), ...Object.keys(opts.binaries ?? {})];
  const unsafe = all.find((p) => p.includes("..") || p.startsWith("/") || p.includes("\0"));
  if (unsafe) return { ok: false, unsafePath: unsafe };
  const kept = opts.keepBinaries ? await readCarriedBinaries(appDir) : {};
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  const write = async (path: string, content: string | Buffer) => {
    const full = join(appDir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  };
  for (const [path, bytes] of Object.entries({ ...kept, ...(opts.binaries ?? {}) })) {
    if (files[path] == null) await write(path, bytes);
  }
  for (const [path, content] of Object.entries(files)) await write(path, content);
  return { ok: true };
}
