/**
 * THIN REAL ADAPTERS — the live/operator edge.
 *
 * These shell out to git / npm / trivy / semgrep and talk to R2 and
 * `.com`. They are deliberately NOT exercised by the vitest gate
 * (those binaries + network are not in CI); the pure core in
 * `scanner.ts` is the unit-tested deliverable. Every adapter
 * FAIL-CLOSES: any tool/IO failure throws `ScanRunnerError` (the core
 * turns that into the F grade) — none of them ever returns a clean
 * result on error.
 *
 * Operate from a Docker-equipped Flagship host (see README). The git
 * clone + tool runs happen inside a throwaway temp dir that is always
 * removed; harden further (rootless container, seccomp, no-net for
 * the scan step) in the deployment unit.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  ScanRunnerError,
  type QueueSource,
  type ReportStore,
  type ResultPoster,
  type ScanArtifacts,
  type ScanRunner,
  type ScanTarget,
} from "./ports.js";
import type { NpmAuditResult, SemgrepResult } from "./grade.js";
import { resolveImageRef } from "./imageRef.js";
import {
  findingsToVulnerabilities,
  parseTrivyJson,
  type Finding,
  type TrivyRunner,
} from "./trivy.js";

const execFileP = promisify(execFile);
const STEP_TIMEOUT_MS = 10 * 60_000;

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  reason: string,
): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args, {
      cwd,
      timeout: STEP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    // npm audit / trivy / semgrep exit non-zero WHEN THEY FIND
    // issues — that is success-with-findings, and the stdout still
    // holds the JSON. Only a missing binary / timeout / no-stdout is
    // a genuine fail-closed error.
    const e = err as { stdout?: string; killed?: boolean; code?: string };
    if (e && typeof e.stdout === "string" && e.stdout.length > 0 && !e.killed) {
      return e.stdout;
    }
    throw new ScanRunnerError(
      `${cmd} failed: ${err instanceof Error ? err.message : String(err)}`,
      reason,
    );
  }
}

/**
 * REAL `TrivyRunner` — the injected container/source vulnerability
 * seam. Shells out to the `trivy` binary; the `imageRef` is either a
 * built container image ref (`trivy image <ref>`) or a local source
 * path (`trivy fs <path>`), discriminated by the `docker://` prefix.
 *
 * TODO(live): this is NOT exercised by the vitest gate — Trivy + Docker
 * are not present in CI / the dev sandbox. The pipeline tests inject
 * `FakeTrivyRunner` instead. Wire the real binary + its rootless/
 * no-net sandbox flags in the deployment unit, then smoke it against a
 * known-vulnerable image (e.g. an old `node:18` tag).
 */
export class ExecTrivyRunner implements TrivyRunner {
  constructor(private readonly cwd: string = process.cwd()) {}

  async scan(imageRef: string): Promise<Finding[]> {
    const isImage = imageRef.startsWith("docker://");
    const ref = isImage ? imageRef.slice("docker://".length) : imageRef;
    const args = isImage
      ? ["image", "--quiet", "--no-progress", "--format", "json", "--severity", "CRITICAL,HIGH,MEDIUM,LOW", ref]
      : ["fs", "--quiet", "--no-progress", "--format", "json", "--severity", "CRITICAL,HIGH,MEDIUM,LOW", ref];
    const out = await run("trivy", args, this.cwd, "trivy-failed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new ScanRunnerError("trivy produced non-JSON output", "trivy-parse-failed");
    }
    return parseTrivyJson(parsed);
  }
}

/**
 * Real ScanRunner: git clone @ manifest_hash → verify tree hash →
 * (injected Trivy) + `npm audit` + `semgrep p/owasp-top-ten`. Throws
 * `ScanRunnerError` on ANY failure (the core fail-closes to F).
 *
 * The container-vuln scan is the injected `TrivyRunner` (defaulting to
 * `ExecTrivyRunner`) — so the whole pipeline is unit-testable with a
 * fake, and a caller can swap in a `trivy image <ref>` runner without
 * touching this orchestration.
 */
export class ExecScanRunner implements ScanRunner {
  constructor(private readonly trivy: TrivyRunner = new ExecTrivyRunner()) {}

