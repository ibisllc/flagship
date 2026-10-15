-- The owner's view of the `.com` rate limits (apps/com/src/rateLimitLog.ts):
-- hourly counts per endpoint and axis of refusals, distinct refused callers
-- and near-limit passes. Nothing identifies a caller. Rows older than 90 days
-- are dropped by the 6-hourly cron. Re-runnable.
CREATE TABLE IF NOT EXISTS rate_limit_log (
  bucket_hour TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  axis TEXT NOT NULL,
  refused INTEGER NOT NULL DEFAULT 0,
  sources INTEGER NOT NULL DEFAULT 0,
  near INTEGER NOT NULL DEFAULT 0,
  unreachable INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_hour, endpoint, axis)
);
