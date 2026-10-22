-- Custom voi.ci names for services (docs/named-links.md).
--
-- voici_names: one row per custom name, keyed by the name with hyphens removed
-- (so `halloween-party` and `halloweenparty` are the same name). A name is
-- `live` while its service uses it, then `waiting` for 30 days after it is
-- given up (changed, cleared, lapsed or deleted): it answers 410, redirects
-- nowhere and nobody can take it, the previous owner included. The row is
-- deleted when the wait ends, which is what makes the name free again.
-- last_active_at is the last time a server of the account was seen running the
-- app; warned is how many of the two release warnings (30 and 7 days before)
-- went out.
--
-- voici_name_changes: every set, replace or clear, for the per-service and
-- per-account limits, and the order's single-use nonce. Nothing about the
-- caller beyond the account.
--
-- voici_links.retired_at: a service's random code is permanent while it lives;
-- when the service is deleted the code is retired for good (410, never minted
-- again). ADD COLUMN is apply-once: running it twice aborts.

CREATE TABLE IF NOT EXISTS voici_names (
  key            TEXT PRIMARY KEY,
  display        TEXT NOT NULL,
  username       TEXT NOT NULL,
  service_id     TEXT NOT NULL,
  state          TEXT NOT NULL,
  set_at         INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  warned         INTEGER NOT NULL DEFAULT 0,
  released_at    INTEGER,
  release_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_voici_names_service ON voici_names(username, service_id, state);
CREATE INDEX IF NOT EXISTS idx_voici_names_state ON voici_names(state, released_at);

CREATE TABLE IF NOT EXISTS voici_name_changes (
  username   TEXT NOT NULL,
  service_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  nonce      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voici_name_changes_service ON voici_name_changes(username, service_id, at);
CREATE INDEX IF NOT EXISTS idx_voici_name_changes_user ON voici_name_changes(username, at);
CREATE INDEX IF NOT EXISTS idx_voici_name_changes_nonce ON voici_name_changes(nonce);

ALTER TABLE voici_links ADD COLUMN retired_at INTEGER;
