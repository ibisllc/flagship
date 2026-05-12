import { describe, expect, it } from "vitest";
import { parseDurationMs, isoFromMsSince } from "../src/lib/duration.js";
import { CliError } from "../src/lib/args.js";

describe("parseDurationMs", () => {
  it("parses days, hours, minutes, seconds, weeks, years", () => {
    expect(parseDurationMs("60d")).toBe(60 * 86400000);
    expect(parseDurationMs("12h")).toBe(12 * 3600000);
    expect(parseDurationMs("90m")).toBe(90 * 60000);
    expect(parseDurationMs("30s")).toBe(30000);
    expect(parseDurationMs("2w")).toBe(14 * 86400000);
    expect(parseDurationMs("1y")).toBe(365 * 86400000);
  });

  it("rejects malformed input", () => {
    expect(() => parseDurationMs("60")).toThrow(CliError);
    expect(() => parseDurationMs("d")).toThrow(CliError);
    expect(() => parseDurationMs("0d")).toThrow(CliError);
    expect(() => parseDurationMs("-5d")).toThrow(CliError);
  });

  it("isoFromMsSince produces a valid RFC3339 string", () => {
    const iso = isoFromMsSince(Date.parse("2026-01-01T00:00:00Z"), 86400000);
    expect(iso).toBe("2026-01-02T00:00:00.000Z");
  });
});
