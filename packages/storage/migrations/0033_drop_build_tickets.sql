-- 0033_drop_build_tickets — rip the build_tickets table.
--
-- QR-pipe is now the only flow for handing a signed InstallBlob from
-- the phone to the desktop; .com no longer stores signed blobs at
-- rest. The /api/build-tickets/* endpoints are gone (controlPlaneRoutes.ts).
-- See commit body for the full rationale.
--
-- Idempotent: DROP IF EXISTS so this runs cleanly against a fresh DB
-- (where the table never existed) as well as against legacy prod (where
-- it does).
DROP INDEX IF EXISTS idx_build_tickets_username;
DROP TABLE IF EXISTS build_tickets;
