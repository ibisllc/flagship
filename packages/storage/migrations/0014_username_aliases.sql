-- Task #93 — Permanent username handover (alias map).
--
-- When a user renames `oldUsername` → `newUsername`:
--   1. .com inserts a fresh row in `usernames` for `newUsername`
--      keyed to the SAME IRK pubkey the old name was claimed under.
--   2. .com inserts a row here mapping `old_username` → `new_username`.
--
-- The alias row is PERMANENT. The old name never re-enters the claim
-- pool, even after this user later deletes their account. That's what
-- prevents a stolen account from being silently passed to a different
-- person — every link, business card, or QR-code referencing the old
-- name resolves to the SAME identity (or to a 410 if the alias is
-- later GC'd from public resolvers; never to a different person).
--
-- `effective_at` is informational only — clients use it to decide
-- whether to actively soft-redirect (during the ~30-day operational
-- overlap) vs. just resolve under the hood. The alias is authoritative
-- regardless of whether `now < effective_at`.
CREATE TABLE IF NOT EXISTS usernames_aliases (
  old_username TEXT PRIMARY KEY,
  new_username TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  signature_hex TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usernames_aliases_new
  ON usernames_aliases(new_username);
