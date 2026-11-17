-- voi.ci call keys: an owner-signed revocation binds only the account that signed it (05c review F1). A key revoked
-- by its own P-256 signature stays in voici_call_key_revocations and never binds again anywhere; a revocation signed by
-- a page's owner messages key lands here, keyed (username, call key), and refuses that key for that account only, so
-- one account cannot revoke another account's call key. Storage packages/storage/src/voiciCalls.ts.
--
-- Re-runnable: CREATE ... IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS voici_call_key_account_revocations (
  username     TEXT NOT NULL,
  call_key_pub TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  revoked_at   INTEGER NOT NULL,
  signature    TEXT NOT NULL,
  PRIMARY KEY (username, call_key_pub)
);
