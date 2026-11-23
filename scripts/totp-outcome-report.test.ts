import { describe, expect, it } from "vitest";
import { formatReport, parseArgs } from "./totp-outcome-report.mjs";

describe("totp-outcome-report", () => {
  it("parses its flags", () => {
    expect(parseArgs(["--days", "30", "--daily"])).toMatchObject({ days: 30, daily: true });
    expect(() => parseArgs(["--days", "91"])).toThrow();
  });

  it("prints each endpoint's outcomes, busiest first, and flags internal errors", () => {
    const text = formatReport({
      days: 7,
      since: "2026-11-17",
      totals: {
        "enroll-begin": { ok: 3, "totp-admin-only": 1, "internal-error": 2 },
        "enroll-confirm": { ok: 3 },
        disable: {},
      },
      daily: [],
    });
    expect(text).toContain("enroll-begin: 6 calls");
    expect(text.indexOf("ok")).toBeLessThan(text.indexOf("internal-error"));
    expect(text).toContain("disable: no calls");
    expect(text).toContain("2 internal error(s)");
  });
});
