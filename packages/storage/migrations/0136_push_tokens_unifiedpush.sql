-- UnifiedPush for Android phones without Google Play Services: a push token's
-- platform may now be 'unifiedpush' (a Web Push endpoint from the phone's
-- distributor, stored like a browser subscription). SQLite can't alter a CHECK,
-- so the table is rebuilt with the same columns, keys and indexes; every row is
-- kept. Re-runnable: the copy is guarded and the indexes use IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS push_tokens_v2 (
  token_id                         TEXT PRIMARY KEY,
  username                         TEXT NOT NULL,
  device_id                        TEXT NOT NULL,
  platform                         TEXT NOT NULL CHECK (platform IN ('apns', 'fcm', 'webpush', 'unifiedpush')),
  provider_token                   TEXT NOT NULL,
  push_x25519_pub_hex              TEXT NOT NULL,
  registration_signature_hex       TEXT NOT NULL,
  registered_at                    INTEGER NOT NULL,
  last_seen_at                     INTEGER NOT NULL,
  quarantine_until                 INTEGER NOT NULL DEFAULT 0,
  quarantine_alerts_fired_bitmap   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (username, device_id) REFERENCES device_identities(account_id, device_id) ON DELETE CASCADE
);
INSERT INTO push_tokens_v2 (token_id, username, device_id, platform, provider_token, push_x25519_pub_hex, registration_signature_hex, registered_at, last_seen_at, quarantine_until, quarantine_alerts_fired_bitmap)
  SELECT token_id, username, device_id, platform, provider_token, push_x25519_pub_hex, registration_signature_hex, registered_at, last_seen_at, quarantine_until, quarantine_alerts_fired_bitmap
  FROM push_tokens
  WHERE NOT EXISTS (SELECT 1 FROM push_tokens_v2);
DROP TABLE IF EXISTS push_tokens;
ALTER TABLE push_tokens_v2 RENAME TO push_tokens;
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(username);
CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(username, device_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_quarantine ON push_tokens(quarantine_until);
