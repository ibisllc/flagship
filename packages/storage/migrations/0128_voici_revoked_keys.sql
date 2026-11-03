-- voi.ci browser-key revocations keyed by (browser key, pseudonym) (security review, voi.ci Low a; code in
-- packages/storage/src/voici.ts, packages/control-plane/src/voiciMailbox.ts handleVoiciRevoke).
--
-- 0123's voici_revoked_delegates is keyed by the browser key alone and written with INSERT OR IGNORE, so a pseudonym
-- that signed a revocation for somebody else's browser key signed that browser out everywhere, and its row kept the
-- real pseudonym's later revocation from being stored. A revocation now ends one pseudonym's delegation to one browser
-- key, and only that one.
--
-- Re-runnable: CREATE ... IF NOT EXISTS and INSERT OR IGNORE. The old table is left in place (and copied again, to no
-- effect, on a re-run); nothing reads it any more, and a later migration may drop it.
CREATE TABLE IF NOT EXISTS voici_revoked_keys (
  delegate_pub  TEXT NOT NULL,
  principal_pub TEXT NOT NULL,
  page_id       TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER NOT NULL,
  PRIMARY KEY (delegate_pub, principal_pub)
);
CREATE INDEX IF NOT EXISTS idx_voici_revoked_keys_page ON voici_revoked_keys(page_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_voici_revoked_keys_expiry ON voici_revoked_keys(expires_at);

INSERT OR IGNORE INTO voici_revoked_keys (delegate_pub, principal_pub, page_id, expires_at, revoked_at)
  SELECT delegate_pub, principal_pub, page_id, expires_at, revoked_at FROM voici_revoked_delegates;
