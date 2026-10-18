import { describe, expect, it } from "vitest";
import { formatHealth, parseArgs } from "./dns-zone-health.mjs";

const base = {
  apex: "flagship.services",
  generatedAt: "2026-10-18T12:00:00.000Z",
  records: 7,
  cap: 200,
  atRest: 3,
  challenges: 1,
  relay: { servicesIpv4: "1.2.3.4" },
  rootWildcard: { ready: true, a: "ok", aaaa: "ok", proxied: false, problems: [] },
  problems: [],
  warnings: [],
  ok: true,
};

describe("parseArgs", () => {
  it("takes --json and nothing unknown", () => {
    expect(parseArgs([]).json).toBe(false);
    expect(parseArgs(["--json"]).json).toBe(true);
    expect(() => parseArgs(["--apply"])).toThrow(/unknown/);
  });
});

describe("formatHealth", () => {
  it("says OK for a healthy zone", () => {
    const t = formatHealth(base);
    expect(t).toContain("records: 7 of 200; at rest 3; challenges in flight 1");
    expect(t).toContain("OK: the zone is in the root-wildcard layout.");
  });

  it("lists each problem with its record id, and the warnings", () => {
    const t = formatHealth({
      ...base,
      ok: false,
      rootWildcard: { ...base.rootWildcard, a: "missing", proxied: true },
      problems: [
        { code: "wildcard", message: "*.flagship.services A is missing" },
        { code: "account-record", message: "CAA alice.flagship.services blocks the root wildcard", id: "abc" },
      ],
      warnings: ["2 challenge TXT older than an hour"],
    });
    expect(t).toContain("NOT OK: 2 problems");
    expect(t).toContain("- CAA alice.flagship.services blocks the root wildcard  [abc]");
    expect(t).toContain("A missing");
    expect(t).toContain("PROXIED");
    expect(t).toContain("Warnings:");
  });
});
