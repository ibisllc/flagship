import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  MAX_TRIES_PER_SLOT,
  RETRY_AFTER_MS,
  isDue,
  nextRunAt,
  parseSchedule,
  retained,
  slotStartAtOrBefore,
  type RunHistory,
} from "../../src/serverArchive/schedule.js";

const H = 60 * 60_000;
const DAY = 24 * H;
const never: RunHistory = { lastAttemptAt: null, lastOk: null, triesThisSlot: 0, triesSlot: null };
// Wednesday 2026-10-14 12:00 UTC.
const WED_NOON = Date.UTC(2026, 9, 14, 12);
const daily = { ...DEFAULT_SCHEDULE };

describe("backup schedule", () => {
  it("defaults to daily at 03:00 UTC, keeping 7 daily and 4 weekly", () => {
    expect(DEFAULT_SCHEDULE).toEqual({ frequency: "daily", minuteOfDayUtc: 180, weekdayUtc: 0, keepDaily: 7, keepWeekly: 4 });
  });

  it("finds the latest slot for daily and weekly", () => {
    expect(slotStartAtOrBefore(daily, WED_NOON)).toBe(Date.UTC(2026, 9, 14, 3));
    expect(slotStartAtOrBefore(daily, Date.UTC(2026, 9, 14, 2))).toBe(Date.UTC(2026, 9, 13, 3));
    const sunday = { ...daily, frequency: "weekly" as const, weekdayUtc: 0 };
    expect(slotStartAtOrBefore(sunday, WED_NOON)).toBe(Date.UTC(2026, 9, 11, 3));
    expect(slotStartAtOrBefore({ ...daily, frequency: "off" }, WED_NOON)).toBeNull();
  });

  it("is due once per slot, and catches up a missed one", () => {
    expect(isDue(daily, never, WED_NOON)).toBe(true);
    const ranToday = { lastAttemptAt: Date.UTC(2026, 9, 14, 3, 1), lastOk: true, triesThisSlot: 1, triesSlot: Date.UTC(2026, 9, 14, 3) };
    expect(isDue(daily, ranToday, WED_NOON)).toBe(false);
    expect(nextRunAt(daily, ranToday, WED_NOON)).toBe(Date.UTC(2026, 9, 15, 3));
    // Off for two days: runs as soon as it is back, not at the next 03:00.
    const ranMonday = { ...ranToday, lastAttemptAt: Date.UTC(2026, 9, 12, 3) };
    expect(isDue(daily, ranMonday, WED_NOON)).toBe(true);
    expect(nextRunAt(daily, ranMonday, WED_NOON)).toBe(WED_NOON);
    expect(isDue({ ...daily, frequency: "off" }, never, WED_NOON)).toBe(false);
    expect(nextRunAt({ ...daily, frequency: "off" }, never, WED_NOON)).toBeNull();
  });

  it("retries a failed run an hour later, at most three times per slot", () => {
    const slot = Date.UTC(2026, 9, 14, 3);
    const failed = (tries: number, at: number): RunHistory => ({ lastAttemptAt: at, lastOk: false, triesThisSlot: tries, triesSlot: slot });
    expect(isDue(daily, failed(1, WED_NOON - 10 * 60_000), WED_NOON)).toBe(false);
    expect(nextRunAt(daily, failed(1, WED_NOON - 10 * 60_000), WED_NOON)).toBe(WED_NOON - 10 * 60_000 + RETRY_AFTER_MS);
    expect(isDue(daily, failed(1, WED_NOON - RETRY_AFTER_MS), WED_NOON)).toBe(true);
    expect(isDue(daily, failed(MAX_TRIES_PER_SLOT, WED_NOON - 5 * H), WED_NOON)).toBe(false);
    expect(nextRunAt(daily, failed(MAX_TRIES_PER_SLOT, WED_NOON - 5 * H), WED_NOON)).toBe(slot + DAY);
  });

  it("parses a schedule and explains what is wrong", () => {
    expect(parseSchedule({ frequency: "weekly", minuteOfDayUtc: 0, weekdayUtc: 6, keepDaily: 0, keepWeekly: 8 })).toEqual({
      frequency: "weekly",
      minuteOfDayUtc: 0,
      weekdayUtc: 6,
      keepDaily: 0,
      keepWeekly: 8,
    });
    expect(parseSchedule({ frequency: "hourly", minuteOfDayUtc: 0, keepDaily: 1, keepWeekly: 1 })).toMatch(/daily, weekly or off/);
    expect(parseSchedule({ frequency: "daily", minuteOfDayUtc: 1440, keepDaily: 1, keepWeekly: 1 })).toMatch(/minute of the day/);
    expect(parseSchedule({ frequency: "daily", minuteOfDayUtc: 0, keepDaily: 0, keepWeekly: 0 })).toMatch(/at least one/);
    expect(parseSchedule({ frequency: "daily", minuteOfDayUtc: 0, keepDaily: 61, keepWeekly: 0 })).toMatch(/daily backups/);
    expect(parseSchedule(null)).toMatch(/schedule/);
  });

  it("keeps the newest of each recent day and week, and always the newest", () => {
    // One backup a day for 40 days (newest first), plus a second one today.
    const t0 = Date.UTC(2026, 9, 14, 3);
    const backups = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, createdAt: t0 - i * DAY }));
    backups.push({ id: "today-later", createdAt: t0 + H });
    const keep = retained(backups, { keepDaily: 7, keepWeekly: 4 });
    expect(keep.has("today-later")).toBe(true);
    expect(keep.has("d0")).toBe(false);
    for (let i = 1; i <= 6; i++) expect(keep.has(`d${i}`)).toBe(true);
    expect(keep.has("d7")).toBe(false);
    // Weekly: the newest in each of the 4 most recent ISO weeks (today's week is already kept).
    const weekly = [...keep].filter((id) => !["today-later", "d1", "d2", "d3", "d4", "d5", "d6"].includes(id));
    expect(weekly.length).toBeGreaterThanOrEqual(2);
    expect(weekly.length).toBeLessThanOrEqual(3);
    expect(keep.size).toBeLessThanOrEqual(11);
    expect(retained([{ id: "only", createdAt: 1 }], { keepDaily: 0, keepWeekly: 0 })).toEqual(new Set(["only"]));
  });
});
