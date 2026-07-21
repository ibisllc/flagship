-- usernames.last_active — coarse "account last seen" timestamp (epoch-ms).
--
-- Bumped (idempotently, ~once/day) on any authenticated/owner-IRK-signed read
-- path so the sysadmin username-reclaim tool can free a name that has been
-- inactive for ≥ 90 days (docs/account-deletion-and-name-reclaim.md §3). The
-- reclaim is a manual, audit-logged, never-bulk admin command — NOT an
-- automatic GC. ADDITIVE + nullable: pre-migration rows decode as NULL, which
-- the reclaim tool treats as "no recorded activity" (it falls back to
-- claimed_at so a legacy row is never spuriously eligible the day after migrate).

ALTER TABLE usernames ADD COLUMN last_active INTEGER;
