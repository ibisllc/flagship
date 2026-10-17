/**
 * Holds every app to its share of the server's backup-policy limit
 * (docs/app-runtimes.md §5.3, docs/server-backup-and-clone.md "Backup
 * policy"). Every tick (2 minutes, and at once when the policy changes) it
 * reads the per-app budgets from backupPolicy/cap.ts, measures each app's
 * files folder and databases, and enforces:
 *
 *   files     the folder's ext4 image (loopVolumes.ts): grown to the budget,
 *             a lower budget held by a preallocated ballast file;
 *   Postgres  writes revoked at the budget, back below it (pgQuota.ts);
 *   the box   a brake on the host disk that applies whatever the policy
 *             (none included): at 90 % no app can write more, at 95 % app
 *             folders go read-only, off again under 88 %.
 *
 * Staging copies get fixed small limits. When an app fills up, the owner
 * hears it once (an Activity entry and a content-free push); the same
 * numbers are on server-detail and app-detail.
 */
import { readStateFile, writeFileDurable } from "../durableFile.js";
import { DEV_FILES_PREFIX } from "../dataLayer/naming.js";
import {
  DEV_FILES_QUOTA_BYTES,
  DEV_PG_QUOTA_BYTES,
  filesFull,
  filesRecovered,
  imageTarget,
  needsEffective,
  nextBrake,
  nextPgStage,
  splitStores,
  usedFraction,
  type BrakeState,
  type DiskUse,
  type PgStage,
} from "./limits.js";
import type { FsUsage, PrepareResult } from "./loopVolumes.js";
import { emptyRevocation, type PgQuotaAdmin, type PgRevocation } from "./pgQuota.js";

/** One app's budget (backupPolicy/cap.ts `AppBudget`). */
export interface AppBudget {
  totalBytes: number;
  postgresBytes: number;
  filesBytes: number;
}

export interface QuotaApp {
  serviceId: string;
  files?: { volume: string } | undefined;
  postgres: ReadonlyArray<{ database: string; role: string }>;
}

/** The part of LoopVolumes the manager drives (a fake in tests). */
export interface QuotaFiles {
  prepare(volume: string, sizeBytes: number): Promise<PrepareResult>;
  applyLimit(volume: string, a: { imageBytes: number; limitBytes: number | null; freeze: boolean }): Promise<FsUsage | null>;
  setReadOnly(volume: string, readOnly: boolean): Promise<void>;
  listImages(): Promise<string[]>;
}

export type QuotaStore = "files" | "postgres";

export interface QuotaEvent {
  serviceId: string;
  store: QuotaStore;
  usedBytes: number;
  limitBytes: number | null;
}

export interface StoreView {
  usedBytes: number;
  limitBytes: number | null;
  full: boolean;
}

export interface AppStorageView {
  files?: StoreView & { enforced: boolean };
  postgres?: StoreView & { writesBlocked: boolean; stopped: boolean };
}

export interface ServerStorageView {
  disk: { totalBytes: number; usedBytes: number } | null;
  /** "on": no app can write more; "hard": app folders are read-only. */
  brake: BrakeState;
  /** Whether a backup policy sets a limit (otherwise only the brake applies). */
  capped: boolean;
  apps: Array<{ serviceId: string } & AppStorageView>;
}

