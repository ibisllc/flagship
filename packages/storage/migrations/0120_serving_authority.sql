-- The serving authority (the owner's dead-man switch): docs/architecture-v2/serving-wiring.md §1,
-- records in docs/architecture-v2/issuance-and-lease-records.md, code in apps/com/src/servingAuthority.ts.
--
-- APPLY-ONCE: the first statement is a bare ALTER TABLE ADD COLUMN, so a re-run aborts with
-- "duplicate column name: reg_gen" (the file was already applied; see README.md). Everything after it
-- is guarded and re-runnable.
--
-- The revocation log is written by triggers, so an entry commits in the same transaction as the change
-- that causes it, whichever handler made it (revoke, self-revoke, transfer, account deletion, reclaim,
-- device removal). A trigger cannot sign, so a new row has no signature; `.com` signs pending rows in
-- sequence order (Ed25519 is deterministic, so two signers write the same bytes) before any relay
-- reads them, and the ServingFeed Durable Object pushes them.
ALTER TABLE servers ADD COLUMN reg_gen INTEGER NOT NULL DEFAULT 1;

-- The newest owner-signed serving-policy/v1 per box (a higher regGen, or a higher policyGen, replaces it).
CREATE TABLE IF NOT EXISTS serving_policies (
  username TEXT NOT NULL,
  box_pub TEXT NOT NULL,
  reg_gen INTEGER NOT NULL,
  policy_gen INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, box_pub)
);

-- One admin-signed renewal-key-delegation/v1 per renewal key; revoked when its device is removed,
-- and never revived.
CREATE TABLE IF NOT EXISTS renewal_delegations (
  renewal_pub TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  device_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_renewal_delegations_user ON renewal_delegations(username, device_id);

-- The best serving-lease/v1 per box and signer (the admin key or one renewal key).
CREATE TABLE IF NOT EXISTS serving_leases (
  username TEXT NOT NULL,
  box_pub TEXT NOT NULL,
  signer_pub TEXT NOT NULL,
  reg_gen INTEGER NOT NULL,
  policy_gen INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  delegation_pub TEXT,
  not_after INTEGER NOT NULL,
  PRIMARY KEY (username, box_pub, signer_pub)
);

-- The signed revocation log (revocation-entry/v1). `sequence` never repeats (AUTOINCREMENT).
CREATE TABLE IF NOT EXISTS revocation_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('box', 'renewal-key')),
  account TEXT NOT NULL,
  subject TEXT NOT NULL,
  generation INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL,
  entry_json TEXT,
  signature TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revocation_log_unsigned ON revocation_log(sequence) WHERE signature IS NULL;

-- The last sequence each relay acknowledged ("confirmed by every relay").
CREATE TABLE IF NOT EXISTS serving_relay_acks (
  relay_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);

-- Each trigger body stays on one line: the migration appliers split statements at a `;` that ends a line.
-- An entry is only written for an account name and box key a revocation-entry/v1 can carry: one it
-- could not sign would leave a gap no relay gets past.
CREATE TRIGGER IF NOT EXISTS trg_serving_box_revoked AFTER UPDATE OF revoked_at ON servers WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND length(NEW.identity_pubkey_hex) = 64 AND lower(NEW.identity_pubkey_hex) NOT GLOB '*[^0-9a-f]*' AND length(NEW.username) BETWEEN 1 AND 63 AND lower(NEW.username) NOT GLOB '*[^a-z0-9-]*' AND NEW.username NOT GLOB '-*' AND NEW.username NOT GLOB '*-' BEGIN INSERT INTO revocation_log (kind, account, subject, generation, revoked_at, created_at) VALUES ('box', lower(NEW.username), lower(NEW.identity_pubkey_hex), NEW.reg_gen, CAST(NEW.revoked_at AS INTEGER), CAST(NEW.revoked_at AS INTEGER)); END;

-- Un-revoking (or re-registering a revoked server) starts a new registration generation.
CREATE TRIGGER IF NOT EXISTS trg_serving_box_unrevoked AFTER UPDATE OF revoked_at ON servers WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL BEGIN UPDATE servers SET reg_gen = OLD.reg_gen + 1 WHERE server_domain = NEW.server_domain; END;

-- A new row for a box key the account had before continues past that key's generations.
CREATE TRIGGER IF NOT EXISTS trg_serving_box_inserted AFTER INSERT ON servers WHEN EXISTS (SELECT 1 FROM servers s WHERE s.server_domain <> NEW.server_domain AND lower(s.username) = lower(NEW.username) AND lower(s.identity_pubkey_hex) = lower(NEW.identity_pubkey_hex)) BEGIN UPDATE servers SET reg_gen = 1 + (SELECT MAX(s.reg_gen) FROM servers s WHERE s.server_domain <> NEW.server_domain AND lower(s.username) = lower(NEW.username) AND lower(s.identity_pubkey_hex) = lower(NEW.identity_pubkey_hex)) WHERE server_domain = NEW.server_domain; END;

-- Removing a device revokes its renewal keys: one entry per delegation.
CREATE TRIGGER IF NOT EXISTS trg_serving_device_revoked AFTER UPDATE OF revoked_at ON device_identities WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN INSERT INTO revocation_log (kind, account, subject, generation, revoked_at, created_at) SELECT 'renewal-key', username, renewal_pub, 0, CAST(NEW.revoked_at AS INTEGER), CAST(NEW.revoked_at AS INTEGER) FROM renewal_delegations WHERE username = lower(NEW.account_id) AND device_id = lower(NEW.device_pub_hex) AND revoked_at IS NULL ORDER BY renewal_pub; UPDATE renewal_delegations SET revoked_at = NEW.revoked_at WHERE username = lower(NEW.account_id) AND device_id = lower(NEW.device_pub_hex) AND revoked_at IS NULL; END;

CREATE TRIGGER IF NOT EXISTS trg_serving_device_deleted AFTER DELETE ON device_identities BEGIN INSERT INTO revocation_log (kind, account, subject, generation, revoked_at, created_at) SELECT 'renewal-key', username, renewal_pub, 0, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM renewal_delegations WHERE username = lower(OLD.account_id) AND device_id = lower(OLD.device_pub_hex) AND revoked_at IS NULL ORDER BY renewal_pub; UPDATE renewal_delegations SET revoked_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE username = lower(OLD.account_id) AND device_id = lower(OLD.device_pub_hex) AND revoked_at IS NULL; END;

-- A revoked device grant counts as removal only when the device has no active grant left (a relabel
-- tombstones the old grant and issues a new one).
CREATE TRIGGER IF NOT EXISTS trg_serving_grant_revoked AFTER UPDATE OF revoked_at ON device_capability_grants WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM device_capability_grants g WHERE lower(g.username) = lower(NEW.username) AND lower(g.device_pub_hex) = lower(NEW.device_pub_hex) AND g.revoked_at IS NULL) BEGIN INSERT INTO revocation_log (kind, account, subject, generation, revoked_at, created_at) SELECT 'renewal-key', username, renewal_pub, 0, CAST(NEW.revoked_at AS INTEGER), CAST(NEW.revoked_at AS INTEGER) FROM renewal_delegations WHERE username = lower(NEW.username) AND device_id = lower(NEW.device_pub_hex) AND revoked_at IS NULL ORDER BY renewal_pub; UPDATE renewal_delegations SET revoked_at = NEW.revoked_at WHERE username = lower(NEW.username) AND device_id = lower(NEW.device_pub_hex) AND revoked_at IS NULL; END;
