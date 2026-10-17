/**
 * The arithmetic of per-app disk limits (docs/app-runtimes.md §5.3): no I/O,
 * so every threshold is pinned by a unit test. The enforcement lives in
 * `loopVolumes.ts` (files) and `pgQuota.ts` (Postgres); `manager.ts` ties
 * them to the backup policy's per-app budgets (backupPolicy/cap.ts).
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** A staging copy's files folder (sample data only). */
export const DEV_FILES_QUOTA_BYTES = 512 * MiB;
/** A staging copy's database. */
export const DEV_PG_QUOTA_BYTES = 256 * MiB;
/** What one `docker build` may add to the box's disk. */
export const BUILD_DISK_QUOTA_BYTES = 4 * GiB;
/** No files image is smaller (ext4's own metadata needs room). */
export const MIN_IMAGE_BYTES = 64 * MiB;

/** The host-disk brake: on at 90 % used, off again under 88 %, files read-only at 95 %. */
export const BRAKE_ON = 0.9;
export const BRAKE_OFF = 0.88;
export const BRAKE_HARD = 0.95;

export type BrakeState = "off" | "on" | "hard";

export interface DiskUse {
  totalBytes: number;
  /** What a non-root writer can still use. */
  availBytes: number;
}

export function usedFraction(d: DiskUse): number {
  if (d.totalBytes <= 0) return 0;
  return Math.min(1, Math.max(0, (d.totalBytes - d.availBytes) / d.totalBytes));
}

/** The brake after one reading, with hysteresis so it doesn't flap. */
export function nextBrake(prev: BrakeState, d: DiskUse): BrakeState {
  const f = usedFraction(d);
  if (f >= BRAKE_HARD) return "hard";
  if (f >= BRAKE_ON) return "on";
  if (prev !== "off" && f >= BRAKE_OFF) return prev === "hard" ? "on" : prev;
  return "off";
}

/**
 * The size a files image should have. With a budget, the budget (floored);
 * without one, 90 % of the host disk: the image is sparse, so only what the
 * app writes takes room, and the brake guards the box.
 */
export function imageTarget(limitBytes: number | null, hostTotalBytes: number): number {
  const want = limitBytes ?? Math.floor(hostTotalBytes * BRAKE_ON);
  return roundUpMiB(Math.max(MIN_IMAGE_BYTES, want));
}

/**
 * Whether to grow an image to `target`: only for a real step (5 % or 64 MiB),
 * so a budget that moves a little each refresh doesn't resize every time.
 * A lower limit is held by the ballast (`ballastTarget`), never by shrinking.
 */
export function shouldGrow(currentBytes: number, target: number): boolean {
  return target > currentBytes && target - currentBytes >= Math.max(64 * MiB, currentBytes * 0.05);
}

/**
 * How big the image's ballast file should be: a preallocated file at the
 * image's root, outside the `data/` folder the app sees, that takes up what
 * is above the app's limit (an image bigger than its limit after a budget
 * fell), or, under the brake (`freeze`), all the room that's free now. It
 * binds every writer, root included (ext4's reserved blocks don't, and
 * tune2fs caps them at half the filesystem), costs the box's disk nothing
 * (preallocated blocks are never written), and frees at once when truncated.
 */
export function ballastTarget(a: {
  /** The filesystem's capacity (statfs blocks). */
  capacityBytes: number;
  ballastBytes: number;
  availBytes: number;
  limitBytes: number | null;
  freeze: boolean;
}): number {
  const want = a.freeze
    ? a.ballastBytes + a.availBytes
    : a.limitBytes === null
      ? 0
      : Math.max(0, a.capacityBytes - a.limitBytes);
  return Math.floor(want / 4096) * 4096;
}

/**
 * One app's budget, re-split between the stores it has. The backup cap gives
 * each app what it holds plus a share of the room left, split by what each
 * store holds now; a store holding almost nothing (a new app's files folder
 * next to a database that starts with its extensions) would get almost no
 * room. Here the growth goes by that proportion, but no store the app has
 * gets less than a quarter of it, and a store it doesn't have gets none.
 */
export function splitStores(a: {
  filesBudget: number;
  postgresBudget: number;
  filesUsed: number;
  postgresUsed: number;
  hasFiles: boolean;
  hasPostgres: boolean;
}): { filesBytes: number; postgresBytes: number } {
  const growth = Math.max(0, a.filesBudget + a.postgresBudget - a.filesUsed - a.postgresUsed);
  if (!a.hasFiles) return { filesBytes: 0, postgresBytes: a.postgresUsed + growth };
  if (!a.hasPostgres) return { filesBytes: a.filesUsed + growth, postgresBytes: 0 };
  const used = a.filesUsed + a.postgresUsed;
  const share = Math.min(0.75, Math.max(0.25, used > 0 ? a.filesUsed / used : 0.5));
  const files = Math.floor(growth * share);
  return { filesBytes: a.filesUsed + files, postgresBytes: a.postgresUsed + (growth - files) };
}

/** A files folder is full when less than 1 MiB (or 0.5 % of its limit) is left. */
export function filesFull(availBytes: number, limitBytes: number): boolean {
  return availBytes < Math.max(MiB, limitBytes * 0.005);
}

/** ...and has room again once 2 % (at least 4 MiB) is free. */
export function filesRecovered(availBytes: number, limitBytes: number): boolean {
  return availBytes >= Math.max(4 * MiB, limitBytes * 0.02);
}

/**
 * A database's write state. `open`: normal. `blocked`: INSERT and UPDATE
 * revoked (reads, DELETE and TRUNCATE still work, so the app can make
 * room). `stopped`: the app kept growing while blocked (it re-granted
 * itself), so its role can't log in until it is back under its limit.
 */
export type PgStage = "open" | "blocked" | "stopped";

/** Room under the limit a blocked database must reach before writes come back. */
export function pgHysteresis(limitBytes: number): number {
  return Math.max(MiB, Math.floor(limitBytes * 0.01));
}

/** Growth past the size it was blocked at that counts as getting around the block. */
export function pgSlack(limitBytes: number | null): number {
  return Math.max(64 * MiB, Math.floor((limitBytes ?? 0) * 0.1));
}

export interface PgReading {
  stage: PgStage;
  /** pg_database_size over the app's databases. */
  rawBytes: number;
  /** rawBytes less the room Postgres can reuse (its free space map); equal to raw well under the limit. */
  effectiveBytes: number;
  limitBytes: number | null;
  brake: BrakeState;
  /** rawBytes when it was blocked (null while open). */
  blockedAtBytes: number | null;
}

/** Whether a reading needs the (costlier) free-space measurement. */
export function needsEffective(stage: PgStage, rawBytes: number, limitBytes: number | null): boolean {
  if (limitBytes === null) return false;
  if (stage === "open") return rawBytes >= limitBytes;
  return rawBytes >= limitBytes - pgHysteresis(limitBytes);
}

export function nextPgStage(r: PgReading): PgStage {
  const overLimit = r.limitBytes !== null && r.effectiveBytes >= r.limitBytes;
  const braking = r.brake !== "off";
  if (r.stage === "open") return overLimit || braking ? "blocked" : "open";
  const clear =
    !braking && (r.limitBytes === null || r.effectiveBytes < r.limitBytes - pgHysteresis(r.limitBytes));
  if (clear) return "open";
  if (r.stage === "blocked") {
    const base = r.blockedAtBytes ?? r.rawBytes;
    return r.rawBytes > base + pgSlack(r.limitBytes) ? "stopped" : "blocked";
  }
  return "stopped";
}

function roundUpMiB(n: number): number {
  return Math.ceil(n / MiB) * MiB;
}