export interface AppQuotaManagerOptions {
  apps: () => readonly QuotaApp[];
  /** Per-app budgets, or null when the policy sets no limit. */
  budgets: () => ReadonlyMap<string, AppBudget> | null;
  /**
   * Room left under the limit (null: no limit): what a folder made before
   * its app has a budget (an install, a copy or an import arriving) may hold.
   */
  roomBytes?: () => number | null;
  files: QuotaFiles | null;
  /** Null until Postgres is up. */
  pg: () => PgQuotaAdmin | null;
  /** Staging databases (`__dev_…`, database = role). */
  devDatabases?: () => Promise<string[]>;
  hostDisk: () => Promise<DiskUse | null>;
  statePath: string | null;
  onFull?: (e: QuotaEvent) => void;
  onRoom?: (e: QuotaEvent) => void;
  onBrake?: (state: BrakeState, prev: BrakeState) => void;
  intervalMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

interface PgState {
  stage: PgStage;
  /** Per database: what was revoked. */
  revoked: Record<string, PgRevocation>;
  blockedAtBytes: number | null;
  lastVacuumAt?: number;
}

interface PersistedState {
  brake: BrakeState;
  pg: Record<string, PgState>;
  full: string[];
}

const VACUUM_EVERY_MS = 10 * 60_000;

export class AppQuotaManager {
  private state: PersistedState = { brake: "off", pg: {}, full: [] };
  private readonly views = new Map<string, AppStorageView>();
  /** Roles given their limits (APP_ROLE_LIMITS) by this process: older ones get them at boot. */
  private readonly limitedRoles = new Set<string>();
  private disk: DiskUse | null = null;
  private capped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly log: (m: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: AppQuotaManagerOptions) {
    this.log = opts.log ?? ((m) => console.warn(m));
    this.now = opts.now ?? Date.now;
  }

  /** Where budgets come from (the backup cap, wired after the manager is built). */
  setBudgets(budgets: () => ReadonlyMap<string, AppBudget> | null, roomBytes?: () => number | null): void {
    this.opts.budgets = budgets;
    this.opts.roomBytes = roomBytes;
  }

  /** Who hears when an app fills up, has room again, or the disk brake moves. */
  setEvents(e: Pick<AppQuotaManagerOptions, "onFull" | "onRoom" | "onBrake">): void {
    this.opts.onFull = e.onFull;
    this.opts.onRoom = e.onRoom;
    this.opts.onBrake = e.onBrake;
  }

