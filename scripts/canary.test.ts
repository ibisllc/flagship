import { describe, expect, it } from "vitest";
import { buildRows, formatRows, parseArgs, type ReleaseCounts } from "./canary.js";

const A = "0123456789abcdef0123456789abcdef01234567";
const B = "fedcba9876543210fedcba9876543210fedcba98";
const H = 3_600_000;
const counts = (release: string, passed: number, rolledBack = 0, stuck = 0): ReleaseCounts => ({
  release,
  totals: { passed, rolledBack, stuck },
  byCohort: { "5": { passed, rolledBack, stuck } },
  byProfile: { "amd64/classic": { passed, rolledBack, stuck } },
  daily: [{ day: "2026-10-24", passed, rolledBack, stuck }],
  firstDay: "2026-10-24",
  lastDay: "2026-10-24",
});
const catalog = [
  { commit: A, label: "0.3", securityVersion: 3, rolloutPercent: 5 },
  { commit: B, label: "0.2", securityVersion: 2, rolloutPercent: 100 },
];

describe("npm run canary", () => {
  it("parses its flags and refuses junk", () => {
    expect(parseArgs([])).toMatchObject({ days: 30, json: false });
    expect(parseArgs(["--release", A.toUpperCase(), "--opened-at", "2026-10-22T00:00:00Z"]).release).toBe(A);
    expect(() => parseArgs(["--release", "main"])).toThrow();
    expect(() => parseArgs(["--days", "0"])).toThrow();
    expect(() => parseArgs(["--opened-at", "yesterday"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
  });

  it("gives the verdict for the release asked about, from its stage's opening time", () => {
    const o = parseArgs(["--release", A, "--opened-at", new Date(0).toISOString()]);
    const rows = buildRows([counts(A, 4)], catalog, o, 49 * H);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toMatchObject({ action: "widen", next: 20 });
    const text = formatRows(rows, 30, true);
    expect(text).toContain("rollout 5%");
    expect(text).toContain("cohort 5%");
    expect(text).toContain("verdict: widen to 20%");
  });

  it("prints the exact stop command when it says stop", () => {
    const rows = buildRows([counts(A, 4, 2)], catalog, parseArgs(["--release", A]), 0);
    expect(rows[0]!.verdict.action).toBe("stop");
    expect(formatRows(rows, 30, true)).toContain(`catalog.ts rollout --root release/catalog-root.json --list release/catalog-releases.json --commit ${A} --percent 0`);
  });

  it("waits without an opening time, and lists catalog releases with no receipts yet", () => {
    const rows = buildRows([], catalog, parseArgs([]), 0);
    expect(rows.map((r) => r.release).sort()).toEqual([A, B].sort());
    expect(rows.find((r) => r.release === A)!.verdict.action).toBe("wait");
    expect(rows.find((r) => r.release === B)!.verdict.action).toBe("complete");
  });

  it("says when a release with receipts is not in the catalog", () => {
    const rows = buildRows([counts("1".repeat(40), 1)], catalog, parseArgs(["--release", "1".repeat(40)]), 0);
    expect(rows[0]!.verdict.reason).toContain("not in the published catalog");
  });
});
