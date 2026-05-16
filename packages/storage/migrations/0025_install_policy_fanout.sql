-- Install-policy push fan-out ledger (N0d-2).
--
-- One row per newly-registered server. The phone owns the install
-- *policy*; .com only records that, on a successful new registration,
-- it fanned a category-only (empty-payload) push out to the user's
-- device family so they reconcile their server list. Keyed by
-- server_domain because server registration is one-shot (the
-- auth-code is single-use), so the row doubles as a fan-out
-- idempotency guard (INSERT OR IGNORE: a retried registration does
-- NOT re-notify) and as operational visibility (fanout_count,
-- notified_at).
--
-- Pre-launch: no production rows, so the CREATE is non-destructive.

CREATE TABLE IF NOT EXISTS install_policy_fanout (
  server_domain TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL,
  registered_at INTEGER NOT NULL,
  fanout_count  INTEGER NOT NULL,
  notified_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_install_policy_fanout_user
  ON install_policy_fanout (username);
