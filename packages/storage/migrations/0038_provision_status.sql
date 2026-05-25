-- Provisioning-status channel — keyed by the auth-code serial (order id).
--
-- A phone app watches a box's install progress in real time: the phone
-- knows the serial from the order it created; the installer has it in the
-- recipe. The box POSTs a named PHASE checkpoint to
-- POST /api/order/:serial/status; the phone polls GET /api/order/:serial/status.
--
-- Unlike demo_users.provision_phase (which is the per-demo-row "latest
-- phase" mirror), this table is keyed by SERIAL and is the canonical
-- per-order progress channel for the real (non-demo) install path. We
-- keep BOTH the latest phase/detail/updated_at AND an append-only
-- `history` (JSON array of {phase, detail, ts}) so the phone can render
-- a timeline, not just the current step.
--
-- Phase vocabulary (validated at the handler boundary):
--   booting downloading partitioning installing registering
--   sealing pairing live error

CREATE TABLE IF NOT EXISTS provision_status (
  serial        TEXT PRIMARY KEY,
  server_domain TEXT,
  phase         TEXT NOT NULL,
  detail        TEXT,
  updated_at    INTEGER NOT NULL,
  history       TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_provision_status_updated_at
  ON provision_status(updated_at);
