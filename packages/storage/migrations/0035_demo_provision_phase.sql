-- Provisioning observability — make demo-server provisioning a glass box.
--
-- The box pushes named PHASE checkpoints to .com as it provisions; .com
-- stores the LATEST phase on the demo_users row and fans out a native
-- push on each change. The phone (and our debug poll) read the phase via
-- /api/account/resolve/<user> so provisioning is no longer opaque.
--
-- Phase vocabulary (see @flagship/protocol PROVISION_PHASES):
--   cloud-init: boot → cloned → deps → built → identity → registered
--   daemon:     tunnel-online → cert-issued → ready
--   terminal:   failed (provision_last_error carries the detail)
--
-- We store only the LATEST phase (not a history table) — the phone wants
-- "where is it now", and the push fan-out already delivers each change.
--
-- Additive + idempotent: three nullable columns, no backfill needed
-- (existing rows read NULL phase = "no checkpoint reported yet").

ALTER TABLE demo_users ADD COLUMN provision_phase      TEXT;
ALTER TABLE demo_users ADD COLUMN provision_phase_at   INTEGER;
ALTER TABLE demo_users ADD COLUMN provision_last_error TEXT;
