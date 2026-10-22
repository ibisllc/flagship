/**
 * Pure scan-orchestration core. NO I/O of its own — every side
 * effect goes through an injected port (`ScanRunner`, `ReportStore`,
 * `ResultPoster`, `Clock`). This is the unit-tested deliverable; the
 * concrete adapters in `adapters.ts` are the live/operator edge.
 *
 * Flow per listing:
 *   1. runner.run(target)   — clone @ manifest_hash + tool chain (sandboxed)
 *   2. fold npm-audit/semgrep into the Trivy tallies + custom checks
 *   3. computeGrade()       — deterministic A–F policy (worst-dominates)
 *   4. assemble a deterministic JSON report
 *   5. reportStore.put()    — upload to R2 → reportKey
 *   6. sign + poster.post() — scanner-signed MarketplaceScanResult
 *
 * FAIL-CLOSED: if step 1 throws (clone/tool/timeout/hash-mismatch/
 * sandbox), we DO NOT skip and we DO NOT pass. We grade the listing
 * `SCAN_ERROR_GRADE` (= "F"), still upload an error report, and still
 * post the *signed* result so `.com` records the failure. There is no
 * code path that yields a passing grade without a completed scan, and
 * no unsigned/bypass post path.
 */

import {
  computeGrade,
  foldSourceFindings,
  gradeScanError,
  summarizeTrivy,
  type GradeBreakdown,
} from "./grade.js";
import { runCustomChecks } from "./grade.js";
import {
  ScanRunnerError,
  type Clock,
  type ReportStore,
  type ResultPoster,
  type ScanArtifacts,
  type ScanRunner,
  type ScanTarget,
} from "./ports.js";
import { signScanResult, type ScanResult } from "./scanResult.js";
import type { Keypair } from "@flagship/protocol";

export interface ScanReport {
  schema: "flagship.marketplace-scan-report/v1";
  creator: string;
  slug: string;
  canonicalUrl: string;
  manifestHashHex: string;
  treeDigestHex: string;
  grade: GradeBreakdown["grade"];
  reasons: string[];
  scanError: string | null;
  trivy: GradeBreakdown["trivy"];
  customChecks: GradeBreakdown["customChecks"];
  tools: {
    npmAudit: ScanArtifacts["npmAudit"] | null;
    semgrep: ScanArtifacts["semgrep"] | null;
    raw: ScanArtifacts["raw"] | null;
  };
  scannedAt: number;
}

export interface ScanCoreDeps {
  runner: ScanRunner;
  reportStore: ReportStore;
  poster: ResultPoster;
  scanner: Keypair;
  now?: Clock;
  /** When true, compute + assemble but do NOT upload or post. */
  dryRun?: boolean;
}

export interface ScanOutcome {
  result: ScanResult;
  report: ScanReport;
  /** The signed body that was (or, in dry-run, would be) posted. */
  signedBody: { request: ScanResult; signature: string };
  posted: boolean;
}

/**
 * Deterministic report key. Stable for a given (creator, slug, tree
 * digest) so re-scanning the same tree overwrites rather than
 * littering R2, and so the public report URL
 * `flagshipserver.com/marketplace/<creator>/<slug>/scan/<hash>.pdf`
 * (§L.7) maps 1:1 to the tree digest.
 */
export function reportKeyFor(
  creator: string,
  slug: string,
  treeDigestHex: string,
): string {
  return `${creator}/${slug}/${treeDigestHex}.json`;
}

/**
 * Build the grade + report for a target. Pure given its artifacts:
 * the same artifacts always produce the same report (modulo the
 * injected clock). On a `ScanRunnerError` it returns the fail-closed
 * grade — it can never produce a passing grade here.
 */
