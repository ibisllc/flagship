-- @ibisllc/billing-metering — batch ids for a SQL store's idempotent
-- addBatch (docs/spec/report-and-lease-v1.md).
--
-- Portable across SQLite (3.35+, incl. Cloudflare D1) and PostgreSQL. One
-- row per batch id an edge has reported, kept only until `keep_until` (ms
-- since epoch). A row holds a random id, a random claim token and an expiry:
-- never an account, an amount or anything about what was metered.

CREATE TABLE IF NOT EXISTS meter_batches (
  batch_id   TEXT   NOT NULL PRIMARY KEY,
  claim      TEXT   NOT NULL,
  keep_until BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS meter_batches_keep_until ON meter_batches (keep_until);

-- addBatch(batchId, entries, now, keepUntil) — ONE transaction (a D1
-- batch() is one), with a fresh random claim token per call:
--
--   1. prune a few expired ids, so the table stays at (report rate × keep):
--      DELETE FROM meter_batches WHERE batch_id IN
--        (SELECT batch_id FROM meter_batches WHERE keep_until < :now LIMIT 32);
--
--   2. claim the id; a duplicate leaves the earlier row (and its claim):
--      INSERT INTO meter_batches (batch_id, claim, keep_until)
--      VALUES (:batch_id, :claim, :keep_until)
--      ON CONFLICT (batch_id) DO NOTHING
--      RETURNING batch_id;
--
--   3. per entry, add only if THIS call holds the claim:
--      INSERT INTO meter_counters (account, resource, period, amount, updated_at)
--      SELECT :account, :resource, :period, :amount, :now
--      WHERE EXISTS (SELECT 1 FROM meter_batches
--                    WHERE batch_id = :batch_id AND claim = :claim)
--      ON CONFLICT (account, resource, period) DO UPDATE SET
--        amount     = meter_counters.amount + excluded.amount,
--        updated_at = excluded.updated_at
--      RETURNING amount;
--
-- Step 2 returning no row means a duplicate: steps 3 return no rows and
-- change nothing. Because the claim and the adds commit together, a crash
-- either counts the whole batch once or not at all.
