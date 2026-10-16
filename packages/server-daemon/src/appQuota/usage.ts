import type { AppArchiveBytes } from "../serverArchive/build.js";

/**
 * The backup cap's per-app sizes with the quota manager's own readings in
 * place of the backup's where it has them: a files folder's statfs (blocks
 * as allocated, which is what fills its image) and the databases' size. The
 * budgets split from these are then in the same units the limits hold.
 */
export function withQuotaUsage(
  perApp: Map<string, AppArchiveBytes> | null,
  measured: ReadonlyMap<string, { filesBytes: number | null; postgresBytes: number | null }>,
): Map<string, AppArchiveBytes> | null {
  if (!perApp) return null;
  const out = new Map<string, AppArchiveBytes>();
  for (const [id, a] of perApp) {
    const m = measured.get(id);
    const filesBytes = m?.filesBytes ?? a.filesBytes;
    const postgresBytes = m?.postgresBytes ?? a.postgresBytes;
    const totalBytes = a.totalBytes + (filesBytes - a.filesBytes) + (postgresBytes - a.postgresBytes);
    out.set(id, { ...a, filesBytes, postgresBytes, totalBytes });
  }
  return out;
}
