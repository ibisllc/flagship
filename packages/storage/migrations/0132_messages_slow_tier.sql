-- Messages: an account whose device already started Messages for another account this month is enrolled on the slow
-- tier instead of being refused (docs/voici-and-messages.md §9.5). `slow_tier` = 1 keeps it there on every later
-- attestation, although its device keeps passing the integrity check. Additive: 0 for every existing enrollment.
-- apply-once (bare ADD COLUMN; a re-run aborts on the duplicate column, which is expected).
ALTER TABLE messages_enrollments ADD COLUMN slow_tier INTEGER NOT NULL DEFAULT 0;
