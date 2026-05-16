-- Demo-account rolling LLM token ledger (#85).
--
-- Append-only grant log used to enforce a strict rolling-window token
-- ceiling for is_demo users. One row per LLM-promo issue; the Worker
-- pessimistically logs the full per-issue grant (it never proxies LLM
-- traffic, mirroring llm_promo_usage). A genuine rolling window — not a
-- calendar bucket — so a demo account can't burst-reset at midnight.
--
-- Rows older than the active window are pruned on append (per user), so
-- this table stays tiny. No primary key: it is an event log, not a
-- keyed record. The (username, granted_at) index serves both the
-- windowed SUM and the prune DELETE.
--
-- Pre-launch: no production rows, so the CREATE is non-destructive.

CREATE TABLE IF NOT EXISTS demo_llm_ledger (
  username   TEXT    NOT NULL,
  granted_at INTEGER NOT NULL,
  tokens     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demo_llm_ledger_user_time
  ON demo_llm_ledger (username, granted_at);
