// Pins the shared S2 date helper (webapp). The month/clock branches
// are locale-formatted, so we assert structure (contains the expected
// month token / a clock) rather than an exact locale string.

import { describe, expect, it } from "vitest";
import {
  formatWhen,
  formatDateTime,
  formatDuration,
  formatDays,
} from "../public/webapp/lib/dateFormat.js";

// A fixed "now" in the middle of a year so both same-year and cross-year
// branches are reachable deterministically.
const NOW = new Date("2026-07-04T12:00:00Z").getTime();

describe("formatWhen", () => {
  it("returns — for a non-instant", () => {
    expect(formatWhen(0, NOW)).toBe("—");
    expect(formatWhen(NaN, NOW)).toBe("—");
    expect(formatWhen("x" as unknown as number, NOW)).toBe("—");
  });

  it("collapses < 60s to 'just now' (past or future)", () => {
    expect(formatWhen(NOW - 5_000, NOW)).toBe("just now");
    expect(formatWhen(NOW + 5_000, NOW)).toBe("just now");
  });

  it("uses minutes / hours in the recent past", () => {
    expect(formatWhen(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatWhen(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });

  it("uses 'in {n}' for the near future", () => {
    expect(formatWhen(NOW + 5 * 60_000, NOW)).toBe("in 5m");
    expect(formatWhen(NOW + 3 * 3_600_000, NOW)).toBe("in 3h");
  });

  it("falls back to a calendar date beyond 24h", () => {
    const sameYear = formatWhen(NOW - 10 * 86_400_000, NOW);
    expect(sameYear).toMatch(/\d/);
    expect(sameYear).not.toContain("ago");
    // A cross-year instant carries the year.
    const older = formatWhen(new Date("2023-01-15T00:00:00Z").getTime(), NOW);
    expect(older).toContain("2023");
  });
});

describe("formatDateTime", () => {
  it("carries a clock alongside the date", () => {
    const s = formatDateTime(NOW - 10 * 86_400_000, NOW);
    // "MMM d, h:mm a" — has a comma and a colon in the time.
    expect(s).toContain(",");
    expect(s).toMatch(/\d:\d\d/);
  });
});

describe("formatDuration", () => {
  it("renders a bare span", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(2 * 3_600_000)).toBe("2h");
    expect(formatDuration(3 * 86_400_000)).toBe("3d");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("formatDays", () => {
  it("floors at 1 day", () => {
    expect(formatDays(0)).toBe("1d");
    expect(formatDays(5 * 86_400_000)).toBe("5d");
  });
});
