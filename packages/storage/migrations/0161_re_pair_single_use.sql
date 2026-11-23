-- Re-pair initiates are single use, and an admin veto holds for a day (security report F3,
-- docs/security/F3-re-pair-disclosure-investigation.md).
--
-- 1. `re_pair_initiates_used`: the SHA-256 of every accepted initiate's canonical signed bytes,
--    and of the credential it spent (a TOTP code's step, a recovery-session token), kept until
--    the initiate could no longer pass the freshness check anyway. A second initiate with the
--    same bytes or credential is refused (409 re-pair-replay). Same shape as
--    recovery_challenges_used (0112): expired rows are swept on each write, no cron.
--
-- 2. `re_pair_vetoed_keys`: after an admin vetoes a recovery, its new key is refused for 24 hours
--    (409 re-pair-vetoed-recently). A self-cancel by the recoverer does not add a row. Expired rows
--    are swept on each read.
--
-- Re-runnable (CREATE ... IF NOT EXISTS only). Apply before the `.com` deploy that reads them:
-- without the tables every re-pair initiate and veto fails.
CREATE TABLE IF NOT EXISTS re_pair_initiates_used (
  digest_hex TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS re_pair_vetoed_keys (
  username TEXT NOT NULL,
  new_irk_pub_hex TEXT NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (username, new_irk_pub_hex)
);
