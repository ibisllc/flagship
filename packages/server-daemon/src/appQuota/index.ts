import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import type { DiskUse } from "./limits.js";

export * from "./limits.js";
export * from "./loopVolumes.js";
export * from "./pgQuota.js";
export * from "./manager.js";
export * from "./buildGuard.js";

/**
 * The box's data disk, as an app writer sees it: the filesystem that holds
 * Docker's storage, Postgres and the files images (all on the root of a
 * box today). Null when it can't be read (a dev machine).
 */
export async function hostDiskUse(paths: readonly string[] = ["/var/lib/docker", "/var/flagship", "/"]): Promise<DiskUse | null> {
  const p = paths.find((x) => existsSync(x));
  if (!p) return null;
  try {
    const s = await statfs(p);
    return { totalBytes: Number(s.blocks) * Number(s.bsize), availBytes: Number(s.bavail) * Number(s.bsize) };
  } catch {
    return null;
  }
}
export * from "./notices.js";
