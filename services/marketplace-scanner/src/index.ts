#!/usr/bin/env node
/**
 * Flagship marketplace scanner entry point.
 *
 * Discovers ungraded listings, scans each, posts results. Designed
 * to run from cron on a Docker-equipped host.
 *
 * Out-of-scope-for-v1: parallel scanning, fancy retry/backoff,
 * detailed metrics. The cron-driven model is "run, exit, run again
 * in 6 hours."
 */

import { execFileSync } from "node:child_process";
import { computeGrade, runCustomChecks, summarizeTrivy } from "./grade.js";
import { signScanResult, type ScanResult } from "./scanResult.js";

interface Listing {
  creator: string;
  slug: string;
  image_ref?: string | null;
  manifest_url?: string | null;
  scan_grade: string | null;
}

interface ScannerConfig {
  apiUrl: string;
  privKeyHex: string;
  r2BucketUrl: string;
  dryRun: boolean;
}

function readConfig(): ScannerConfig {
  const apiUrl = process.env["FLAGSHIP_API_URL"] ?? "https://flagshipserver.com";
  const privKeyHex = process.env["FLAGSHIP_SCANNER_PRIV_HEX"];
  if (!privKeyHex) {
    throw new Error("FLAGSHIP_SCANNER_PRIV_HEX env var is required");
  }
  const r2BucketUrl = process.env["R2_BUCKET_URL"] ?? "";
  return {
    apiUrl,
    privKeyHex,
    r2BucketUrl,
    dryRun: process.argv.includes("--dry"),
  };
}

async function listUngradedListings(apiUrl: string): Promise<Listing[]> {
  const res = await fetch(`${apiUrl}/api/marketplace/list?ungradedOnly=1`);
  if (!res.ok) throw new Error(`marketplace/list returned ${res.status}`);
  const body = (await res.json()) as { listings?: Listing[] };
  return (body.listings ?? []).filter((l) => l.scan_grade === null);
}

async function fetchManifest(manifestUrl: string): Promise<unknown> {
  const res = await fetch(manifestUrl, {
    headers: { "user-agent": "flagship-marketplace-scanner/0.0.1" },
  });
  if (!res.ok) {
    throw new Error(`manifest fetch failed: ${res.status} ${manifestUrl}`);
  }
  return res.json();
}

function runTrivy(imageRef: string): {
  vulns: { Severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; VulnerabilityID: string }[];
  imageDigestHex: string;
} {
  // trivy image --format json --quiet --severity HIGH,CRITICAL <image>
  const out = execFileSync(
    "trivy",
    ["image", "--format", "json", "--quiet", "--severity", "HIGH,CRITICAL", imageRef],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as {
    Metadata?: { ImageID?: string };
    Results?: Array<{ Vulnerabilities?: Array<{ Severity: string; VulnerabilityID: string }> }>;
  };
  const vulns: {
    Severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    VulnerabilityID: string;
  }[] = [];
  for (const r of parsed.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      if (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(v.Severity)) {
        vulns.push({
          Severity: v.Severity as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
          VulnerabilityID: v.VulnerabilityID,
        });
      }
    }
  }
  const digest = parsed.Metadata?.ImageID ?? "";
  const imageDigestHex = digest.startsWith("sha256:") ? digest.slice(7) : digest;
  return { vulns, imageDigestHex };
}

async function uploadReport(
  bucketUrl: string,
  creator: string,
  slug: string,
  imageDigestHex: string,
  report: unknown,
): Promise<string> {
  const key = `${creator}/${slug}/${imageDigestHex}.json`;
  if (!bucketUrl) return key; // dry-run / no R2 configured
  const res = await fetch(`${bucketUrl}/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new Error(`R2 upload failed: ${res.status}`);
  return key;
}

async function postScanResult(
  apiUrl: string,
  result: ScanResult,
  privKeyHex: string,
): Promise<void> {
  const body = signScanResult(result, privKeyHex);
  const res = await fetch(`${apiUrl}/api/marketplace/${result.creator}/${result.slug}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`scan-result POST failed: ${res.status} ${text}`);
  }
}

async function scanOne(listing: Listing, cfg: ScannerConfig): Promise<void> {
  console.log(`[scan] ${listing.creator}/${listing.slug}`);
  if (!listing.image_ref) {
    console.log("  → skip (no image_ref)");
    return;
  }
  if (!listing.manifest_url) {
    console.log("  → skip (no manifest_url)");
    return;
  }

  const manifest = await fetchManifest(listing.manifest_url);
  const customChecks = runCustomChecks(manifest);

  const { vulns, imageDigestHex } = runTrivy(listing.image_ref);
  const trivy = summarizeTrivy(vulns);
  const breakdown = computeGrade(trivy, customChecks);

  console.log(`  → grade=${breakdown.grade} (${breakdown.reasons.length} reasons)`);

  const report = {
    creator: listing.creator,
    slug: listing.slug,
    imageRef: listing.image_ref,
    imageDigestHex,
    grade: breakdown.grade,
    reasons: breakdown.reasons,
    trivy: breakdown.trivy,
    customChecks: breakdown.customChecks,
    vulnerabilities: vulns,
    scannedAt: Date.now(),
  };

  const reportKey = await uploadReport(
    cfg.r2BucketUrl,
    listing.creator,
    listing.slug,
    imageDigestHex,
    report,
  );

  const scanResult: ScanResult = {
    creator: listing.creator,
    slug: listing.slug,
    grade: breakdown.grade,
    reportKey,
    imageDigestHex,
    scannedAt: report.scannedAt,
  };

  if (cfg.dryRun) {
    console.log("  → dry-run: would post", scanResult);
    return;
  }
  await postScanResult(cfg.apiUrl, scanResult, cfg.privKeyHex);
  console.log("  → posted");
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const ungraded = await listUngradedListings(cfg.apiUrl);
  console.log(`[scanner] ${ungraded.length} ungraded listing(s)`);
  for (const l of ungraded) {
    try {
      await scanOne(l, cfg);
    } catch (err) {
      console.error(`  → FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (
  // ESM equivalent of "is this file the entry point"
  // (works in tsx + tsc-compiled output alike)
  process.argv[1] && process.argv[1].endsWith("index.ts") ||
  process.argv[1] && process.argv[1].endsWith("index.js")
) {
  main().catch((err) => {
    console.error("[scanner] fatal:", err);
    process.exit(1);
  });
}
