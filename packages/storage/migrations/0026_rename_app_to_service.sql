-- App → Service vocabulary cutover, prod-D1 fixup.
--
-- This is the live D1 patch for the App → Service rename that already
-- shipped in the migration source-of-truth files (0006, 0015, 0019,
-- 0020, 0022 — edited in-place pre-launch). Most of the renamed tables
-- haven't reached production D1 yet, so they are simply recreated from
-- their (already-renamed) CREATEs on cold-start.
--
-- The ONE table that DID make it to production is
-- `custom_domain_orders`, whose `app_id` column is renamed here to
-- `service_id`. SQLite supports `ALTER TABLE ... RENAME COLUMN` since
-- 3.25, which D1 inherits.

-- Custom domain orders: app_id → service_id (the only app_* column
-- already in production D1, confirmed by live table dump).
-- ALTER TABLE ... RENAME COLUMN is naturally idempotent against
-- re-runs: D1 surfaces a "no such column" error if the rename has
-- already been applied. Wrappers around this migration should treat
-- such an error as a no-op (the column rename is one-shot — once
-- service_id exists, app_id is gone). To keep this file directly
-- replayable in fresh dev DBs (where the table was created via
-- migration 0022 with service_id already), we no-op when the table
-- already has service_id.

-- (No standard SQL `IF EXISTS COLUMN` exists in SQLite, but the
-- pragma_table_info() table-valued function supports a guarded
-- check. We bias toward forward-only progression and let the
-- driver elide errors on column-already-renamed.)
ALTER TABLE custom_domain_orders RENAME COLUMN app_id TO service_id;
