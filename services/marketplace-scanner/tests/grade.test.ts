import { describe, expect, it } from "vitest";
import {
  computeGrade,
  runCustomChecks,
  summarizeTrivy,
  type CustomCheckResult,
  type TrivyResult,
} from "../src/grade.js";

describe("summarizeTrivy (#56)", () => {
  it("counts vulnerabilities by severity", () => {
    const vulns = [
      { Severity: "CRITICAL" as const, VulnerabilityID: "CVE-1" },
      { Severity: "HIGH" as const, VulnerabilityID: "CVE-2" },
      { Severity: "HIGH" as const, VulnerabilityID: "CVE-3" },
      { Severity: "MEDIUM" as const, VulnerabilityID: "CVE-4" },
    ];
    const result = summarizeTrivy(vulns);
    expect(result).toEqual({ CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 0 });
  });

  it("returns all-zero for empty input", () => {
    expect(summarizeTrivy([])).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });
  });
});

const NO_VULNS: TrivyResult = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
const NO_CHECKS: CustomCheckResult[] = [];

describe("computeGrade (#56)", () => {
  it("A on clean Trivy + clean custom checks", () => {
    expect(computeGrade(NO_VULNS, NO_CHECKS).grade).toBe("A");
  });

  it("F on any CRITICAL CVE", () => {
    const r = computeGrade({ CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 }, NO_CHECKS);
    expect(r.grade).toBe("F");
    expect(r.reasons[0]).toMatch(/CRITICAL/);
  });

  it("F on any no-ship custom check", () => {
    const r = computeGrade(NO_VULNS, [
      { id: "network-allowlist-wildcard", level: "no-ship", message: "x" },
    ]);
    expect(r.grade).toBe("F");
  });

  it("B for 1-2 HIGH CVEs with clean checks", () => {
    expect(computeGrade({ ...NO_VULNS, HIGH: 1 }, NO_CHECKS).grade).toBe("B");
    expect(computeGrade({ ...NO_VULNS, HIGH: 2 }, NO_CHECKS).grade).toBe("B");
  });

  it("C for 3-5 HIGH CVEs with clean checks", () => {
    expect(computeGrade({ ...NO_VULNS, HIGH: 3 }, NO_CHECKS).grade).toBe("C");
    expect(computeGrade({ ...NO_VULNS, HIGH: 5 }, NO_CHECKS).grade).toBe("C");
  });

  it("D for 6+ HIGH with warnings", () => {
    const r = computeGrade(
      { ...NO_VULNS, HIGH: 7 },
      [
        { id: "w1", level: "warn", message: "x" },
        { id: "w2", level: "warn", message: "y" },
      ],
    );
    expect(r.grade).toBe("D");
  });

  it("warn-only with clean Trivy degrades to C", () => {
    expect(computeGrade(NO_VULNS, [{ id: "w1", level: "warn", message: "x" }]).grade).toBe("C");
  });
});

describe("runCustomChecks (#56)", () => {
  it("flags wildcard host as no-ship", () => {
    const result = runCustomChecks({
      canonical: "test@abc123",
      data: { network: { allowedHosts: ["*"] } },
    });
    expect(result.some((r) => r.id === "network-allowlist-wildcard")).toBe(true);
  });

  it("flags requiresPrivileged as no-ship", () => {
    const result = runCustomChecks({
      canonical: "test@abc123",
      runtime: { requiresPrivileged: true },
    });
    expect(result.some((r) => r.id === "runtime-requires-privileged" && r.level === "no-ship")).toBe(true);
  });

  it("flags suspicious envInject keys as warn", () => {
    const result = runCustomChecks({
      canonical: "test@abc123",
      runtime: { envInject: { AWS_SECRET_KEY: "..." } },
    });
    expect(result.some((r) => r.id === "envinject-suspicious-key" && r.level === "warn")).toBe(true);
  });

  it("requires canonical app name", () => {
    const result = runCustomChecks({ data: {}, runtime: {} });
    expect(result.some((r) => r.id === "manifest-no-canonical" && r.level === "no-ship")).toBe(true);
  });

  it("passes a well-formed manifest", () => {
    const result = runCustomChecks({
      canonical: "notes@abc123",
      data: { network: { allowedHosts: ["api.openai.com", "api.anthropic.com"] } },
      runtime: {},
    });
    expect(result).toEqual([]);
  });
});