  async load(): Promise<void> {
    if (!this.opts.statePath) return;
    const r = await readStateFile(this.opts.statePath);
    if (r.kind !== "ok") return;
    try {
      const raw = JSON.parse(r.text) as Partial<PersistedState>;
      this.state = {
        brake: raw.brake === "on" || raw.brake === "hard" ? raw.brake : "off",
        pg: raw.pg && typeof raw.pg === "object" ? raw.pg : {},
        full: Array.isArray(raw.full) ? raw.full.filter((k) => typeof k === "string") : [],
      };
    } catch {
      /* start clean: the next tick re-measures everything */
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.kick(), this.opts.intervalMs ?? 120_000);
    (this.timer as { unref?: () => void }).unref?.();
    void this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run a tick now (a policy change); one at a time, a kick during one runs another after it. */
  kick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.tick().catch((e: Error) => this.log(`[app-quota] tick failed: ${e.message}`));
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Before a container mounts `volume`: its image mounted, an older plain volume moved into one. */
  async prepareVolume(volume: string): Promise<PrepareResult> {
    if (!this.opts.files) return "plain";
    return this.opts.files.prepare(volume, await this.imageSizeFor(volume));
  }

  /** The image a volume should start with (its budget, a staging copy's quota, or the safety size). */
  async imageSizeFor(volume: string): Promise<number> {
    if (volume.startsWith(DEV_FILES_PREFIX)) return DEV_FILES_QUOTA_BYTES;
    const app = this.opts.apps().find((a) => a.files?.volume === volume);
    const budgets = this.opts.budgets();
    const budget = app ? budgets?.get(app.serviceId) : undefined;
    if (budget) return imageTarget(budget.filesBytes, 0);
    if (budgets) {
      // A new app under a limit: all the room left; the next tick gives it its share.
      const room = this.opts.roomBytes?.() ?? null;
      if (room !== null) return imageTarget(Math.max(0, room), 0);
    }
    this.disk ??= await this.opts.hostDisk().catch(() => null);
    return imageTarget(null, this.disk?.totalBytes ?? 0);
  }

  /** What each app holds, as last measured (null: not known). */
  measured(): Map<string, { filesBytes: number | null; postgresBytes: number | null }> {
    const out = new Map<string, { filesBytes: number | null; postgresBytes: number | null }>();
    for (const [id, v] of this.views) {
      out.set(id, { filesBytes: v.files?.usedBytes ?? null, postgresBytes: v.postgres?.usedBytes ?? null });
    }
    return out;
  }

  appView(serviceId: string): AppStorageView | null {
    return this.views.get(serviceId) ?? null;
  }

  serverView(): ServerStorageView {
    return {
      disk: this.disk ? { totalBytes: this.disk.totalBytes, usedBytes: this.disk.totalBytes - this.disk.availBytes } : null,
      brake: this.state.brake,
      capped: this.capped,
      apps: [...this.views].map(([serviceId, v]) => ({ serviceId, ...v })),
    };
  }

  private async tick(): Promise<void> {
    const before = JSON.stringify(this.state);
    const disk = await this.opts.hostDisk().catch(() => null);
    this.disk = disk;
    const prevBrake = this.state.brake;
    const brake = disk ? nextBrake(prevBrake, disk) : prevBrake;
    if (brake !== prevBrake) {
      this.state.brake = brake;
      this.log(`[app-quota] disk brake ${prevBrake} → ${brake} (${disk ? Math.round(usedFraction(disk) * 100) : "?"}% used)`);
      this.opts.onBrake?.(brake, prevBrake);
    }
    const budgets = this.opts.budgets();
    this.capped = budgets !== null;
    const apps = this.opts.apps();
    const pg = this.opts.pg();
    const sizes = pg ? await this.pgSizes(pg, apps) : new Map<string, number>();
    if (pg) await this.limitRoles(pg, apps.flatMap((a) => a.postgres.map((p) => p.role)));
    const seen = new Set<string>();
    for (const app of apps) {
      seen.add(app.serviceId);
      // Under a limit, an app the budgets don't name yet (just installed) may use the room left.
      const room = budgets ? Math.max(0, this.opts.roomBytes?.() ?? 0) : 0;
      const given = budgets?.get(app.serviceId);
      const before = this.views.get(app.serviceId);
      // Re-split between its stores once both have been measured (splitStores).
      const measured = (!app.files || before?.files) && (app.postgres.length === 0 || before?.postgres);
      const budget = !budgets
        ? null
        : !given
          ? { totalBytes: room, filesBytes: room, postgresBytes: room }
          : !measured
            ? given
            : {
                totalBytes: given.totalBytes,
                ...splitStores({
                  filesBudget: given.filesBytes,
                  postgresBudget: given.postgresBytes,
                  filesUsed: before?.files?.usedBytes ?? 0,
                  postgresUsed: before?.postgres?.usedBytes ?? 0,
                  hasFiles: !!app.files,
                  hasPostgres: app.postgres.length > 0,
                }),
              };
      const view: AppStorageView = {};
      if (app.files && this.opts.files) {
        try {
          const v = await this.files(app.serviceId, app.files.volume, budget ? budget.filesBytes : null, brake, disk);
          if (v) view.files = v;
        } catch (e) {
          this.log(`[app-quota] ${app.serviceId}: files limit not applied: ${(e as Error).message}`);
        }
      }
      if (app.postgres.length > 0 && pg) {
        try {
          view.postgres = await this.postgres(pg, app, budget ? budget.postgresBytes : null, brake, sizes);
        } catch (e) {
          this.log(`[app-quota] ${app.serviceId}: database limit not applied: ${(e as Error).message}`);
        }
      }
      this.views.set(app.serviceId, view);
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.views.delete(id);
    for (const id of Object.keys(this.state.pg)) {
      if (!id.startsWith("dev:") && !seen.has(id)) delete this.state.pg[id];
    }
    this.state.full = this.state.full.filter((k) => seen.has(k.slice(0, k.lastIndexOf(":"))));
    await this.staging(brake, pg).catch((e: Error) => this.log(`[app-quota] staging limits not applied: ${e.message}`));
    const after = JSON.stringify(this.state);
    if (after !== before && this.opts.statePath) {
      await writeFileDurable(this.opts.statePath, after).catch((e: Error) =>
        this.log(`[app-quota] couldn't save its state: ${e.message}`),
      );
    }
  }

  private async limitRoles(pg: PgQuotaAdmin, roles: readonly string[]): Promise<void> {
    for (const role of roles) {
      if (this.limitedRoles.has(role)) continue;
      try {
        await pg.applyRoleLimits(role);
        this.limitedRoles.add(role);
      } catch (e) {
        this.log(`[app-quota] couldn't set ${role}'s limits: ${(e as Error).message}`);
      }
    }
  }

  private async pgSizes(pg: PgQuotaAdmin, apps: readonly QuotaApp[]): Promise<Map<string, number>> {
    const dbs = apps.flatMap((a) => a.postgres.map((p) => p.database));
    try {
      return await pg.sizes(dbs);
    } catch (e) {
      this.log(`[app-quota] couldn't measure the databases: ${(e as Error).message}`);
      return new Map();
    }
  }

  private async files(
    serviceId: string,
    volume: string,
    limit: number | null,
    brake: BrakeState,
    disk: DiskUse | null,
  ): Promise<(StoreView & { enforced: boolean }) | null> {
    const files = this.opts.files!;
    const u = await files.applyLimit(volume, {
      imageBytes: imageTarget(limit, disk?.totalBytes ?? 0),
      limitBytes: limit,
      freeze: brake !== "off",
    });
    if (!u) {
      // No image (an older volume a container still holds): measured elsewhere, not limited yet.
      return null;
    }
    await files.setReadOnly(volume, brake === "hard");
    const cap = limit ?? u.sizeBytes;
    const key = `${serviceId}:files`;
    const wasFull = this.state.full.includes(key);
    // Under the brake every folder is frozen: that's the brake's one event,
    // not one per app, and each app's own state waits for it to lift.
    const full = brake !== "off" ? wasFull : wasFull ? !filesRecovered(u.availBytes, cap) : filesFull(u.availBytes, cap);
    this.transition(key, wasFull, full, { serviceId, store: "files", usedBytes: u.usedBytes, limitBytes: limit });
    return { usedBytes: u.usedBytes, limitBytes: limit, full: full || brake !== "off", enforced: true };
  }

  private transition(key: string, wasFull: boolean, full: boolean, e: QuotaEvent): void {
    if (full === wasFull) return;
    if (full) {
      this.state.full.push(key);
      this.opts.onFull?.(e);
    } else {
      this.state.full = this.state.full.filter((k) => k !== key);
      this.opts.onRoom?.(e);
    }
  }

  private async postgres(
    pg: PgQuotaAdmin,
    app: QuotaApp,
    limit: number | null,
    brake: BrakeState,
    sizes: Map<string, number>,
  ): Promise<StoreView & { writesBlocked: boolean; stopped: boolean }> {
    const raw = app.postgres.reduce((n, p) => n + (sizes.get(p.database) ?? 0), 0);
    const st = await this.stepPg(pg, app.serviceId, app.postgres, raw, limit, brake);
    const key = `${app.serviceId}:postgres`;
    const wasFull = this.state.full.includes(key);
    const full = brake !== "off" ? wasFull : st.stage !== "open";
    this.transition(key, wasFull, full, { serviceId: app.serviceId, store: "postgres", usedBytes: raw, limitBytes: limit });
    const blocked = st.stage !== "open";
    return { usedBytes: raw, limitBytes: limit, full: blocked, writesBlocked: blocked, stopped: st.stage === "stopped" };
  }

  /** One step of a database group's stage machine (an app's databases, or one staging database). */
  private async stepPg(
    pg: PgQuotaAdmin,
    key: string,
    dbs: ReadonlyArray<{ database: string; role: string }>,
    raw: number,
    limit: number | null,
    brake: BrakeState,
  ): Promise<{ stage: PgStage; effective: number }> {
    const cur: PgState = this.state.pg[key] ?? { stage: "open", revoked: {}, blockedAtBytes: null };
    let effective = raw;
    if (needsEffective(cur.stage, raw, limit)) {
      let free = 0;
      for (const d of dbs) free += await pg.freeBytes(d.database).catch(() => 0);
      effective = Math.max(0, raw - free);
    }
    const next = nextPgStage({ stage: cur.stage, rawBytes: raw, effectiveBytes: effective, limitBytes: limit, brake, blockedAtBytes: cur.blockedAtBytes });
    if (next === "open") {
      if (cur.stage !== "open") {
        for (const d of dbs) {
          if (cur.stage === "stopped") await pg.setLogin(d.role, true);
          await pg.unblock(d.database, d.role, cur.revoked[d.database] ?? emptyRevocation());
        }
        this.log(`[app-quota] ${key}: database writes back`);
      }
      delete this.state.pg[key];
      return { stage: "open", effective };
    }
    const nextState: PgState = {
      stage: next,
      revoked: { ...cur.revoked },
      blockedAtBytes: cur.blockedAtBytes ?? raw,
      ...(cur.lastVacuumAt !== undefined ? { lastVacuumAt: cur.lastVacuumAt } : {}),
    };
    // Block again every tick: tables made since, and anything the app re-granted itself.
    for (const d of dbs) {
      nextState.revoked[d.database] = await pg.block(d.database, d.role, cur.revoked[d.database] ?? emptyRevocation());
    }
    if (next === "stopped" && cur.stage !== "stopped") {
      for (const d of dbs) await pg.setLogin(d.role, false);
      this.log(`[app-quota] ${key}: kept growing while its writes were blocked; its database is stopped until it's under its limit`);
    } else if (cur.stage === "open") {
      this.log(`[app-quota] ${key}: database writes blocked (${raw} bytes, limit ${limit ?? "none"}, disk brake ${brake})`);
    }
    const t = this.now();
    if (limit !== null && (nextState.lastVacuumAt === undefined || t - nextState.lastVacuumAt >= VACUUM_EVERY_MS)) {
      for (const d of dbs) await pg.vacuum(d.database).catch(() => {});
      nextState.lastVacuumAt = t;
    }
    this.state.pg[key] = nextState;
    return { stage: next, effective };
  }

  private async staging(brake: BrakeState, pg: PgQuotaAdmin | null): Promise<void> {
    const files = this.opts.files;
    if (files) {
      for (const volume of await files.listImages()) {
        if (!volume.startsWith(DEV_FILES_PREFIX)) continue;
        await files
          .applyLimit(volume, { imageBytes: DEV_FILES_QUOTA_BYTES, limitBytes: DEV_FILES_QUOTA_BYTES, freeze: brake !== "off" })
          .catch((e: Error) => this.log(`[app-quota] ${volume}: ${e.message}`));
      }
    }
    if (!pg || !this.opts.devDatabases) return;
    const dev = await this.opts.devDatabases();
    await this.limitRoles(pg, dev);
    const sizes = await pg.sizes(dev);
    const live = new Set<string>();
    for (const db of dev) {
      const key = `dev:${db}`;
      live.add(key);
      await this.stepPg(pg, key, [{ database: db, role: db }], sizes.get(db) ?? 0, DEV_PG_QUOTA_BYTES, brake).catch((e: Error) =>
        this.log(`[app-quota] ${key}: ${e.message}`),
      );
    }
    for (const id of Object.keys(this.state.pg)) if (id.startsWith("dev:") && !live.has(id)) delete this.state.pg[id];
  }
}