export function assess(
  target: ScanTarget,
  artifactsOrError: ScanArtifacts | ScanRunnerError,
  scannedAt: number,
): { breakdown: GradeBreakdown; report: ScanReport; treeDigestHex: string } {
  if (artifactsOrError instanceof ScanRunnerError) {
    const breakdown = gradeScanError(
      `${artifactsOrError.reason}: ${artifactsOrError.message}`,
    );
    const report: ScanReport = {
      schema: "flagship.marketplace-scan-report/v1",
      creator: target.creator,
      slug: target.slug,
      canonicalUrl: target.canonicalUrl,
      manifestHashHex: target.manifestHashHex,
      // No verified tree → pin the *intended* manifest hash so the
      // envelope still names what was supposed to be scanned. Never
      // an empty/forged digest.
      treeDigestHex: target.manifestHashHex,
      grade: breakdown.grade,
      reasons: breakdown.reasons,
      scanError: artifactsOrError.reason,
      trivy: breakdown.trivy,
      customChecks: breakdown.customChecks,
      tools: { npmAudit: null, semgrep: null, raw: null },
      scannedAt,
    };
    return { breakdown, report, treeDigestHex: target.manifestHashHex };
  }

  const a = artifactsOrError;
  // Defence in depth: even if a runner returned without throwing, a
  // tree-hash that does not match the pinned manifest hash is a
  // fail-closed condition — never grade a tree we cannot pin.
  if (a.treeDigestHex !== target.manifestHashHex) {
    const breakdown = gradeScanError(
      `clone-hash-mismatch: scanned ${a.treeDigestHex} but listing pinned ${target.manifestHashHex}`,
    );
    const report: ScanReport = {
      schema: "flagship.marketplace-scan-report/v1",
      creator: target.creator,
      slug: target.slug,
      canonicalUrl: target.canonicalUrl,
      manifestHashHex: target.manifestHashHex,
      treeDigestHex: target.manifestHashHex,
      grade: breakdown.grade,
      reasons: breakdown.reasons,
      scanError: "clone-hash-mismatch",
      trivy: breakdown.trivy,
      customChecks: breakdown.customChecks,
      tools: { npmAudit: null, semgrep: null, raw: null },
      scannedAt,
    };
    return { breakdown, report, treeDigestHex: target.manifestHashHex };
  }

  const baseChecks = runCustomChecks(a.manifest);
  const folded = foldSourceFindings(
    summarizeTrivy(a.trivy),
    a.npmAudit,
    a.semgrep,
    baseChecks,
  );
  const breakdown = computeGrade(folded.trivy, folded.customChecks);
  const report: ScanReport = {
    schema: "flagship.marketplace-scan-report/v1",
    creator: target.creator,
    slug: target.slug,
    canonicalUrl: target.canonicalUrl,
    manifestHashHex: target.manifestHashHex,
    treeDigestHex: a.treeDigestHex,
    grade: breakdown.grade,
    reasons: breakdown.reasons,
    scanError: null,
    trivy: breakdown.trivy,
    customChecks: breakdown.customChecks,
    tools: { npmAudit: a.npmAudit, semgrep: a.semgrep, raw: a.raw },
    scannedAt,
  };
  return { breakdown, report, treeDigestHex: a.treeDigestHex };
}

/** Deterministic, stable JSON serialization of a report. */
export function serializeReport(report: ScanReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Scan one target end-to-end. Always produces a signed result and
 * (unless dryRun) posts it. Fail-closed: a runner error becomes an
 * F-grade signed post, never a skip and never a pass.
 */
export async function scanTarget(
  deps: ScanCoreDeps,
  target: ScanTarget,
): Promise<ScanOutcome> {
  const now = (deps.now ?? (() => Date.now()))();

  let artifactsOrError: ScanArtifacts | ScanRunnerError;
  try {
    artifactsOrError = await deps.runner.run(target);
  } catch (err) {
    artifactsOrError =
      err instanceof ScanRunnerError
        ? err
        : new ScanRunnerError(
            err instanceof Error ? err.message : String(err),
            "runner-threw",
          );
  }

  const { breakdown, report, treeDigestHex } = assess(
    target,
    artifactsOrError,
    now,
  );
  const json = serializeReport(report);
  const key = reportKeyFor(target.creator, target.slug, treeDigestHex);

  const result: ScanResult = {
    creator: target.creator,
    slug: target.slug,
    grade: breakdown.grade,
    reportKey: key,
    imageDigestHex: treeDigestHex,
    scannedAt: now,
  };

  // Sign FIRST (pure) so even dry-run callers can inspect/round-trip
  // the exact bytes `.com` will verify.
  const signedBody = signScanResult(result, deps.scanner);

  if (deps.dryRun) {
    return { result, report, signedBody, posted: false };
  }

  // Upload the report; if R2 fails we still post the signed result
  // (with the computed reportKey) so `.com` records the grade — the
  // report URL just 404s until the next scan re-uploads. We never
  // upgrade the grade to compensate.
  try {
    await deps.reportStore.put(key, json);
  } catch {
    /* non-fatal: grade still posts; report re-uploads next cycle */
  }

  await deps.poster.post(target.creator, target.slug, signedBody);
  return { result, report, signedBody, posted: true };
}
