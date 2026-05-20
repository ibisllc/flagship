-- v1.2 security cascade — account-type concept + grace-period + quarantine.
-- See docs/v1.2-security-cascade.md.
--
-- Phase 1 of the cascade adds three concepts to the .com control plane:
--
--   1. account_type on `usernames` (TEXT, default 'single'). Existing
--      accounts are implicitly single-device; opting into 'multi'
--      requires TOTP enrollment (Phase 3). The plan doc references
--      this column as living on `users`, but Flagship's real-account
--      table is `usernames` (see 0001_initial.sql) — adjusted here.
--
--   2. Per-row grace_seconds + totp_required + totp_proof_consumed on
--      `pending_re_pairs`. Phase 2 widens the grace from 24h to 7d
--      when account_type='single' and requires a TOTP proof for
--      'multi'. Capturing grace_seconds explicitly on the row keeps
--      pending rows that crossed the migration boundary bisectable
--      (the docs §"Migration of existing accounts" requires that
--      in-flight rows keep their original 24h grace, not get widened).
--
--   3. quarantine_until on `push_tokens`. The plan doc refers to this
--      as `paired_sessions.quarantine_until`. On the .com side, the
--      device record IS `push_tokens` (the daemon-side paired_sessions
--      lives in a local JSON store under the daemon's data dir and is
--      out of scope for Worker-enforced quarantine). New devices
--      admitted to a multi-device account get a non-zero
--      `quarantine_until` set on their push_tokens row; the Worker
--      enforces this on /api/re-pair + the disconnect endpoints in
--      Phase 2. Default 0 = already-trusted (the migration of existing
--      rows lands them all as trusted, per the docs).
--
-- recovery_codes_hashes_json stores a JSON array of argon2id-hashed
-- single-use recovery codes (Phase 3). totp_secret_encrypted is
-- encrypted at rest with a Worker-side KEK (Phase 3 secret
-- FLAGSHIP_TOTP_KEK). totp_enrolled_at is the wall-clock ms of the
-- successful enroll-confirm.

ALTER TABLE usernames ADD COLUMN account_type TEXT NOT NULL DEFAULT 'single';
ALTER TABLE usernames ADD COLUMN totp_secret_encrypted TEXT;
ALTER TABLE usernames ADD COLUMN recovery_codes_hashes_json TEXT;
ALTER TABLE usernames ADD COLUMN totp_enrolled_at INTEGER;

ALTER TABLE pending_re_pairs ADD COLUMN grace_seconds INTEGER NOT NULL DEFAULT 86400;
ALTER TABLE pending_re_pairs ADD COLUMN totp_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_re_pairs ADD COLUMN totp_proof_consumed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE push_tokens ADD COLUMN quarantine_until INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_push_tokens_quarantine ON push_tokens(quarantine_until);
CREATE INDEX IF NOT EXISTS idx_usernames_account_type ON usernames(account_type);
