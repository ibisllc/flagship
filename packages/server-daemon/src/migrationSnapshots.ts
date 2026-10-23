/**
 * The data snapshot a migration batch takes first (SECURITY-HARDENING-PLAN.md 18.8, SEC-MIG-002).
 * Migrations are SQL and run in the sandbox as the app's own database role, so the only thing a batch
 * can change is that app's database: a snapshot is a dump of each of its Postgres stores, and putting
 * it back drops and recreates what the dump holds in one transaction. Kept in the state directory
 * (on the encrypted disk), the last two per app; an app with no database has nothing to snapshot.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppCopyOps } from "./appCopy/ops.js";
import type { AppDataCredentials } from "./dataLayer/provisioner.js";

export interface MigrationSnapshotDeps {
  dir: string;
  ops: Pick<AppCopyOps, "dumpDatabase" | "restoreDatabase">;
  dataOf: (serviceId: string) => AppDataCredentials | null;
  now?: () => number;
  keep?: number;
}

export const NO_DATABASE_SNAPSHOT = "none";

export function buildMigrationSnapshots(deps: MigrationSnapshotDeps) {
  const now = deps.now ?? (() => Date.now());
  const keep = deps.keep ?? 2;
  const safe = (s: string) => /^[A-Za-z0-9._-]+$/.test(s);

  async function snapshotData(serviceId: string): Promise<string> {
    const data = deps.dataOf(serviceId);
    const stores = Object.entries(data?.postgres ?? {});
    if (stores.length === 0) return NO_DATABASE_SNAPSHOT;
    if (!safe(serviceId)) throw new Error("unsafe service id");
    const id = String(now());
    const dir = join(deps.dir, serviceId, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      for (const [store, cred] of stores) await deps.ops.dumpDatabase(cred, join(dir, `db-${store}.dump`));
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    await prune(serviceId);
    return id;
  }

  async function restoreData(serviceId: string, snapshotId: string): Promise<void> {
    if (snapshotId === NO_DATABASE_SNAPSHOT) return;
    if (!safe(serviceId) || !safe(snapshotId)) throw new Error("unsafe snapshot id");
    const data = deps.dataOf(serviceId);
    const dir = join(deps.dir, serviceId, snapshotId);
    for (const [store, cred] of Object.entries(data?.postgres ?? {})) {
      await deps.ops.restoreDatabase(cred, join(dir, `db-${store}.dump`), { replace: true });
    }
  }

  async function prune(serviceId: string): Promise<void> {
    const base = join(deps.dir, serviceId);
    const ids = (await readdir(base).catch(() => [] as string[])).filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(b) - Number(a));
    for (const old of ids.slice(keep)) await rm(join(base, old), { recursive: true, force: true }).catch(() => {});
  }

  /** An uninstall removes the app's snapshots with it. */
  async function forget(serviceId: string): Promise<void> {
    if (safe(serviceId)) await rm(join(deps.dir, serviceId), { recursive: true, force: true }).catch(() => {});
  }

  return { snapshotData, restoreData, forget };
}
