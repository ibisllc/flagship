-- Code protection (TOTP) enrolment, security report F2 (docs/security/F2-2fa-enrolment-investigation.md).
--
-- 1. `totp_outcome_log`: hourly counts of how each enrolment call ended (`ok` or the refusal's `code`, or
--    `internal-error`), per endpoint (`enroll-begin`, `enroll-confirm`, `disable`). Nothing about the caller or the
--    account is stored. Written by apps/com/src/totpOutcomeLog.ts, read by GET /api/admin/totp-outcomes and
--    `npm run totp-outcomes`; rows older than 90 days are dropped by the 6-hourly cron.
--
-- 2. Existing rows: a secret that was begun but never confirmed (`totp_secret_encrypted` set, `totp_enrolled_at`
--    NULL) is cleared. Until now `enroll-begin` wrote straight into the live column and re-pair counted any value
--    there as an enrolled code factor, so an abandoned setup left a recovery credential nobody remembers (one
--    production account, 2026-11-23). Its owner sees "Code protection: off" before and after, and can start again.
--    Confirmed rows (`totp_enrolled_at` set) are not touched: their secret and recovery codes keep working.
--
-- 3. `usernames.totp_pending_secret_encrypted` + `totp_pending_at`: `enroll-begin` now stages the new secret here
--    (an hour to confirm); only `enroll-confirm` moves it into `totp_secret_encrypted`, the column re-pair reads.
--    NULL for every existing row.
--
-- APPLY-ONCE for the two ALTERs, which are last: a re-run fails at the first one with "duplicate column name",
-- which is expected, after the CREATE and the UPDATE (both harmless to repeat) have run again. Apply it before the
-- `.com` deploy that reads the columns.
CREATE TABLE IF NOT EXISTS totp_outcome_log (
  bucket_hour TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_hour, endpoint, outcome)
);
UPDATE usernames SET totp_secret_encrypted = NULL
  WHERE totp_secret_encrypted IS NOT NULL AND totp_enrolled_at IS NULL;
ALTER TABLE usernames ADD COLUMN totp_pending_secret_encrypted TEXT;
ALTER TABLE usernames ADD COLUMN totp_pending_at INTEGER;
