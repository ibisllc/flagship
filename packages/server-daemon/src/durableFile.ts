import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write a file so it survives the power being cut right after. A plain
 * writeFile leaves the bytes in the page cache for up to ~30 s; home2 was
 * force-stopped 2 s after its update marker was written and came back with a
 * 0-byte marker (and a 0-byte daemon entry point). Write a temp file, fsync it,
 * rename it over the target, then fsync the directory so the rename sticks.
 */
export async function writeFileDurable(
  path: string,
  data: string,
  mode = 0o600,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, "w", mode);
  try {
    await fh.writeFile(data, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  await syncDir(dirname(path));
}

/** Remove a file and make the removal durable. */
export async function removeDurable(path: string): Promise<void> {
  await rm(path, { force: true });
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
