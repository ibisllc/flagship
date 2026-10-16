/**
 * The size limit a backup policy puts on a server's data (docs/server-backup-
 * and-clone.md, "Backup policy"):
 *
 *   phone → the space the owner's phone keeps for this server's backup;
 *   peer  → a third of the server's own disk (the rest holds other servers'
 *           bricks and its own redundancy);
 *   none / unset → no limit.
 *
 * "Data" is what a backup would hold: each app's databases, files folder and
 * working tree (measured the way the backup sizes itself). Over the limit, the
 * box refuses new apps, app copies onto it and backup imports. Per-app
 * runtime quotas (the disk-quota phase of docs/app-runtimes.md) read
 * `appBudgets()` to hold each app to its share.
 */
import type { AppArchiveBytes } from "../serverArchive/build.js";
import type { BackupPolicyStore, CurrentPolicy } from "./policy.js";

const GB = 1024 ** 3;

export function formatGb(n: number): string {
  return `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;
}

/** The limit for a policy on a disk of `diskBytes`; null when there is none. */
export function limitFor(p: CurrentPolicy, diskBytes: number): number | null {
  if (p.policy === "phone") return p.phoneReserveBytes > 0 ? p.phoneReserveBytes : null;
  if (p.policy === "peer") return Math.floor(diskBytes / 3);
  return null;
}

/** One app's budget: its whole share, and the Postgres and files parts of it (the working tree is fixed). */
export interface AppBudget {
  totalBytes: number;
  postgresBytes: number;
  filesBytes: number;
}

/**
 * Each app's budget under `limit`: what it holds now plus an equal share of
 * the room left (nothing more for any app once the server is over). The
 * growth is split between Postgres and the files folder by what each holds
 * now (half each when both are empty).
 */
export function splitBudget(limit: number, perApp: ReadonlyMap<string, AppArchiveBytes>): Map<string, AppBudget> {
  const used = [...perApp.values()].reduce((a, b) => a + b.totalBytes, 0);
  const room = Math.max(0, limit - used);
  const share = perApp.size > 0 ? Math.floor(room / perApp.size) : 0;
  const out = new Map<string, AppBudget>();
  for (const [id, a] of perApp) {
    const data = a.postgresBytes + a.filesBytes;
    const pgShare = data > 0 ? Math.floor((share * a.postgresBytes) / data) : Math.floor(share / 2);
    out.set(id, { totalBytes: a.totalBytes + share, postgresBytes: a.postgresBytes + pgShare, filesBytes: a.filesBytes + (share - pgShare) });
  }
  return out;
}

export interface BackupCapOptions {
  policy: BackupPolicyStore;
  /** What a backup would hold, per app (null when the box can't size it). */
  measure: () => Promise<Map<string, AppArchiveBytes> | null>;
  /** Size of the disk holding the apps' data. */
  diskBytes: () => Promise<number>;
  note?: (kind: string, detail: string, ok?: boolean) => void;
  now?: () => number;
  log?: (m: string) => void;
}

export interface CapUsage {
  perApp: Map<string, AppArchiveBytes>;
  usedBytes: number;
  measuredAt: number;
}

export class BackupCap {
  private usage: CapUsage | null = null;
  private disk = 0;
  private wasOver = false;
  private readonly now: () => number;

  constructor(private readonly opts: BackupCapOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Measure again (the daemon calls it every few minutes and after app changes). */
  async refresh(): Promise<CapUsage | null> {
    try {
      this.disk = await this.opts.diskBytes();
    } catch (e) {
      this.opts.log?.(`[backup-cap] couldn't size the disk: ${(e as Error).message}`);
    }
    const perApp = await this.opts.measure().catch(() => null);
    if (perApp) {
      this.usage = { perApp, usedBytes: [...perApp.values()].reduce((a, b) => a + b.totalBytes, 0), measuredAt: this.now() };
    }
    const over = this.overLimit();
    if (over && !this.wasOver) {
      this.opts.note?.("server.backup.over-limit", `${this.overSentence()}`, false);
    } else if (!over && this.wasOver) {
      this.opts.note?.("server.backup.under-limit", "This server is back under its backup limit.");
    }
    this.wasOver = over;
    return this.usage;
  }

  diskBytes(): number {
    return this.disk;
  }

  limitBytes(): number | null {
    return limitFor(this.opts.policy.current(), this.disk);
  }

  /** Space a peer-policy server keeps for other servers' bricks and its own redundancy; null otherwise. */
  reservedForPeersBytes(): number | null {
    return this.opts.policy.current().policy === "peer" ? this.disk - Math.floor(this.disk / 3) : null;
  }

  usedBytes(): number | null {
    return this.usage?.usedBytes ?? null;
  }

  overLimit(): boolean {
    const limit = this.limitBytes();
    const used = this.usedBytes();
    return limit !== null && used !== null && used >= limit;
  }

  /** Each app's share of the limit (for per-app quotas); null with no limit or no measurement. */
  appBudgets(): Map<string, AppBudget> | null {
    const limit = this.limitBytes();
    if (limit === null || !this.usage) return null;
    return splitBudget(limit, this.usage.perApp);
  }

  private overSentence(): string {
    const p = this.opts.policy.current();
    const limit = this.limitBytes() ?? 0;
    const why =
      p.policy === "phone"
        ? "the space your phone keeps for its backup"
        : "a third of its disk, so other servers can keep their backups on it";
    return `This server holds ${formatGb(this.usedBytes() ?? 0)} of app data, over its backup limit of ${formatGb(limit)} (${why}). Remove apps or data, or change the backup policy on the server page.`;
  }

  /**
   * Whether a new app (or a copy or import of `incomingBytes`) may come onto
   * this server: null when it may, else the sentence the owner sees.
   */
  admit(incomingBytes = 0): string | null {
    const limit = this.limitBytes();
    const used = this.usedBytes();
    if (limit === null || used === null) return null;
    if (used >= limit) return this.overSentence();
    if (incomingBytes > 0 && used + incomingBytes > limit) {
      return `That needs about ${formatGb(incomingBytes)} and this server has ${formatGb(limit - used)} left under its backup limit of ${formatGb(limit)}. Remove apps or data, or change the backup policy on the server page.`;
    }
    return null;
  }

  /** What the server page shows. */
  view() {
    const limit = this.limitBytes();
    return {
      limitBytes: limit,
      usedBytes: this.usedBytes(),
      measuredAt: this.usage?.measuredAt ?? null,
      overLimit: this.overLimit(),
      diskBytes: this.disk,
      reservedForPeersBytes: this.reservedForPeersBytes(),
      apps: this.usage ? [...this.usage.perApp].map(([serviceId, a]) => ({ serviceId, bytes: a.totalBytes })) : [],
      ...(this.overLimit() ? { overReason: this.overSentence() } : {}),
    };
  }
}
