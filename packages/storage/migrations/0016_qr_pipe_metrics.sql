-- /qr-pipe upgrade telemetry (Task P3).
--
-- Counts WebSocket upgrade attempts on /qr-pipe per UTC day, split
-- between successful upgrades that materialised a Durable Object and
-- requests that were turned away at the RATE_LIMITER_QR_PIPE gate.
-- Surfaced via /api/_status/relay so /status/ can show "DO spawns in
-- the last 24h" — the canary that should have caught the duration
-- runaway before it tripped the free-tier ceiling.
--
-- One row per (bucket_day). Bucket key is the UTC date in ISO-8601
-- form, e.g. "2026-05-14". Rows are append-mostly-update; the table
-- stays tiny (one row per day forever).

CREATE TABLE IF NOT EXISTS qr_pipe_metrics (
  bucket_day TEXT NOT NULL PRIMARY KEY,
  upgrade_count INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
