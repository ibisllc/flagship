/**
 * The Trivy container-vulnerability seam.
 *
 * Task §13 calls for the container scan to be an INJECTED dependency so
 * the grade/report/pipeline logic is unit-testable WITHOUT Trivy or
 * Docker (neither of which can run in CI or this environment). The
 * contract is deliberately tiny:
 *
 *     TrivyRunner { scan(imageRef): Promise<Finding[]> }
 *
 * The pure core consumes `Finding[]` (a flat, tool-agnostic list) and
 * folds it into the same severity tallies the rest of the policy uses
 * (worst-finding-dominates). Two implementations live downstream:
 *
 *   - `ExecTrivyRunner` (adapters.ts) — the REAL impl that shells out
 *     via `execFile('trivy', ['image', …])`. NEVER executed by the
 *     vitest gate.
 *   - `FakeTrivyRunner` (this file) — a deterministic fake that returns
 *     canned findings, used by every unit test of the pipeline.
 *
 * Keeping the image scan behind its own port (separate from the
 * source-tree `ScanRunner`) means a caller can scan a built image ref
 * in isolation, and the grade logic can be exercised with fake findings
 * regardless of whether Trivy/Docker exist.
 */

import type { TrivyResult, TrivyVulnerability } from "./grade.js";

/** Severity buckets Trivy reports, in worst-first order. */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/**
 * One vulnerability finding, normalized across Trivy's
 * `image`/`fs`/`config` scanners. Flat + tool-agnostic so fakes are
 * trivial to construct and the report stays human-readable.
 */
export interface Finding {
  severity: Severity;
  /** e.g. "CVE-2023-1234" or a Trivy rule id. */
  id: string;
  /** Affected package / target, if Trivy reported one. */
  pkgName?: string;
  /** Version that fixes it, if Trivy reported one. */
  fixedVersion?: string;
  /** Short human title for the report. */
  title?: string;
}

/**
 * The injected container-scan dependency. The real impl shells out to
 * the `trivy` binary; the fake returns canned findings. Implementations
 * MUST reject (throw) when the scan could not complete — the pipeline
 * turns that into the fail-closed F grade, never a silent pass.
 */
export interface TrivyRunner {
  scan(imageRef: string): Promise<Finding[]>;
}

/** Roll a flat `Finding[]` up into the severity tallies the policy uses. */
export function tallyFindings(findings: Finding[]): TrivyResult {
  const result: TrivyResult = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) {
    result[f.severity] = (result[f.severity] ?? 0) + 1;
  }
  return result;
}

/**
 * Adapt the flat `Finding[]` to the `TrivyVulnerability[]` shape the
 * existing grade pipeline already consumes (`summarizeTrivy`), so image
 * findings fold through one code path with the source-tree findings.
 */
export function findingsToVulnerabilities(
  findings: Finding[],
): TrivyVulnerability[] {
  return findings.map((f) => ({
    Severity: f.severity,
    VulnerabilityID: f.id,
    ...(f.pkgName ? { PkgName: f.pkgName } : {}),
  }));
}

/**
 * Parse `trivy image --format json` / `trivy fs --format json` output
 * into the flat `Finding[]` shape. Tolerant of missing fields (Trivy
 * omits `FixedVersion` for unfixed CVEs and may emit empty/null
 * `Results`). Exported so the real adapter and tests share one parser.
 */
export function parseTrivyJson(raw: unknown): Finding[] {
  const parsed = raw as {
    Results?: Array<{
      Vulnerabilities?: Array<{
        Severity?: string;
        VulnerabilityID?: string;
        PkgName?: string;
        FixedVersion?: string;
        Title?: string;
      }> | null;
    }> | null;
  };
  const findings: Finding[] = [];
  for (const r of parsed?.Results ?? []) {
    for (const v of r?.Vulnerabilities ?? []) {
      const sev = (v?.Severity ?? "").toUpperCase();
      if (sev !== "CRITICAL" && sev !== "HIGH" && sev !== "MEDIUM" && sev !== "LOW") {
        continue; // UNKNOWN / unspecified — reported by Trivy but not graded.
      }
      findings.push({
        severity: sev,
        id: v?.VulnerabilityID ?? "UNKNOWN",
        ...(v?.PkgName ? { pkgName: v.PkgName } : {}),
        ...(v?.FixedVersion ? { fixedVersion: v.FixedVersion } : {}),
        ...(v?.Title ? { title: v.Title } : {}),
      });
    }
  }
  return findings;
}

/**
 * Deterministic fake `TrivyRunner` for unit tests — returns the
 * findings it was constructed with (or computes them from the imageRef,
 * or throws to exercise the fail-closed path). NEVER touches
 * Docker/Trivy, so the whole pipeline is unit-testable in CI.
 */
export class FakeTrivyRunner implements TrivyRunner {
  private readonly calls: string[] = [];

  constructor(
    private readonly behaviour:
      | Finding[]
      | Error
      | ((imageRef: string) => Finding[] | Promise<Finding[]>),
  ) {}

  /** The image refs this fake was asked to scan, in order. */
  get scanned(): readonly string[] {
    return this.calls;
  }

  async scan(imageRef: string): Promise<Finding[]> {
    this.calls.push(imageRef);
    if (this.behaviour instanceof Error) throw this.behaviour;
    if (typeof this.behaviour === "function") return this.behaviour(imageRef);
    return this.behaviour;
  }
}
