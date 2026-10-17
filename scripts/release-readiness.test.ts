import { describe, expect, it } from "vitest";
import { delta, parseMergeTree, selectPhases } from "./release-readiness.mjs";

describe("release-readiness", () => {
  it("reads conflicted paths from merge-tree --name-only", () => {
    expect(parseMergeTree("abc123\na.ts\nb.ts\na.ts\n\n")).toEqual(["a.ts", "b.ts"]);
    expect(parseMergeTree("abc123\n")).toEqual([]);
  });

  it("selects phases with --only, --skip and --live", () => {
    expect(selectPhases([])).toEqual(["branches", "tsc", "vitest", "e2e", "gym", "parity"]);
    expect(selectPhases(["--live"])).toContain("live");
    expect(selectPhases([])).not.toContain("ios-release");
    expect(selectPhases(["--native"])).toContain("ios-release");
    expect(selectPhases(["--only", "parity,branches"])).toEqual(["parity", "branches"]);
    expect(selectPhases(["--skip", "e2e,gym"])).toEqual(["branches", "tsc", "vitest", "parity"]);
    expect(() => selectPhases(["--only", "nope"])).toThrow(/unknown phase/);
  });

  it("describes the change since the previous report", () => {
    expect(delta(undefined, { status: "red", metrics: {} })).toBe("new");
    expect(delta({ status: "red", metrics: { failed: 3, total: 10 } }, { status: "green", metrics: { failed: 0, total: 10 } })).toBe(
      "red→green, failed 3→0",
    );
    expect(delta({ status: "green", metrics: { a: 1 } }, { status: "green", metrics: { a: 1 } })).toBe("same");
  });
});
