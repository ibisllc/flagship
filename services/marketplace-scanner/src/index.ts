#!/usr/bin/env node
/**
 * Flagship marketplace scanner — thin runtime entry.
 *
 * Wires the REAL adapters (`ExecScanRunner`, `HttpReportStore`,
 * `HttpResultPoster`, `HttpQueueSource`) into the pure core
 * (`scanTarget` in scanner.ts) and drains the landed scan-queue.
 * Designed to run from cron on a Docker-equipped Flagship host. This
 * file is intentionally minimal and is NOT unit-tested against real
 * infra — the policy + orchestration + signing live in the pure core
 * which the vitest gate covers exhaustively.
 *
 * Fail-closed end to end: a clone/tool/timeout/hash-mismatch yields a
 * signed F result (not a skip, not a pass); the post is always
 * scanner-signed via the protocol package.
 */

import {
  ExecScanRunner,
  HttpQueueSource,
  HttpReportStore,
  HttpResultPoster,
} from "./adapters.js";
import { resolveImageRefFromJson } from "./imageRef.js";
import { scanTarget } from "./scanner.js";
import { scannerKeypairFromHex } from "./scanResult.js";

interface RuntimeConfig {
  apiBase: string;
  scannerPrivHex: string;
  r2BucketUrlPrefix: string;
  scanQueueBearer: string;
  staleDays?: number;
  dryRun: boolean;
}

function readConfig(): RuntimeConfig {
  const scannerPrivHex = process.env["FLAGSHIP_SCANNER_PRIV_HEX"];
  if (!scannerPrivHex) {
    throw new Error("FLAGSHIP_SCANNER_PRIV_HEX env var is required");
  }
  const scanQueueBearer = process.env["FLAGSHIP_SCAN_QUEUE_BEARER"] ?? "";
  const dryRun = process.argv.includes("--dry");
  if (!scanQueueBearer && !dryRun) {
    throw new Error("FLAGSHIP_SCAN_QUEUE_BEARER env var is required");
  }
  const staleDaysRaw = process.env["FLAGSHIP_SCAN_STALE_DAYS"];
  return {
    apiBase: process.env["FLAGSHIP_API_BASE"] ?? "https://flagshipserver.com",
    scannerPrivHex,
    r2BucketUrlPrefix: process.env["FLAGSHIP_R2_BUCKET_URL"] ?? "",
    scanQueueBearer,
    staleDays: staleDaysRaw ? Number(staleDaysRaw) : undefined,
    dryRun,
  };
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const scanner = scannerKeypairFromHex(cfg.scannerPrivHex);
  const queue = new HttpQueueSource(cfg.apiBase, cfg.scanQueueBearer, cfg.staleDays);
  const deps = {
    runner: new ExecScanRunner(),
    reportStore: new HttpReportStore(cfg.r2BucketUrlPrefix),
    poster: new HttpResultPoster(cfg.apiBase),
    scanner,
    dryRun: cfg.dryRun,
  };

  const targets = await queue.list();
  console.log(`[scanner] ${targets.length} listing(s) need a scan`);
  let failures = 0;
  let skipped = 0;
  for (const t of targets) {
    // Image resolution: a listing whose manifest names no pullable
    // `runtime.image` has nothing for `trivy image` to grade this round.
    // LOG + SKIP it (don't fail the queue, don't post an F) — it stays
    // in the never-scanned set for the next tick. When the queue omits
    // manifestJson (older .com), fall through to the runner's on-disk
    // clone manifest instead of skipping.
    if (t.manifestJson !== undefined && resolveImageRefFromJson(t.manifestJson) === null) {
      skipped++;
      console.warn(
        `[scan] ${t.creator}/${t.slug} → SKIP: manifest names no resolvable runtime.image`,
      );
      continue;
    }
    try {
      const outcome = await scanTarget(deps, t);
      console.log(
        `[scan] ${t.creator}/${t.slug} → grade=${outcome.result.grade}` +
          (outcome.report.scanError ? ` (scan-error: ${outcome.report.scanError})` : "") +
          (outcome.posted ? " posted" : " (dry-run, not posted)"),
      );
    } catch (err) {
      failures++;
      // A throw here means the SIGNED POST itself failed (network /
      // .com rejected). The grade was still computed fail-closed; we
      // surface the failure and let the next cron tick retry. We
      // never swallow this into a success.
      console.error(
        `[scan] ${t.creator}/${t.slug} → POST FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (skipped > 0) {
    console.log(`[scanner] ${skipped}/${targets.length} listing(s) skipped (no resolvable image)`);
  }
  if (failures > 0) {
    console.error(`[scanner] ${failures}/${targets.length} post(s) failed`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.js")) {
  main().catch((err) => {
    console.error("[scanner] fatal:", err);
    process.exit(1);
  });
}
