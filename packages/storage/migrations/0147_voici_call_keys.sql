-- voi.ci calls answered while Flagship is locked (docs/voici-calls.md, owner decisions 2026-11-15): a device's
-- call-only P-256 key, bound under the page's owner messages key (flagship/voici-call-key/v1), and the revocations
-- (flagship/voici-call-key-revoke/v1). `.com` checks a ringing device's join and its answer against these; the key
-- signs nothing else. Storage packages/storage/src/voiciCalls.ts, handlers packages/control-plane/src/voiciCalls.ts.
--
-- Re-runnable: every statement is CREATE ... IF NOT EXISTS.

-- One bound call key per device. The binding is kept whole so the room and the caller's browser can check it again.
CREATE TABLE IF NOT EXISTS voici_call_keys (
  username      TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  call_key_pub  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  signature     TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (username, device_id)
);

-- A revoked key never binds again (a replayed binding is refused), whoever signed the revocation.
CREATE TABLE IF NOT EXISTS voici_call_key_revocations (
  call_key_pub TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  revoked_at   INTEGER NOT NULL,
  signature    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voici_call_key_revocations_user ON voici_call_key_revocations(username);
