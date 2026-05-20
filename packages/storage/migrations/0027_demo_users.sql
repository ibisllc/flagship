-- Plan A — sample users (on-connect Hetzner provisioning).
--
-- A demo user is a TEST_ACCOUNTS entry PLUS one row in this table.
-- The row carries the durable artifacts of the create-sample-user
-- flow (the personalized ISO key in R2 + the Hetzner snapshot id)
-- plus the transient state of the currently-or-recently-provisioned
-- Hetzner server.
--
-- States (see docs/sample-users.md §4):
--   'none'                    -- no Hetzner server is provisioned
--   'provisioning'            -- POST /servers issued; awaiting running+registered
--   'up'                      -- server fully booted; serving /api/screens/*
--   'idle-pending-teardown'   -- cron identified the row; DELETE issued or pending
--
-- last_activity_at is wall-clock ms (Date.now()). The idle reaper
-- runs every 10 minutes (see apps/com/wrangler.toml crons).

CREATE TABLE IF NOT EXISTS demo_users (
  username           TEXT PRIMARY KEY,
  display            TEXT NOT NULL,
  snapshot_id        TEXT,                    -- Hetzner snapshot/image id; populated after create
  iso_r2_key         TEXT,                    -- R2 object key under flagship-iso-temp
  ttl_idle_minutes   INTEGER NOT NULL DEFAULT 30,
  region             TEXT NOT NULL DEFAULT 'fsn1',
  size               TEXT NOT NULL DEFAULT 'cx22',
  active_server_id   TEXT,                    -- Hetzner server id when state in (provisioning, up, idle-pending-teardown)
  active_server_fqdn TEXT,                    -- e.g. home.demoalice.flagship.services
  last_activity_at   INTEGER NOT NULL DEFAULT 0,
  state              TEXT NOT NULL DEFAULT 'none',
  created_at         INTEGER NOT NULL,
  CHECK (state IN ('none', 'provisioning', 'up', 'idle-pending-teardown'))
);

CREATE INDEX IF NOT EXISTS idx_demo_users_state         ON demo_users(state);
CREATE INDEX IF NOT EXISTS idx_demo_users_last_activity ON demo_users(last_activity_at);
