-- Account master-key rotation (docs/account-key-rotation.md).
--
-- 1. `account_key_rotations`: the account's lane of signed hops (epoch N -> N+1), each authorised by the
--    pinned admin root, served to the account's boxes and devices. `cas_ok` is computed by the apply batch
--    from the state the swap left behind (new key in place, recovery record and kept devices as signed);
--    the CHECK turns a lost race into a failed batch, so nothing in it is applied.
-- 2. `umk_rotation_deliveries`: the new account key sealed to each kept device, until it acknowledges.
-- 3. `device_receive_keys`: a device's X-Wing receive key, signed by its own identity key.
-- 4. `usernames.key_epoch`: the account's key epoch (0 until the first rotation).
-- 5. `device_identities.key_origin`: how a device key was made, when known (`random` after a key rotate).
--
-- The CREATEs re-run cleanly; the two ALTERs at the end are apply-once (README "Non-idempotent").
-- Apply before the `.com` deploy that reads them.
CREATE TABLE IF NOT EXISTS account_key_rotations (
  username             TEXT NOT NULL,
  to_epoch             INTEGER NOT NULL CHECK (to_epoch > 0),
  from_epoch           INTEGER NOT NULL CHECK (from_epoch >= 0),
  rotation_digest_hex  TEXT NOT NULL CHECK (length(rotation_digest_hex) = 64),
  admin_root_pub_hex   TEXT NOT NULL CHECK (length(admin_root_pub_hex) = 64),
  old_irk_pub_hex      TEXT NOT NULL,
  new_irk_pub_hex      TEXT NOT NULL,
  hop_json             TEXT NOT NULL,
  kept_json            TEXT NOT NULL,
  apply_id             TEXT NOT NULL,
  applied_at           INTEGER NOT NULL,
  cas_ok               INTEGER NOT NULL CHECK (cas_ok = 1),
  PRIMARY KEY (username, to_epoch),
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_key_rotations_digest
  ON account_key_rotations(rotation_digest_hex);

CREATE TABLE IF NOT EXISTS umk_rotation_deliveries (
  username        TEXT NOT NULL,
  to_epoch        INTEGER NOT NULL,
  device_id       TEXT NOT NULL,
  device_pub_hex  TEXT NOT NULL,
  seal_kind       TEXT NOT NULL CHECK (seal_kind IN ('xwing', 'ed25519')),
  sealed_hex      TEXT NOT NULL,
  delivery_json   TEXT NOT NULL,
  signature_hex   TEXT NOT NULL CHECK (length(signature_hex) = 128),
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  acked_at        INTEGER,
  PRIMARY KEY (username, to_epoch, device_id),
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_umk_rotation_deliveries_device
  ON umk_rotation_deliveries(username, device_id, acked_at);

CREATE TABLE IF NOT EXISTS device_receive_keys (
  account_id      TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  device_pub_hex  TEXT NOT NULL,
  xwing_pub_hex   TEXT NOT NULL,
  issued_at       INTEGER NOT NULL,
  signature_hex   TEXT NOT NULL CHECK (length(signature_hex) = 128),
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id),
  FOREIGN KEY (account_id, device_id) REFERENCES device_identities(account_id, device_id) ON DELETE CASCADE
);

ALTER TABLE usernames ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_identities ADD COLUMN key_origin TEXT;
