-- LUKS unlock-on-boot tables.
--
-- sealed_luks_keys: server-deposited at install time, sealed against
--                   the user's BAK pubkey. Reading is public — useless
--                   without the phone.
-- unlock_key_deposits: phone-deposited (after biometric), one-shot
--                   consumed by the boot stage with TTL.

CREATE TABLE IF NOT EXISTS sealed_luks_keys (
  server_domain TEXT PRIMARY KEY,
  sealed_key_hex TEXT NOT NULL,
  sealed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS unlock_key_deposits (
  server_domain TEXT PRIMARY KEY,
  unlock_key_hex TEXT NOT NULL,
  deposited_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unlock_key_deposits_expiry
  ON unlock_key_deposits(expires_at);
