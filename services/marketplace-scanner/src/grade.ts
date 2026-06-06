/**
 * Grade computation — the A–F security-scan policy.
 *
 * Pure functions, no I/O, fully deterministic: the same inputs always
 * produce the same grade. The thresholds here are the single source of
 * truth; `POLICY.md` documents them publicly. If you change a constant
 * here, change POLICY.md in the same commit.
 *
 * WORST-FINDING-DOMINATES: the grade is the *floor* across every
 * dimension. A clean Trivy result cannot lift a manifest that ships a
 * no-ship custom-check failure out of F, and a single CRITICAL CVE
 * caps at F regardless of everything else.
 *
 * FAIL-CLOSED: a scan that could not actually run (clone/tool error,
 * timeout, clone-hash mismatch, sandbox failure) yields the explicit
 * failure grade `SCAN_ERROR_GRADE` (= "F") — NEVER a passing grade.
 * `gradeScanError()` is the only path scanners take when scanning was
 * not completed; it can never return better than F.
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

/**
 * `npm audit --json` rolled up to the same severity buckets as Trivy.
 * Folded into the Trivy tallies (worst-finding-dominates) so a
 * CRITICAL advisory in the dependency tree caps the grade at F just
 * like a CRITICAL OS-package CVE.
 */
export interface NpmAuditResult {
  CRITICAL: number;
  HIGH: number;
  MODERATE: number;
  LOW: number;
}

/**
 * `semgrep --config=p/owasp-top-ten --json` rolled up by severity.
 * Semgrep ERROR ⇒ no-ship-class (caps at F); WARNING ⇒ degrades one
 * notch like a custom-check warn.
 */
export interface SemgrepResult {
  ERROR: number;
  WARNING: number;
  INFO: number;
}

export interface CustomCheckResult {
  /** Stable identifier — e.g., "network-allowlist-wildcard" */
  id: string;
  /** "no-ship" = fail-stop (F); "warn" = degrades grade by one notch. */
  level: "no-ship" | "warn";
  message: string;
}

export type Grade = "A" | "B" | "C" | "D" | "F";

/**
 * The grade a scanner MUST report when the scan did not actually
 * complete (clone failed, a tool errored or timed out, the cloned
 * tree's hash did not match the pinned manifest_hash, the sandbox
 * failed). Fail-closed: this is "F", never anything passing.
 */
export const SCAN_ERROR_GRADE: Grade = "F";

/** Grades at/above this are considered "passing" for the search filter. */
export const PASSING_GRADE_FLOOR: Grade = "C";

const GRADE_ORDER: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };

/** True iff `g` is a passing grade (>= PASSING_GRADE_FLOOR). */
export function isPassingGrade(g: Grade): boolean {
  return GRADE_ORDER[g] >= GRADE_ORDER[PASSING_GRADE_FLOOR];
}

/** The worse (lower) of two grades. Used to enforce worst-dominates. */
export function worseGrade(a: Grade, b: Grade): Grade {
  return GRADE_ORDER[a] <= GRADE_ORDER[b] ? a : b;
}

export interface GradeBreakdown {
  grade: Grade;
  reasons: string[];
  trivy: TrivyResult;
  customChecks: CustomCheckResult[];
  /** Present when the grade came from a fail-closed scan error. */
  scanError?: string;
}

export function summarizeTrivy(vulns: TrivyVulnerability[]): TrivyResult {
  const result: TrivyResult = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const v of vulns) {
    result[v.Severity] = (result[v.Severity] ?? 0) + 1;
  }
  return result;
}

/**
 * Fold an `npm audit` + `semgrep` roll-up into the Trivy severity
 * tallies and a derived custom-check list, so the single
 * `computeGrade` policy applies uniformly across all three tools
 * (worst-finding-dominates). npm CRITICAL/HIGH map onto Trivy
 * CRITICAL/HIGH; npm MODERATE → Trivy MEDIUM; npm LOW → Trivy LOW.
 * semgrep ERROR becomes a no-ship custom check; semgrep WARNING
 * becomes a warn custom check.
 */
export function foldSourceFindings(
  trivy: TrivyResult,
  npmAudit: NpmAuditResult | undefined,
  semgrep: SemgrepResult | undefined,
  customChecks: CustomCheckResult[],
): { trivy: TrivyResult; customChecks: CustomCheckResult[] } {
  const merged: TrivyResult = {
    CRITICAL: trivy.CRITICAL + (npmAudit?.CRITICAL ?? 0),
    HIGH: trivy.HIGH + (npmAudit?.HIGH ?? 0),
    MEDIUM: trivy.MEDIUM + (npmAudit?.MODERATE ?? 0),
    LOW: trivy.LOW + (npmAudit?.LOW ?? 0),
  };
  const checks = [...customChecks];
  if (semgrep && semgrep.ERROR > 0) {
    checks.push({
      id: "semgrep-owasp-error",
      level: "no-ship",
      message: `semgrep p/owasp-top-ten reported ${semgrep.ERROR} ERROR finding(s)`,
    });
  }
  if (semgrep && semgrep.WARNING > 0) {
    checks.push({
      id: "semgrep-owasp-warning",
      level: "warn",
      message: `semgrep p/owasp-top-ten reported ${semgrep.WARNING} WARNING finding(s)`,
    });
  }
  return { trivy: merged, customChecks: checks };
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
 * FAIL-CLOSED grade for a scan that did not actually complete. There
 * is intentionally no input that lets this return a passing grade —
 * it is always `SCAN_ERROR_GRADE`. The reason is recorded so the
 * report explains why the listing is ungraded-as-F.
 */
export function gradeScanError(reason: string): GradeBreakdown {
  const empty: TrivyResult = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  return {
    grade: SCAN_ERROR_GRADE,
    reasons: [`scan did not complete: ${reason}`],
    trivy: empty,
    customChecks: [
      { id: "scan-incomplete", level: "no-ship", message: reason },
    ],
    scanError: reason,
  };
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
