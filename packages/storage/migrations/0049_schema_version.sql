-- Migration ledger (OPS-2) — a lightweight record of which repo
-- migrations have been applied to this D1 database.
--
-- The `.com` migration path is manual + out-of-band (one `wrangler d1
-- execute --file` per file; see this directory's README.md), so prod D1
-- drifts from the repo's migration set with no way to see the gap at a
-- glance. This table is that visibility tool: the operator records the
-- version string (the migration filename's leading id, e.g. "0049") here
-- as they apply each file, and `GET /api/admin/schema-status` compares the
-- recorded set against the repo's known set to surface drift.
--
-- This is NOT an auto-migrator — recording happens out-of-band (manually,
-- or via the admin POST /api/admin/schema-version/:version stamp). The
-- ledger only ever READS back what was explicitly recorded.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, re-runnable as-is per the
-- idempotent-migration template in README.md.

CREATE TABLE IF NOT EXISTS schema_version (
  -- Migration version id — the filename's leading token, e.g. "0049".
  version    TEXT NOT NULL PRIMARY KEY,
  -- ms since epoch — when this version was recorded as applied.
  applied_at INTEGER NOT NULL
);
