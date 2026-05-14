/**
 * /qr-pipe upgrade telemetry — small wrapper around the
 * `qr_pipe_metrics` D1 table (migration 0016).
 *
 * Per-day buckets keyed by UTC date (`YYYY-MM-DD`). The Worker
 * increments one of two columns on each /qr-pipe upgrade attempt:
 *
 *   - `upgrade_count`        — request reached the DO (a DO was
 *                              materialised; this is what drives
 *                              free-tier duration consumption).
 *   - `rate_limited_count`   — request was turned away by
 *                              RATE_LIMITER_QR_PIPE before reaching
 *                              the DO.
 *
 * The /api/_status/relay endpoint reads the last N buckets so the
 * /status/ page can show a per-day chart. This is the operational
 * canary we wished we had before the first billing email.
 *
 * All operations are no-ops when the D1 binding is missing (local
 * dev, tests). Failures are swallowed and logged at debug level —
 * metrics MUST NOT block or fail an actual request.
 */

import type { D1Database } from "@flagship/storage";

export interface QrPipeMetricsRecord {
  bucketDay: string;
  upgradeCount: number;
  rateLimitedCount: number;
  updatedAt: number;
}

interface MetricsRow {
  bucket_day: string;
  upgrade_count: number;
  rate_limited_count: number;
  updated_at: number;
}

function rowToRecord(r: MetricsRow): QrPipeMetricsRecord {
  return {
    bucketDay: r.bucket_day,
    upgradeCount: r.upgrade_count,
    rateLimitedCount: r.rate_limited_count,
    updatedAt: r.updated_at,
  };
}

/**
 * UTC date in `YYYY-MM-DD` form. Pulled out so tests can pin a
 * deterministic bucket without mocking Date.
 */
export function utcDayBucket(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Increment the upgrade_count for today's bucket. */
export async function recordUpgrade(
  db: D1Database | undefined,
  now: Date = new Date(),
): Promise<void> {
  if (!db) return;
  await incrementColumn(db, "upgrade_count", utcDayBucket(now), now.getTime());
}

/** Increment the rate_limited_count for today's bucket. */
export async function recordRateLimited(
  db: D1Database | undefined,
  now: Date = new Date(),
): Promise<void> {
  if (!db) return;
  await incrementColumn(db, "rate_limited_count", utcDayBucket(now), now.getTime());
}

async function incrementColumn(
  db: D1Database,
  column: "upgrade_count" | "rate_limited_count",
  bucketDay: string,
  nowMs: number,
): Promise<void> {
  // Whitelisted via the union type above — never user-controlled, so
  // inlining it into the SQL is safe.
  const otherDefault = 0;
  const upgradeInit = column === "upgrade_count" ? 1 : otherDefault;
  const rateInit = column === "rate_limited_count" ? 1 : otherDefault;
  try {
    await db
      .prepare(
        `INSERT INTO qr_pipe_metrics
           (bucket_day, upgrade_count, rate_limited_count, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(bucket_day) DO UPDATE SET
           ${column} = ${column} + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(bucketDay, upgradeInit, rateInit, nowMs)
      .run();
  } catch (e) {
    // Telemetry must NEVER fail a request. Log at debug level (no
    // structured logger in this Worker) and swallow.
    console.warn("qrPipeMetrics: increment failed", column, (e as Error).message);
  }
}

/**
 * Return the most recent N day-buckets, most-recent first. Days with
 * zero traffic are omitted (no rows are written for them).
 */
export async function readRecent(
  db: D1Database | undefined,
  days: number,
): Promise<QrPipeMetricsRecord[]> {
  if (!db) return [];
  const safeDays = Math.max(1, Math.min(Math.floor(days), 90));
  try {
    const r = await db
      .prepare(
        `SELECT bucket_day, upgrade_count, rate_limited_count, updated_at
           FROM qr_pipe_metrics
           ORDER BY bucket_day DESC
           LIMIT ?`,
      )
      .bind(safeDays)
      .all<MetricsRow>();
    return r.results.map(rowToRecord);
  } catch (e) {
    console.warn("qrPipeMetrics: read failed", (e as Error).message);
    return [];
  }
}
