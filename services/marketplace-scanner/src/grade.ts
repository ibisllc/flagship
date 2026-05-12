/**
 * Grade computation from a Trivy JSON output + custom-check results.
 *
 * Pure function — no I/O — so it's directly unit-testable. The
 * scanner CLI calls this after running Trivy and the manifest checks.
 */

export interface TrivyVulnerability {
  Severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  VulnerabilityID: string;
  PkgName?: string;
}

export interface TrivyResult {
  /** Number of vulnerabilities at each severity. */
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
}

export interface CustomCheckResult {
  /** Stable identifier — e.g., "network-allowlist-wildcard" */
  id: string;
  /** "no-ship" = fail-stop; "warn" = degrades grade by one notch. */
  level: "no-ship" | "warn";
  message: string;
}

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface GradeBreakdown {
  grade: Grade;
  reasons: string[];
  trivy: TrivyResult;
  customChecks: CustomCheckResult[];
}

export function summarizeTrivy(vulns: TrivyVulnerability[]): TrivyResult {
  const result: TrivyResult = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const v of vulns) {
    result[v.Severity] = (result[v.Severity] ?? 0) + 1;
  }
  return result;
}

export function computeGrade(
  trivy: TrivyResult,
  customChecks: CustomCheckResult[],
): GradeBreakdown {
  const reasons: string[] = [];

  // Hard stops: anything that prevents shipping at all.
  const noShipChecks = customChecks.filter((c) => c.level === "no-ship");
  if (noShipChecks.length > 0) {
    for (const c of noShipChecks) reasons.push(`no-ship: ${c.message}`);
    return { grade: "F", reasons, trivy, customChecks };
  }
  if (trivy.CRITICAL > 0) {
    reasons.push(`${trivy.CRITICAL} CRITICAL CVE(s)`);
    return { grade: "F", reasons, trivy, customChecks };
  }

  // Tier on HIGH CVE count + warn count.
  const warnCount = customChecks.filter((c) => c.level === "warn").length;
  for (const c of customChecks) {
    if (c.level === "warn") reasons.push(`warn: ${c.message}`);
  }

  if (trivy.HIGH === 0 && warnCount === 0) {
    reasons.unshift("0 CRITICAL/HIGH CVEs, all custom checks pass");
    return { grade: "A", reasons, trivy, customChecks };
  }
  if (trivy.HIGH <= 2 && warnCount === 0) {
    reasons.unshift(`${trivy.HIGH} HIGH CVE(s), custom checks pass`);
    return { grade: "B", reasons, trivy, customChecks };
  }
  if (trivy.HIGH <= 5 || warnCount <= 1) {
    reasons.unshift(`${trivy.HIGH} HIGH CVE(s)`);
    return { grade: "C", reasons, trivy, customChecks };
  }
  reasons.unshift(`${trivy.HIGH} HIGH CVE(s) plus ${warnCount} warning(s)`);
  return { grade: "D", reasons, trivy, customChecks };
}

/**
 * Run the custom checks against a parsed flagship.app.json manifest.
 * Returns the set of failures + warnings; an empty array means
 * everything passed.
 */
export function runCustomChecks(manifest: unknown): CustomCheckResult[] {
  const results: CustomCheckResult[] = [];
  if (typeof manifest !== "object" || manifest === null) {
    return [
      {
        id: "manifest-missing",
        level: "no-ship",
        message: "flagship.app.json is missing or not a JSON object",
      },
    ];
  }
  const m = manifest as Record<string, unknown>;
  const data = (m.data ?? {}) as Record<string, unknown>;
  const network = (data.network ?? {}) as Record<string, unknown>;
  const runtime = (m.runtime ?? {}) as Record<string, unknown>;

  // Check 1: no `*` in allowedHosts.
  const allowedHosts = network.allowedHosts;
  if (Array.isArray(allowedHosts)) {
    if (allowedHosts.includes("*") || allowedHosts.includes("**")) {
      results.push({
        id: "network-allowlist-wildcard",
        level: "no-ship",
        message: "network.allowedHosts includes '*' — apps must specify exact hosts",
      });
    }
  }

  // Check 2: no requiresPrivileged.
  if (runtime.requiresPrivileged === true) {
    results.push({
      id: "runtime-requires-privileged",
      level: "no-ship",
      message: "runtime.requiresPrivileged is true — privileged containers forbidden",
    });
  }

  // Check 3: suspicious env injection.
  const envInject = runtime.envInject;
  if (typeof envInject === "object" && envInject !== null) {
    for (const k of Object.keys(envInject)) {
      if (/(password|secret|key|token)/i.test(k)) {
        results.push({
          id: "envinject-suspicious-key",
          level: "warn",
          message: `runtime.envInject.${k} matches suspicious-secret pattern`,
        });
      }
    }
  }

  // Check 4: manifest missing required identity fields.
  if (typeof m.canonical !== "string" || !m.canonical) {
    results.push({
      id: "manifest-no-canonical",
      level: "no-ship",
      message: "manifest is missing the canonical app name (appname@authorStableId)",
    });
  }

  return results;
}
