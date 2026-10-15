/**
 * The owner's view of the rate limits (rateLimit.ts): hourly counts per
 * endpoint and axis in D1 `rate_limit_log` (migration 0101), read by
 * GET /api/admin/rate-limits and scripts/rate-limit-report.mjs.
 *
 *   refused      requests turned away
 *   sources      distinct callers refused (a refusal after a pass; the
 *                counter knows, nothing about the caller is stored)
 *   near         passes that took a window to 80% of its budget
 *   unreachable  checks that found the counter down
 *
 * Writing never fails or slows a request: callers hand the promise to
 * waitUntil, and errors are logged and dropped.
 */

import type { D1Database } from "@flagship/storage";

export type RateLimitEventKind = "refusal" | "first-refusal" | "near" | "unreachable";

export interface RateLimitEvent {
  endpoint: string;
  /** The axis that tripped or came close; "counter" when it was unreachable. */
  axis: string;
  kind: RateLimitEventKind;
}

/** Hours of log kept; the 6-hourly cron drops older rows. */
export const RATE_LIMIT_LOG_RETENTION_DAYS = 90;

/** `2026-10-15T21` (UTC). */
export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export async function recordRateLimitEvents(
  db: D1Database,
  events: readonly RateLimitEvent[],
  now: Date = new Date(),
): Promise<void> {
  const bucket = hourBucket(now);
  const sql =
    "INSERT INTO rate_limit_log (bucket_hour, endpoint, axis, refused, sources, near, unreachable) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bucket_hour, endpoint, axis) DO UPDATE SET " +
    "refused = refused + excluded.refused, sources = sources + excluded.sources, " +
    "near = near + excluded.near, unreachable = unreachable + excluded.unreachable";
  try {
    await db.batch(
      events.map((e) => {
        const refused = e.kind === "refusal" || e.kind === "first-refusal" ? 1 : 0;
        return db
          .prepare(sql)
          .bind(
            bucket,
            e.endpoint,
            e.axis,
            refused,
            e.kind === "first-refusal" ? 1 : 0,
            e.kind === "near" ? 1 : 0,
            e.kind === "unreachable" ? 1 : 0,
          );
      }),
    );
  } catch (err) {
    console.warn("rateLimitLog: record failed", (err as Error).message);
  }
}

export interface RateLimitLogRow {
  day: string;
  endpoint: string;
  axis: string;
  refused: number;
  sources: number;
  near: number;
  unreachable: number;
}

/** Per day, endpoint and axis since `sinceDay` (YYYY-MM-DD, inclusive). */
export async function readRateLimitLog(db: D1Database, sinceDay: string): Promise<RateLimitLogRow[]> {
  const r = await db
    .prepare(
      "SELECT substr(bucket_hour, 1, 10) AS day, endpoint, axis, SUM(refused) AS refused, " +
        "SUM(sources) AS sources, SUM(near) AS near, SUM(unreachable) AS unreachable " +
        "FROM rate_limit_log WHERE bucket_hour >= ? GROUP BY day, endpoint, axis ORDER BY day, endpoint, axis",
    )
    .bind(sinceDay)
    .all<RateLimitLogRow>();
  return r.results;
}

export async function pruneRateLimitLog(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_LOG_RETENTION_DAYS * 86_400_000);
  await db.prepare("DELETE FROM rate_limit_log WHERE bucket_hour < ?").bind(hourBucket(cutoff)).run();
}
