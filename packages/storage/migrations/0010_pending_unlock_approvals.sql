-- RETIRED: this table backed the legacy plaintext unlock-approval boot
-- flow, which has been removed in favor of the RELAY (sealed secret
-- mailbox) + box-sealed auto-unlock lease model. The application code
-- that read/wrote this table is gone. The table is intentionally LEFT
-- IN PLACE in prod D1 (dropping a prod table is irreversible and there
-- are no rows of value); no new migration drops it.
--
-- Pending unlock approvals — when a server polls /unlock-key/consume
-- and there's no lease present, .com records a pending row here and
-- fans a push to the user's devices. The row is the canonical "this
-- server is asking to boot" entity that:
--   - the webapp's /api/screens/unlock-approvals/pending lists
--   - the lease deposit handler clears on success
--   - serves as the dedup ledger for push fan-out
--     (last_push_at gates re-pushing the same boot wait)
--
-- One row per server_domain — boots don't overlap on a single
-- server, so PK is enough. request_id is opaque and rotates per
-- new boot wait (i.e. when the row is first inserted or after a
-- /consume succeeded and the row was deleted, then a fresh poll
-- re-inserts).
CREATE TABLE IF NOT EXISTS pending_unlock_approvals (
  server_domain TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  last_push_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pending_unlock_approvals_requested
  ON pending_unlock_approvals(requested_at);
