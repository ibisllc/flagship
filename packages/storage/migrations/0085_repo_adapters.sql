-- The repo adapter index. When a box adapts a public open-source repo with AI
-- it shares the resulting flagship.app.json anonymously (POST
-- /api/adapters/submit). Accepted files queue here and a daily cron publishes
-- them to the PUBLIC repo ibisllc/flagship-adapters in one commit dated to the
-- UTC day, so every box reads the same bytes and anyone can audit them.
--
-- Deliberately anonymous: no account, device, server, IP or user agent is
-- accepted or stored, and time is kept only to the UTC day. A pending file's
-- body sits in R2 (ADAPTERS_BUCKET, `r2_key`) until it is published, then the
-- public repo holds it and `r2_key` is cleared. `confirmations` counts
-- byte-identical submissions already published; `pending_confirmations` the
-- ones the next publish adds.
CREATE TABLE IF NOT EXISTS repo_adapters (
  file_sha256           TEXT PRIMARY KEY,
  repo                  TEXT NOT NULL,
  base                  TEXT NOT NULL,
  license               TEXT NOT NULL,
  review                TEXT NOT NULL,
  bytes                 INTEGER,
  r2_key                TEXT,
  confirmations         INTEGER NOT NULL DEFAULT 0,
  pending_confirmations INTEGER NOT NULL DEFAULT 0,
  created_day           TEXT NOT NULL,
  published_day         TEXT
);
CREATE INDEX IF NOT EXISTS idx_repo_adapters_repo ON repo_adapters(repo);

-- The do-not-adapt list, published as do-not-adapt.txt. Added by hand
-- (POST /api/admin/adapter-blocklist). `state`: 'pending' = the next publish
-- removes the repo's directory and lists it; 'published' = listed;
-- 'unlisting' = the next publish drops it from the list, then the row goes.
CREATE TABLE IF NOT EXISTS adapter_blocklist (
  repo      TEXT PRIMARY KEY,
  note      TEXT,
  added_day TEXT NOT NULL,
  state     TEXT NOT NULL DEFAULT 'pending'
);
