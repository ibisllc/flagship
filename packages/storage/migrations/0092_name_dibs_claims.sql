-- Name dibs (docs/naming-recovery-and-name-change.md §7, decided 2026-10-09).
--
-- During the one-year dibs window, a name whose `<name>.com` is registered is
-- reserved for whoever controls that .com. A claimant proves control by
-- publishing a challenge (DNS TXT `_flagship-claim.<name>.com` or
-- `https://<name>.com/.well-known/flagship-claim`) bound to their IRK and the
-- row's nonce. One row per (name, claimant); the FIRST verified claim wins,
-- enforced by the partial unique index below so two racing verifications can't
-- both succeed.
CREATE TABLE IF NOT EXISTS name_dibs_claims (
  name         TEXT NOT NULL,
  username     TEXT NOT NULL,
  irk_pub_hex  TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 1,
  verified_at  INTEGER,
  -- "dns" | "http" — how the proof was found.
  method       TEXT,
  -- Set once the verified claim was redeemed into an actual rename.
  consumed_at  INTEGER,
  PRIMARY KEY (name, username)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_name_dibs_one_winner
  ON name_dibs_claims(name) WHERE verified_at IS NOT NULL;

-- Every claim start, for the per-account rate limit (the RATE_LIMITER binding
-- is advisory, so the cap is enforced here).
CREATE TABLE IF NOT EXISTS name_dibs_starts (
  username    TEXT NOT NULL,
  started_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_name_dibs_starts_user ON name_dibs_starts(username, started_at);
