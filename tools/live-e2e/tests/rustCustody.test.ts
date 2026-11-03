import { describe, expect, it } from "vitest";
import { describeStatus, failedRunsFromJournal, fellBack, gymStack, reportedAtMs, rustServedProblem, tsServedProblem, type ComponentStatus } from "../lib/rustCustody.js";

const SHA = "cd".repeat(32);
const st = (o: Partial<ComponentStatus> = {}): ComponentStatus => ({ component: "keyd", choice: "rust", reason: "running", sha256: SHA, pinned: SHA, switch: "on", at: 1, ...o });

describe("rust custody assertions", () => {
  it("accepts the pinned Rust binary, before and after its socket came up", () => {
    expect(rustServedProblem(st())).toBeNull();
    expect(rustServedProblem(st({ reason: "pinned" }))).toBeNull();
  });
  it("names every way the Rust claim fails", () => {
    expect(rustServedProblem(null)).toMatch(/no status/);
    expect(rustServedProblem(st({ choice: "ts", reason: "failed-to-start" }))).toMatch(/TypeScript fallback/);
    expect(rustServedProblem(st({ reason: "not-ready" }))).toMatch(/not-ready/);
    expect(rustServedProblem(st({ pinned: "ef".repeat(32) }))).toMatch(/not the pinned/);
    expect(rustServedProblem(st({ sha256: "", pinned: "" }))).toMatch(/not the pinned/);
    expect(rustServedProblem(st({ switch: "off" }))).toMatch(/switch is off/);
  });
  it("classic: TS because the switch is off, nothing else", () => {
    expect(tsServedProblem(st({ choice: "ts", reason: "switched-off", sha256: "" }))).toBeNull();
    expect(tsServedProblem(st())).toMatch(/Rust binary served/);
    expect(tsServedProblem(st({ choice: "ts", reason: "no-binary" }))).toMatch(/no-binary/);
  });
  it("tells a fallback from a crash and reads the selector's count", () => {
    expect(fellBack(st({ choice: "ts", reason: "failed-to-start" }))).toBe(true);
    expect(fellBack(st({ choice: "ts", reason: "switched-off" }))).toBe(false);
    const lines = [
      "Nov 02 x flagship-rust-select[1]: [rust-path] keyd: the Rust binary stopped (signal  KILL); failed runs: 1",
      "[rust-path] broker: the Rust binary stopped (signal); failed runs: 7",
      "[rust-path] keyd: the Rust binary stopped (signal); failed runs: 3",
      "[rust-path] keyd: ts (failed-to-start)",
    ];
    expect(failedRunsFromJournal(lines)).toBe(3);
    expect(failedRunsFromJournal(lines, "broker")).toBe(7);
    expect(failedRunsFromJournal([])).toBe(0);
  });
  it("small readers", () => {
    expect(gymStack("classic")).toBe("classic");
    expect(gymStack(undefined)).toBe("arch-v2");
    expect(describeStatus(st())).toBe(`rust (running, ${SHA.slice(0, 12)})`);
    expect(describeStatus(null)).toBe("unreported");
    expect(reportedAtMs(1_790_000_000)).toBe(1_790_000_000_000);
    expect(reportedAtMs(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(reportedAtMs("2026-11-02T00:00:00Z")).toBe(Date.parse("2026-11-02T00:00:00Z"));
    expect(reportedAtMs(null)).toBe(0);
  });
});
