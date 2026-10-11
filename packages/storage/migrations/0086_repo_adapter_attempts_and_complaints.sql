-- Repo adapter feedback (apps/com/src/adapterIndex.ts, adapterPublish.ts).
-- Neither table holds any identity: no account, server, IP or user agent, and
-- time only to the UTC day.
--
-- adapter_attempts: how many verdict-asking submissions (`wait: true`) a
-- (repo, commit) had on a day, so a box's AI can fix a refusal a few times
-- but not probe without end. Rows older than 7 days are pruned at publish.
CREATE TABLE IF NOT EXISTS adapter_attempts (
  repo  TEXT NOT NULL,
  base  TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, base, day)
);

-- adapter_complaints: a published adapter failed to build or start during an
-- install, or its owner reported a problem (`detail`, never published). The
-- publish counts build/start complaints into index.json (`counted` marks the
-- ones already reflected), retires an adapter at 3 complaints of any kind,
-- and has a reported adapter reviewed again once (`reviewed`). A live
-- adapter's complaints go after 90 days; a retired one keeps them until it is
-- pruned (180 days after retirement). Deleted with their adapter.
CREATE TABLE IF NOT EXISTS adapter_complaints (
  id          INTEGER PRIMARY KEY,
  file_sha256 TEXT NOT NULL,
  stage       TEXT NOT NULL,
  detail      TEXT,
  day         TEXT NOT NULL,
  counted     INTEGER NOT NULL DEFAULT 0,
  reviewed    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_adapter_complaints_file ON adapter_complaints(file_sha256);

-- adapter_insights: a weekly, private summary (from a cheap model) of why
-- retired adapters failed and how the adaptation harness could avoid it.
-- Never published. Read via GET /api/admin/adapter-insights.
CREATE TABLE IF NOT EXISTS adapter_insights (
  id   INTEGER PRIMARY KEY,
  day  TEXT NOT NULL,
  json TEXT NOT NULL
);

-- Retired adapters: out of the public tree after 3 problem reports or a
-- failed review, but kept here (with their complaints) so an identical
-- resubmission is refused and the weekly insight can learn from them; pruned
-- 180 days after retirement. APPLY-ONCE: SQLite has no ADD COLUMN IF NOT
-- EXISTS, so a re-run of this file stops here with "duplicate column name"
-- (expected; everything above is already in place). Kept last on purpose.
ALTER TABLE repo_adapters ADD COLUMN retired_day TEXT;
ALTER TABLE repo_adapters ADD COLUMN retired_reason TEXT;
