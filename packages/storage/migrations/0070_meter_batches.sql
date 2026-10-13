-- Metering: batch ids that make relay usage reports idempotent.
--
-- The .services relay reports usage in batches, each with a random 128-bit
-- id (billing/docs/spec/report-and-lease-v1.md). /api/usage/report claims
-- the id in the same D1 batch (one transaction) as the counter adds in
-- meter_counters (0069), so a batch the relay retries after a lost response
-- is recognised and counted once. Rows are kept for an hour (keep_until) and
-- pruned 32 at a time by each later report, so the table holds about
-- (reports per hour) rows.
--
-- Privacy: a random batch id, a random claim token and an expiry. Never an
-- account, an amount, a host or an address.
--
-- Same shape as @ibisllc/billing-metering's schema/meter_batches.sql.
-- Re-runnable (CREATE IF NOT EXISTS). Apply BEFORE deploying the .com Worker
-- that reads it; the relay can deploy before or after that Worker.

CREATE TABLE IF NOT EXISTS meter_batches (
  -- The relay's batch id: 16–128 characters of [A-Za-z0-9_-].
  batch_id   TEXT    NOT NULL PRIMARY KEY,
  -- Random per request; only the request that inserted the row adds counts.
  claim      TEXT    NOT NULL,
  -- ms since epoch after which the id may be forgotten.
  keep_until INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS meter_batches_keep_until ON meter_batches (keep_until);