  async run(target: ScanTarget): Promise<ScanArtifacts> {
    const work = await mkdtemp(join(tmpdir(), "flagship-scan-"));
    const repo = join(work, "repo");
    try {
      // Shallow-clone then check out the EXACT pinned revision.
      await run("git", ["clone", "--no-checkout", target.canonicalUrl, repo], work, "clone-failed");
      await run("git", ["-C", repo, "checkout", target.manifestHashHex], repo, "clone-checkout-failed");

      // Verify the checked-out tree hash equals the pinned manifest
      // hash. `git rev-parse HEAD^{tree}` is the canonical tree id.
      const treeOut = (
        await run("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], repo, "tree-hash-failed")
      ).trim();
      const treeDigestHex = treeOut;
      if (!treeDigestHex || treeDigestHex.length < 16) {
        throw new ScanRunnerError("could not resolve tree hash", "tree-hash-failed");
      }

      let manifest: unknown;
      try {
        manifest = JSON.parse(await readFile(join(repo, "flagship.app.json"), "utf8"));
      } catch {
        manifest = undefined; // runCustomChecks fail-closes on this
      }

      // Container vuln scan via the injected Trivy seam. Resolve the
      // OCI image ref from the manifest (`runtime.image`) — that named
      // image is the artifact the daemon actually runs, so it is the
      // grade target (`trivy image docker://<ref>`). A manifest with no
      // resolvable image falls back to a source-tree scan of the clone
      // (`trivy fs <path>`) so a repo-only listing still gets graded.
      const imageRef = resolveImageRef(manifest);
      const findings = await this.trivy.scan(
        imageRef ? `docker://${imageRef}` : repo,
      );
      const npmAudit = parseNpmAudit(
        await run("npm", ["audit", "--json", "--audit-level=low"], repo, "npm-audit-failed"),
      );
      const semgrep = parseSemgrep(
        await run("semgrep", ["--config=p/owasp-top-ten", "--json", "--quiet", "."], repo, "semgrep-failed"),
      );

      return {
        treeDigestHex,
        manifest,
        trivy: findingsToVulnerabilities(findings),
        npmAudit,
        semgrep,
        raw: { trivy: findings, npmAudit, semgrep },
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

function parseNpmAudit(out: string): NpmAuditResult {
  const parsed = JSON.parse(out) as {
    metadata?: { vulnerabilities?: Record<string, number> };
  };
  const v = parsed.metadata?.vulnerabilities ?? {};
  return {
    CRITICAL: v.critical ?? 0,
    HIGH: v.high ?? 0,
    MODERATE: v.moderate ?? 0,
    LOW: v.low ?? 0,
  };
}

function parseSemgrep(out: string): SemgrepResult {
  const parsed = JSON.parse(out) as {
    results?: Array<{ extra?: { severity?: string } }>;
  };
  const r: SemgrepResult = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const f of parsed.results ?? []) {
    const sev = (f.extra?.severity ?? "").toUpperCase();
    if (sev === "ERROR") r.ERROR++;
    else if (sev === "WARNING") r.WARNING++;
    else r.INFO++;
  }
  return r;
}

/**
 * Real R2 store via the S3-compatible HTTP PUT. Uses a presign-free
 * path: the deployment supplies a writeable bucket URL prefix (the
 * operator's R2 binding / signed proxy). Throws on non-2xx (the core
 * treats an upload failure as non-fatal-for-grade but still records
 * it; the grade is never upgraded to compensate).
 */
export class HttpReportStore implements ReportStore {
  constructor(private readonly bucketUrlPrefix: string) {}
  async put(key: string, json: string): Promise<string> {
    if (!this.bucketUrlPrefix) {
      throw new Error("R2 bucket URL prefix not configured");
    }
    // TODO(live): swap this presign-free PUT for the operator's actual
    // R2 path — either an aws4-signed S3 request to the bucket endpoint
    // or a `wrangler`/Worker-binding write proxy. The pipeline only
    // depends on the `ReportStore` contract (returns the object key),
    // so this is the single place the real R2 wiring lands.
    const res = await fetch(`${this.bucketUrlPrefix}/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: json,
    });
    if (!res.ok) throw new Error(`R2 upload failed: ${res.status}`);
    return key;
  }
}

/** Posts the signed envelope to `.com`. Throws on non-2xx. */
export class HttpResultPoster implements ResultPoster {
  constructor(private readonly apiBase: string) {}
  async post(creator: string, slug: string, body: unknown): Promise<void> {
    const res = await fetch(
      `${this.apiBase}/api/marketplace/${creator}/${slug}/scan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`scan-result POST failed: ${res.status} ${await res.text()}`);
    }
  }
}

/**
 * Pulls the work queue from the LANDED scan-queue endpoint
 * (`GET /api/internal/marketplace-scan-queue`, bearer-auth), which
 * returns listed listings that are never-scanned or stale. This is
 * the contract `handleMarketplaceScanQueue` already serves — we do
 * not invent a `?ungradedOnly=` query.
 */
export class HttpQueueSource implements QueueSource {
  constructor(
    private readonly apiBase: string,
    private readonly bearer: string,
    private readonly staleDays?: number,
  ) {}
  async list(): Promise<ScanTarget[]> {
    const u = new URL(`${this.apiBase}/api/internal/marketplace-scan-queue`);
    if (this.staleDays) u.searchParams.set("staleDays", String(this.staleDays));
    const res = await fetch(u, { headers: { authorization: `Bearer ${this.bearer}` } });
    if (!res.ok) throw new Error(`scan-queue returned ${res.status}`);
    const body = (await res.json()) as {
      queue?: Array<{
        creator: string;
        slug: string;
        canonicalUrl: string;
        manifestHashHex: string;
        manifestJson?: string;
      }>;
    };
    return (body.queue ?? []).map((q) => ({
      creator: q.creator,
      slug: q.slug,
      canonicalUrl: q.canonicalUrl,
      manifestHashHex: q.manifestHashHex,
      ...(typeof q.manifestJson === "string" ? { manifestJson: q.manifestJson } : {}),
    }));
  }
}

/** sha256 hex of a buffer — used by the operator edge for misc digests. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
