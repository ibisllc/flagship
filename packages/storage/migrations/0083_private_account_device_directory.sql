-- Clean-cutover account/device naming model. This migration intentionally
-- destroys the pre-launch demo/device rows; apply only after removing the
-- deployed reviewer demo and immediately reseed it through the new provisioner.

DROP TABLE IF EXISTS push_tokens;
DROP TABLE IF EXISTS device_capability_grants;
DROP TABLE IF EXISTS demo_users;

CREATE TABLE device_identities (
  account_id      TEXT NOT NULL,
  device_id       TEXT NOT NULL CHECK (length(device_id) = 32 AND device_id = lower(device_id)),
  device_pub_hex  TEXT NOT NULL CHECK (length(device_pub_hex) = 64 AND device_pub_hex = lower(device_pub_hex)),
  platform_class  TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  revoked_at      INTEGER,
  PRIMARY KEY (account_id, device_id),
  UNIQUE (account_id, device_pub_hex),
  FOREIGN KEY (account_id) REFERENCES usernames(username) ON DELETE CASCADE
);
CREATE INDEX idx_device_identities_account_active
  ON device_identities(account_id, revoked_at, created_at);

CREATE TABLE device_capability_grants (
  grant_id        TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  device_pub_hex  TEXT NOT NULL,
  scopes_json     TEXT NOT NULL,
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  signature_hex   TEXT NOT NULL,
  revoked_at      INTEGER,
  signer_root     TEXT NOT NULL CHECK (signer_root IN ('membership', 'admin-root')),
  FOREIGN KEY (username, device_id) REFERENCES device_identities(account_id, device_id) ON DELETE CASCADE
);
CREATE INDEX idx_dcg_username ON device_capability_grants(username);
CREATE INDEX idx_dcg_device_pub ON device_capability_grants(device_pub_hex);
CREATE INDEX idx_dcg_expires_at ON device_capability_grants(expires_at);
CREATE UNIQUE INDEX idx_dcg_username_device_active
  ON device_capability_grants(username, device_id)
  WHERE revoked_at IS NULL;

CREATE TABLE account_profiles (
  account_id       TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL CHECK (revision > 0),
  key_version      INTEGER NOT NULL CHECK (key_version > 0),
  nonce_hex        TEXT NOT NULL CHECK (length(nonce_hex) = 24),
  ciphertext_hex   TEXT NOT NULL,
  signer_pub_hex   TEXT NOT NULL CHECK (length(signer_pub_hex) = 64),
  signature_hex    TEXT NOT NULL CHECK (length(signature_hex) = 128),
  issued_at        INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES usernames(username) ON DELETE CASCADE
);

CREATE TABLE device_self_profiles (
  account_id       TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision > 0),
  key_version      INTEGER NOT NULL CHECK (key_version > 0),
  nonce_hex        TEXT NOT NULL CHECK (length(nonce_hex) = 24),
  ciphertext_hex   TEXT NOT NULL,
  signer_pub_hex   TEXT NOT NULL CHECK (length(signer_pub_hex) = 64),
  signature_hex    TEXT NOT NULL CHECK (length(signature_hex) = 128),
  issued_at        INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id),
  FOREIGN KEY (account_id, device_id) REFERENCES device_identities(account_id, device_id) ON DELETE CASCADE
);

CREATE TABLE device_managed_profiles (
  account_id       TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision > 0),
  key_version      INTEGER NOT NULL CHECK (key_version > 0),
  nonce_hex        TEXT NOT NULL CHECK (length(nonce_hex) = 24),
  ciphertext_hex   TEXT NOT NULL,
  locked           INTEGER NOT NULL CHECK (locked IN (0, 1)),
  signer_pub_hex   TEXT NOT NULL CHECK (length(signer_pub_hex) = 64),
  signature_hex    TEXT NOT NULL CHECK (length(signature_hex) = 128),
  issued_at        INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id),
  FOREIGN KEY (account_id, device_id) REFERENCES device_identities(account_id, device_id) ON DELETE CASCADE
);

CREATE TABLE account_directory_key_grants (
  grant_id             TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL,
  recipient_device_id  TEXT NOT NULL,
  key_kind             TEXT NOT NULL CHECK (key_kind IN ('account-profile', 'device-directory')),
  sealed_key_hex       TEXT NOT NULL,
  signer_pub_hex       TEXT NOT NULL CHECK (length(signer_pub_hex) = 64),
  signature_hex        TEXT NOT NULL CHECK (length(signature_hex) = 128),
  issued_at            INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  revoked_at           INTEGER,
  FOREIGN KEY (account_id, recipient_device_id) REFERENCES device_identities(account_id, device_id) ON DELETE CASCADE
);
CREATE INDEX idx_account_directory_key_grants_recipient
  ON account_directory_key_grants(account_id, recipient_device_id, revoked_at, expires_at);

CREATE TABLE push_tokens (
  token_id                         TEXT PRIMARY KEY,
  username                         TEXT NOT NULL,
  device_id                        TEXT NOT NULL,
  platform                         TEXT NOT NULL CHECK (platform IN ('apns', 'fcm', 'webpush')),
  provider_token                   TEXT NOT NULL,
  push_x25519_pub_hex              TEXT NOT NULL,
  registration_signature_hex       TEXT NOT NULL,
  registered_at                    INTEGER NOT NULL,
  last_seen_at                     INTEGER NOT NULL,
  quarantine_until                 INTEGER NOT NULL DEFAULT 0,
  quarantine_alerts_fired_bitmap   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (username, device_id) REFERENCES device_identities(account_id, device_id) ON DELETE CASCADE
);
CREATE INDEX idx_push_tokens_user ON push_tokens(username);
CREATE INDEX idx_push_tokens_device ON push_tokens(username, device_id);
CREATE INDEX idx_push_tokens_quarantine ON push_tokens(quarantine_until);

CREATE TABLE demo_users (
  username              TEXT PRIMARY KEY,
  idempotency_key       TEXT NOT NULL UNIQUE,
  snapshot_id           TEXT,
  iso_r2_key            TEXT,
  ttl_idle_minutes      INTEGER NOT NULL DEFAULT 30,
  region                TEXT NOT NULL DEFAULT 'fsn1',
  size                  TEXT NOT NULL DEFAULT 'cx22',
  active_server_id      TEXT,
  active_server_ip      TEXT,
  image                 TEXT,
  active_server_fqdn    TEXT,
  last_activity_at      INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  provision_phase       TEXT,
  provision_phase_at    INTEGER,
  provision_last_error  TEXT,
  CHECK (state IN ('initializing', 'provisioning', 'ready', 'failed', 'cleanup-only', 'idle-pending-teardown')),
  FOREIGN KEY (username) REFERENCES usernames(username) ON DELETE CASCADE
);
CREATE INDEX idx_demo_users_state ON demo_users(state);
CREATE INDEX idx_demo_users_last_activity ON demo_users(last_activity_at);
