/**
 * Injected ports — every real-world side effect (git clone, npm
 * audit, trivy fs, semgrep, R2 upload, the signed HTTP postback) sits
 * behind one of these interfaces so the pure scan core
 * (`scanner.ts`) is unit-testable with deterministic fakes and the
 * vitest gate NEVER execs git/npm/trivy/semgrep/docker or touches the
 * network. The concrete implementations live in `adapters.ts` and are
 * exercised only at the live/operator edge.
 */

import type {
  NpmAuditResult,
  SemgrepResult,
  TrivyVulnerability,
} from "./grade.js";

/** What the scanner is asked to scan. */
export interface ScanTarget {
  creator: string;
  slug: string;
  /** Git/source URL of the canonical pod's repo (the listing's canonical_url). */
  canonicalUrl: string;
  /**
   * The pinned manifest hash from the listing. The runner MUST check
   * out the repo at exactly this revision/tree and verify the
   * resulting tree hash matches; a mismatch is fail-closed.
   */
  manifestHashHex: string;
  /**
   * The listing's public `flagship.app.json` manifest, verbatim (the
   * `manifestJson` the scan-queue carries). Optional: when present the
   * drain resolves `runtime.image` from it to decide the container-scan
   * target and to SKIP a listing with no resolvable image (see
   * `resolveImageRefFromJson`). Absent ⇒ the runner falls back to the
   * clone's on-disk `flagship.app.json`.
   */
  manifestJson?: string;
}

/**
 * One completed scan of a checked-out source tree. A runner returns
 * this ONLY when the clone-at-hash succeeded and every tool ran to
 * completion. Any failure path MUST throw `ScanRunnerError` (never
 * return a partial/clean result) so the core fails closed.
 */
export interface ScanArtifacts {
  /**
   * sha256 (hex, no `sha256:` prefix) of the checked-out source tree
   * at the pinned manifest hash. Goes into the envelope's
   * `imageDigestHex` — it pins WHICH artifact got the grade. The
   * runner MUST have verified this equals the listing's
   * `manifestHashHex` before returning (else throw).
   */
  treeDigestHex: string;
  /** Parsed flagship.app.json from the checked-out tree (or undefined). */
  manifest: unknown;
  /** `trivy fs` findings, severity-tagged. */
  trivy: TrivyVulnerability[];
  /** `npm audit --json` rolled up by severity. */
  npmAudit: NpmAuditResult;
  /** `semgrep --config=p/owasp-top-ten --json` rolled up by severity. */
  semgrep: SemgrepResult;
  /** Free-form raw tool output kept verbatim in the report for audit. */
  raw: {
    trivy?: unknown;
    npmAudit?: unknown;
    semgrep?: unknown;
  };
}

/**
 * Thrown by a `ScanRunner` when scanning could not complete: clone
 * failed, a tool errored/timed out, the cloned tree hash did not
 * match `manifestHashHex`, the sandbox broke. The core turns this
 * into the fail-closed `SCAN_ERROR_GRADE` — it is NEVER a silent
 * pass.
 */
export class ScanRunnerError extends Error {
  constructor(
    message: string,
    /** Stable reason slug for the report (e.g. "clone-hash-mismatch"). */
    public readonly reason: string,
  ) {
    super(message);
    this.name = "ScanRunnerError";
  }
}

/**
 * Clones the repo at the pinned hash inside a sandbox and runs the
 * §L.2 tool chain. The ONLY contract: resolve with `ScanArtifacts`
 * iff everything completed and the tree hash matched; otherwise
 * reject with `ScanRunnerError`. It must NOT swallow errors into a
 * clean result.
 */
export interface ScanRunner {
  run(target: ScanTarget): Promise<ScanArtifacts>;
}

/** Uploads the JSON report to R2 and returns the object key. */
export interface ReportStore {
  /** Returns the stored object key (the envelope's `reportKey`). */
  put(key: string, json: string): Promise<string>;
}

/** Posts the signed `{request, signature}` body to `.com`. */
export interface ResultPoster {
  post(creator: string, slug: string, body: unknown): Promise<void>;
}

/** Source of listings that need a scan (the landed scan-queue endpoint). */
export interface QueueSource {
  list(): Promise<ScanTarget[]>;
}

/** Injectable clock for deterministic `scannedAt` in tests. */
export type Clock = () => number;
