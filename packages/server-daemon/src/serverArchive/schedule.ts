/**
 * When a server makes its scheduled backups, and which ones it keeps
 * (docs/server-backup-and-clone.md, "Scheduled backups"). Pure: no clock, no disk.
 *
 * A run is due once per slot (each day, or each week, at the owner's time,
 * in UTC; the apps show it in local time). A box that was off or busy for a
 * slot catches up as soon as it can; a failed run is retried an hour later,
 * at most three times per slot.
 */

export type BackupFrequency = "daily" | "weekly" | "off";

export interface BackupSchedule {
  frequency: BackupFrequency;
  /** Minutes after 00:00 UTC, 0..1439. */
  minuteOfDayUtc: number;
  /** 0 = Sunday .. 6 = Saturday (UTC); used when weekly. */
  weekdayUtc: number;
  /** The newest backup of each of this many most recent days is kept. */
  keepDaily: number;
  /** The newest backup of each of this many most recent ISO weeks is kept. */
  keepWeekly: number;
}

export const DEFAULT_SCHEDULE: BackupSchedule = {
  frequency: "daily",
  minuteOfDayUtc: 3 * 60,
  weekdayUtc: 0,
  keepDaily: 7,
  keepWeekly: 4,
};

export const RETRY_AFTER_MS = 60 * 60_000;
export const MAX_TRIES_PER_SLOT = 3;
const DAY_MS = 24 * 60 * 60_000;

/** The schedule from untrusted JSON, or a sentence saying what's wrong. */
export function parseSchedule(v: unknown): BackupSchedule | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "send a schedule";
  const r = v as Record<string, unknown>;
  const freq = r.frequency;
  if (freq !== "daily" && freq !== "weekly" && freq !== "off") return "frequency must be daily, weekly or off";
  const int = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
  if (!int(r.minuteOfDayUtc, 0, 1439)) return "the time must be a minute of the day (0 to 1439)";
  const weekday = r.weekdayUtc ?? 0;
  if (!int(weekday, 0, 6)) return "the weekday must be 0 (Sunday) to 6";
  if (!int(r.keepDaily, 0, 60)) return "keep between 0 and 60 daily backups";
  if (!int(r.keepWeekly, 0, 52)) return "keep between 0 and 52 weekly backups";
  if ((r.keepDaily as number) + (r.keepWeekly as number) === 0) return "keep at least one backup";
  return {
    frequency: freq,
    minuteOfDayUtc: r.minuteOfDayUtc as number,
    weekdayUtc: weekday as number,
    keepDaily: r.keepDaily as number,
    keepWeekly: r.keepWeekly as number,
  };
}

/** The start of the latest slot at or before `now`; null when off. */
export function slotStartAtOrBefore(s: BackupSchedule, now: number): number | null {
  if (s.frequency === "off") return null;
  const day0 = Math.floor(now / DAY_MS) * DAY_MS;
  let t = day0 + s.minuteOfDayUtc * 60_000;
  if (t > now) t -= DAY_MS;
  if (s.frequency === "weekly") {
    while (new Date(t).getUTCDay() !== s.weekdayUtc) t -= DAY_MS;
  }
  return t;
}

export function nextSlotAfter(s: BackupSchedule, now: number): number | null {
  const last = slotStartAtOrBefore(s, now);
  if (last === null) return null;
  return last + (s.frequency === "weekly" ? 7 : 1) * DAY_MS;
}

export interface RunHistory {
  /** When the latest run (of any kind) started. */
  lastAttemptAt: number | null;
  lastOk: boolean | null;
  /** Scheduled runs started in the current slot. */
  triesThisSlot: number;
  /** The slot those tries belong to. */
  triesSlot: number | null;
}

/** Whether a scheduled run should start now. */
export function isDue(s: BackupSchedule, h: RunHistory, now: number): boolean {
  const slot = slotStartAtOrBefore(s, now);
  if (slot === null) return false;
  if (h.lastAttemptAt === null || h.lastAttemptAt < slot) return true;
  // Already tried in this slot: only a failure is retried, an hour later, a few times.
  if (h.lastOk !== false) return false;
  const tries = h.triesSlot === slot ? h.triesThisSlot : 0;
  return tries < MAX_TRIES_PER_SLOT && now - h.lastAttemptAt >= RETRY_AFTER_MS;
}

/** When the next scheduled run will start (for the apps); null when off. */
export function nextRunAt(s: BackupSchedule, h: RunHistory, now: number): number | null {
  if (s.frequency === "off") return null;
  if (isDue(s, h, now)) return now;
  const slot = slotStartAtOrBefore(s, now)!;
  if (h.lastOk === false && h.triesSlot === slot && h.triesThisSlot < MAX_TRIES_PER_SLOT && h.lastAttemptAt !== null) {
    return h.lastAttemptAt + RETRY_AFTER_MS;
  }
  return nextSlotAfter(s, now);
}

function isoWeekKey(t: number): string {
  const d = new Date(Math.floor(t / DAY_MS) * DAY_MS);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${week}`;
}

/**
 * The backups to keep: the newest of each of the `keepDaily` most recent days
 * that have one, the newest of each of the `keepWeekly` most recent ISO weeks
 * that have one, and always the newest of all.
 */
export function retained<T extends { id: string; createdAt: number }>(backups: readonly T[], s: Pick<BackupSchedule, "keepDaily" | "keepWeekly">): Set<string> {
  const sorted = [...backups].sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Set<string>();
  if (sorted[0]) keep.add(sorted[0].id);
  const pick = (key: (t: number) => string, n: number) => {
    const seen = new Set<string>();
    for (const b of sorted) {
      if (seen.size >= n) break;
      const k = key(b.createdAt);
      if (seen.has(k)) continue;
      seen.add(k);
      keep.add(b.id);
    }
  };
  pick((t) => String(Math.floor(t / DAY_MS)), s.keepDaily);
  pick(isoWeekKey, s.keepWeekly);
  return keep;
}
