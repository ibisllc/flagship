import { describe, expect, it } from "vitest";
import {
  FakeTrivyRunner,
  findingsToVulnerabilities,
  parseTrivyJson,
  tallyFindings,
  type Finding,
} from "../src/trivy.js";
import { computeGrade, summarizeTrivy } from "../src/grade.js";

const FINDINGS: Finding[] = [
  { severity: "CRITICAL", id: "CVE-2023-0001", pkgName: "openssl", fixedVersion: "3.0.8" },
  { severity: "HIGH", id: "CVE-2023-0002", pkgName: "zlib" },
  { severity: "HIGH", id: "CVE-2023-0003" },
  { severity: "MEDIUM", id: "CVE-2023-0004" },
  { severity: "LOW", id: "CVE-2023-0005" },
];

describe("tallyFindings — Finding[] → severity buckets", () => {
  it("counts by severity", () => {
    expect(tallyFindings(FINDINGS)).toEqual({ CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 0 + 1 });
  });

  it("returns all-zero for no findings", () => {
    expect(tallyFindings([])).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });
  });

  it("agrees with summarizeTrivy after findingsToVulnerabilities (one folding path)", () => {
    const viaTally = tallyFindings(FINDINGS);
    const viaVulns = summarizeTrivy(findingsToVulnerabilities(FINDINGS));
    expect(viaVulns).toEqual(viaTally);
  });
});

describe("parseTrivyJson — tolerant of Trivy's real shape", () => {
  it("extracts findings across multiple Results with mixed severities", () => {
    const raw = {
      Results: [
        {
          Vulnerabilities: [
            { Severity: "CRITICAL", VulnerabilityID: "CVE-1", PkgName: "a", FixedVersion: "1.2", Title: "bad" },
            { Severity: "HIGH", VulnerabilityID: "CVE-2", PkgName: "b" },
          ],
        },
        { Vulnerabilities: [{ Severity: "MEDIUM", VulnerabilityID: "CVE-3" }] },
      ],
    };
    expect(parseTrivyJson(raw)).toEqual([
      { severity: "CRITICAL", id: "CVE-1", pkgName: "a", fixedVersion: "1.2", title: "bad" },
      { severity: "HIGH", id: "CVE-2", pkgName: "b" },
      { severity: "MEDIUM", id: "CVE-3" },
    ]);
  });

  it("drops UNKNOWN/unspecified severities (reported but not graded)", () => {
    const raw = {
      Results: [{ Vulnerabilities: [{ Severity: "UNKNOWN", VulnerabilityID: "CVE-x" }, { VulnerabilityID: "CVE-y" }] }],
    };
    expect(parseTrivyJson(raw)).toEqual([]);
  });

  it("tolerates null/missing Results and null Vulnerabilities", () => {
    expect(parseTrivyJson({})).toEqual([]);
    expect(parseTrivyJson({ Results: null })).toEqual([]);
    expect(parseTrivyJson({ Results: [{ Vulnerabilities: null }] })).toEqual([]);
    expect(parseTrivyJson({ Results: [{}] })).toEqual([]);
  });

  it("normalizes lowercase severity casing", () => {
    const raw = { Results: [{ Vulnerabilities: [{ Severity: "high", VulnerabilityID: "CVE-9" }] }] };
    expect(parseTrivyJson(raw)).toEqual([{ severity: "HIGH", id: "CVE-9" }]);
  });

  it("a critical finding parsed from Trivy JSON drives an F grade end to end", () => {
    const findings = parseTrivyJson({
      Results: [{ Vulnerabilities: [{ Severity: "CRITICAL", VulnerabilityID: "CVE-boom" }] }],
    });
    const trivy = summarizeTrivy(findingsToVulnerabilities(findings));
    expect(computeGrade(trivy, []).grade).toBe("F");
  });
});

describe("FakeTrivyRunner — the injected test double (no Docker/Trivy)", () => {
  it("returns the canned findings + records the imageRef it was asked to scan", async () => {
    const fake = new FakeTrivyRunner(FINDINGS);
    const out = await fake.scan("docker://acme/app:1.0");
    expect(out).toEqual(FINDINGS);
    expect(fake.scanned).toEqual(["docker://acme/app:1.0"]);
  });

  it("can throw to exercise the fail-closed path", async () => {
    const fake = new FakeTrivyRunner(new Error("trivy missing"));
    await expect(fake.scan("docker://x")).rejects.toThrow("trivy missing");
  });

  it("supports a per-imageRef function for table-driven tests", async () => {
    const fake = new FakeTrivyRunner((ref) =>
      ref.includes("vuln") ? [{ severity: "CRITICAL", id: "CVE-1" }] : [],
    );
    expect(await fake.scan("docker://clean")).toEqual([]);
    expect((await fake.scan("docker://vuln")).length).toBe(1);
    expect(fake.scanned).toEqual(["docker://clean", "docker://vuln"]);
  });
});
