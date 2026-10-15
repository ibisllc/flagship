import { describe, expect, it } from "vitest";
import { formatReport, formatRules, parseArgs } from "./rate-limit-report.mjs";

const quiet = (endpoint: string) => ({
  endpoint,
  rules: [{ axis: "ip", limit: 30, windowSec: 60 }],
  refused: 0,
  sources: 0,
  near: 0,
  unreachable: 0,
  byAxis: {},
  daily: [],
});

const report = {
  days: 7,
  since: "2026-10-09",
  scale: 1,
  endpoints: [
    {
      endpoint: "username-claim",
      rules: [
        { axis: "ip", limit: 5, windowSec: 3600 },
        { axis: "irk", limit: 1, windowSec: 60 },
      ],
      refused: 9,
      sources: 4,
      near: 6,
      unreachable: 0,
      byAxis: {
        ip: { refused: 8, sources: 3, near: 2, unreachable: 0 },
        irk: { refused: 1, sources: 1, near: 4, unreachable: 0 },
      },
      daily: [{ day: "2026-10-15", refused: 9, sources: 4, near: 6, unreachable: 0 }],
    },
    { ...quiet("free-ai"), near: 12 },
    quiet("totp-verify"),
  ],
};

describe("rate-limit-report", () => {
  it("lists active budgets with their limits and says what deserves a look", () => {
    const out = formatReport(report);
    expect(out).toContain("Rate limits, last 7 days (since 2026-10-09 UTC)");
    expect(out).toMatch(/username-claim\s+9\s+4\s+6\s+0\s+5\/1h per IP, 1\/1min per account key/);
    expect(out).toMatch(/by IP\s+8\s+3\s+2/);
    expect(out).not.toContain("totp-verify");
    expect(out).toContain("1 other budgets were quiet");
    expect(out).toContain("username-claim: 4 different callers were refused");
    expect(out).toContain("free-ai: 12 passes came close but none was refused");
  });

  it("shows quiet budgets and days on request", () => {
    const out = formatReport(report, { all: true, daily: true });
    expect(out).toContain("totp-verify");
    expect(out).toMatch(/2026-10-15\s+9\s+4\s+6/);
  });

  it("says so when nothing happened, and notes the gym's scale", () => {
    expect(formatReport({ ...report, scale: 10, endpoints: [quiet("free-ai")] })).toBe(
      "Rate limits, last 7 days (since 2026-10-09 UTC) (limits ×10)\n\nNobody was refused or came close to a limit.",
    );
  });

  it("reads its options", () => {
    expect(parseArgs(["--days", "30", "--all"])).toMatchObject({ days: 30, all: true, daily: false });
    expect(() => parseArgs(["--days", "91"])).toThrow(/1 to 90/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(formatRules([{ axis: "usernameHash", limit: 3, windowSec: 900 }])).toBe("3/15min per username");
  });
});
