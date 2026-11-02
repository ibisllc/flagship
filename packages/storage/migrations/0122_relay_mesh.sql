-- The relay mesh on `.com` (docs/architecture-v2/relay-mesh.md §3, §4, §15.2; code in apps/com/src/relayFeed.ts,
-- relayDirectory.ts, relayBlessing.ts).
--
-- Re-runnable: every statement is guarded (CREATE ... IF NOT EXISTS, INSERT OR IGNORE). Nothing is dropped:
-- `revocation_log` and `serving_relay_acks` stay (and their triggers keep writing) while a non-mesh relay may
-- still read the internal routes (§13.3); a later migration drops them once no relay runs with the mesh off.
--
-- The relay log is written by triggers, like the revocation log, so an entry commits in the same D1 transaction
-- as the change that causes it, whichever handler made it. A trigger cannot hash or sign, so a new row leaves the
-- hashed field NULL (f1 for box-register / account-authority / cert-revoke, f4 for policy-head) and has no
-- signature; `.com` fills and signs pending rows in sequence order (relayFeed.ts signPendingRelayLog) before the
-- ServingFeed Durable Object publishes them. `account` and `src` are .com's own bookkeeping (the account an entry is
-- about; the pod name or the serving policy the signer hashes) and are never published. Every trigger only writes a
-- row the protocol can carry (a row it could not sign would stop the log for every relay).

CREATE TABLE IF NOT EXISTS relay_log (
  sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('box-register', 'box-revoke', 'account-authority', 'policy-head', 'renewal-key-revoke', 'device-grant-revoke', 'cert-revoke', 'relay-revoke')),
  at         INTEGER NOT NULL,
  account    TEXT,
  src        TEXT,
  f1         TEXT,
  f2         TEXT NOT NULL DEFAULT '',
  f3         TEXT NOT NULL DEFAULT '',
  f4         TEXT,
  signature  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_log_unsigned ON relay_log(sequence) WHERE signature IS NULL;
CREATE INDEX IF NOT EXISTS idx_relay_log_kind_f1 ON relay_log(kind, f1);
CREATE INDEX IF NOT EXISTS idx_relay_log_account ON relay_log(account, kind);
CREATE INDEX IF NOT EXISTS idx_relay_log_src ON relay_log(kind, src);

-- The relays `.com` admits (§3.1). A relay id is never reused; a relay key belongs to one relay for good.
-- `next_relay_key`: a key staged by the owner; the relay's first blessing request under it promotes it.
-- `key_deadline`: after it, a blessing is no longer renewed for `relay_key` (forced rotation, owner decision 2026-11-01).
-- `blessing_json`: the newest RelayBlessing, published in directory.json; `mesh_keys_json`: the RelayMeshKeys
-- document sealed to `relay_key` (relayFeedSeal.ts).
CREATE TABLE IF NOT EXISTS relays (
  relay_id       TEXT PRIMARY KEY,
  relay_key      TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('full', 'entry')),
  tunnel_host    TEXT NOT NULL,
  region         TEXT NOT NULL,
  ipv4_json      TEXT NOT NULL DEFAULT '[]',
  ipv6_json      TEXT NOT NULL DEFAULT '[]',
  added_at       INTEGER NOT NULL,
  retired_at     INTEGER,
  next_relay_key TEXT,
  key_deadline   INTEGER,
  blessing_json  TEXT,
  blessed_at     INTEGER,
  mesh_keys_json TEXT
);

-- Every CA-signed RelayDirectory minted (§3.3): a new version on each change, the same version re-minted daily.
CREATE TABLE IF NOT EXISTS relay_directories (
  version        INTEGER PRIMARY KEY,
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  entries_sha256 TEXT NOT NULL,
  directory_json TEXT NOT NULL
);

-- Mesh-key epochs (§4.5.1). The keys are derived from the Worker secret RELAY_MESH_KEY_SEED; a row only records
-- that an epoch exists and why. Epoch 1 exists from the start.
CREATE TABLE IF NOT EXISTS relay_mesh_epochs (
  epoch      INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  reason     TEXT NOT NULL
);
INSERT OR IGNORE INTO relay_mesh_epochs (epoch, created_at, reason) VALUES (1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 'initial');

-- Each trigger body stays on one line: the migration appliers split statements at a `;` that ends a line.

-- box-register: a new server (a key the account never had: generation 1; a reused key goes through reg_gen below).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_box_inserted AFTER INSERT ON servers WHEN NEW.revoked_at IS NULL AND length(NEW.identity_pubkey_hex) = 64 AND lower(NEW.identity_pubkey_hex) NOT GLOB '*[^0-9a-f]*' AND length(NEW.server_domain) BETWEEN 3 AND 253 AND lower(NEW.server_domain) NOT GLOB '*[^a-z0-9.-]*' AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.server_domain <> NEW.server_domain AND lower(s.username) = lower(NEW.username) AND lower(s.identity_pubkey_hex) = lower(NEW.identity_pubkey_hex)) BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('box-register', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(NEW.username), lower(NEW.server_domain), NULL, lower(NEW.identity_pubkey_hex), CAST(NEW.reg_gen AS TEXT), '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- box-register: a new registration generation (un-revoke, re-registration of a revoked server, a reused key).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_box_regen AFTER UPDATE OF reg_gen ON servers WHEN NEW.reg_gen <> OLD.reg_gen AND NEW.reg_gen >= 1 AND NEW.revoked_at IS NULL AND length(NEW.identity_pubkey_hex) = 64 AND lower(NEW.identity_pubkey_hex) NOT GLOB '*[^0-9a-f]*' AND length(NEW.server_domain) BETWEEN 3 AND 253 AND lower(NEW.server_domain) NOT GLOB '*[^a-z0-9.-]*' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('box-register', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(NEW.username), lower(NEW.server_domain), NULL, lower(NEW.identity_pubkey_hex), CAST(NEW.reg_gen AS TEXT), '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- box-register: a live server re-registered under a new key (the name's older key is evicted).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_box_rekeyed AFTER UPDATE OF identity_pubkey_hex ON servers WHEN lower(NEW.identity_pubkey_hex) <> lower(OLD.identity_pubkey_hex) AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL AND NEW.reg_gen >= 1 AND length(NEW.identity_pubkey_hex) = 64 AND lower(NEW.identity_pubkey_hex) NOT GLOB '*[^0-9a-f]*' AND length(NEW.server_domain) BETWEEN 3 AND 253 AND lower(NEW.server_domain) NOT GLOB '*[^a-z0-9.-]*' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('box-register', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(NEW.username), lower(NEW.server_domain), NULL, lower(NEW.identity_pubkey_hex), CAST(NEW.reg_gen AS TEXT), '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- box-revoke: revoked (owner revoke, self-revoke, transfer, migration hand-over, account deletion, reclaim).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_box_revoked AFTER UPDATE OF revoked_at ON servers WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.reg_gen >= 1 AND length(NEW.identity_pubkey_hex) = 64 AND lower(NEW.identity_pubkey_hex) NOT GLOB '*[^0-9a-f]*' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('box-revoke', COALESCE(CAST(NEW.revoked_at AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), lower(NEW.username), NULL, lower(NEW.identity_pubkey_hex), CAST(NEW.reg_gen AS TEXT), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- box-revoke: a live server row deleted.
CREATE TRIGGER IF NOT EXISTS trg_relay_log_box_deleted AFTER DELETE ON servers WHEN OLD.revoked_at IS NULL AND OLD.reg_gen >= 1 AND length(OLD.identity_pubkey_hex) = 64 AND lower(OLD.identity_pubkey_hex) NOT GLOB '*[^0-9a-f]*' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('box-revoke', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(OLD.username), NULL, lower(OLD.identity_pubkey_hex), CAST(OLD.reg_gen AS TEXT), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- account-authority: an account is claimed (authorityGen = 1 + the account's earlier authority entries).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_account_claimed AFTER INSERT ON usernames WHEN length(NEW.username) BETWEEN 1 AND 63 AND lower(NEW.username) NOT GLOB '*[^a-z0-9-]*' AND NEW.username NOT GLOB '-*' AND NEW.username NOT GLOB '*-' AND length(NEW.irk_pub_hex) = 64 AND lower(NEW.irk_pub_hex) NOT GLOB '*[^0-9a-f]*' AND (NEW.admin_root_pub_hex IS NULL OR (length(NEW.admin_root_pub_hex) = 64 AND lower(NEW.admin_root_pub_hex) NOT GLOB '*[^0-9a-f]*')) BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('account-authority', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(NEW.username), NULL, NULL, COALESCE(lower(NEW.admin_root_pub_hex), ''), lower(NEW.irk_pub_hex), CAST(1 + (SELECT COUNT(*) FROM relay_log r WHERE r.kind = 'account-authority' AND r.account = lower(NEW.username)) AS TEXT), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- account-authority: the admin root or the IRK changes (pinning, rotation, re-pair).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_account_keys AFTER UPDATE OF irk_pub_hex, admin_root_pub_hex ON usernames WHEN (lower(NEW.irk_pub_hex) IS NOT lower(OLD.irk_pub_hex) OR lower(NEW.admin_root_pub_hex) IS NOT lower(OLD.admin_root_pub_hex)) AND length(NEW.username) BETWEEN 1 AND 63 AND lower(NEW.username) NOT GLOB '*[^a-z0-9-]*' AND NEW.username NOT GLOB '-*' AND NEW.username NOT GLOB '*-' AND length(NEW.irk_pub_hex) = 64 AND lower(NEW.irk_pub_hex) NOT GLOB '*[^0-9a-f]*' AND (NEW.admin_root_pub_hex IS NULL OR (length(NEW.admin_root_pub_hex) = 64 AND lower(NEW.admin_root_pub_hex) NOT GLOB '*[^0-9a-f]*')) BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('account-authority', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(NEW.username), NULL, NULL, COALESCE(lower(NEW.admin_root_pub_hex), ''), lower(NEW.irk_pub_hex), CAST(1 + (SELECT COUNT(*) FROM relay_log r WHERE r.kind = 'account-authority' AND r.account = lower(NEW.username)) AS TEXT), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- policy-head: a serving policy is stored (its canonical-bytes hash is filled in by the signer from `src`).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_policy_inserted AFTER INSERT ON serving_policies WHEN NEW.reg_gen >= 1 AND NEW.policy_gen >= 1 AND length(NEW.box_pub) = 64 AND NEW.box_pub NOT GLOB '*[^0-9a-f]*' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('policy-head', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), NEW.username, NEW.record_json, NEW.box_pub, CAST(NEW.reg_gen AS TEXT), CAST(NEW.policy_gen AS TEXT), NULL, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

CREATE TRIGGER IF NOT EXISTS trg_relay_log_policy_updated AFTER UPDATE ON serving_policies WHEN (NEW.reg_gen <> OLD.reg_gen OR NEW.policy_gen <> OLD.policy_gen OR NEW.record_json <> OLD.record_json) AND NEW.reg_gen >= 1 AND NEW.policy_gen >= 1 AND length(NEW.box_pub) = 64 AND NEW.box_pub NOT GLOB '*[^0-9a-f]*' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('policy-head', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), NEW.username, NEW.record_json, NEW.box_pub, CAST(NEW.reg_gen AS TEXT), CAST(NEW.policy_gen AS TEXT), NULL, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- renewal-key-revoke: a renewal delegation is revoked (its device was removed; set by the 0120 triggers).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_renewal_revoked AFTER UPDATE OF revoked_at ON renewal_delegations WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND length(NEW.renewal_pub) = 66 AND substr(NEW.renewal_pub, 1, 2) IN ('02', '03') AND NEW.renewal_pub NOT GLOB '*[^0-9a-f]*' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('renewal-key-revoke', COALESCE(CAST(NEW.revoked_at AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), NEW.username, NULL, NEW.renewal_pub, '', '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- device-grant-revoke: a device capability grant is revoked or deleted, or its device is removed.
CREATE TRIGGER IF NOT EXISTS trg_relay_log_grant_revoked AFTER UPDATE OF revoked_at ON device_capability_grants WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND length(NEW.grant_id) = 64 AND lower(NEW.grant_id) NOT GLOB '*[^0-9a-f]*' AND length(NEW.device_pub_hex) = 64 AND lower(NEW.device_pub_hex) NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(NEW.grant_id)) BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('device-grant-revoke', COALESCE(CAST(NEW.revoked_at AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), lower(NEW.username), NULL, lower(NEW.grant_id), lower(NEW.device_pub_hex), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

CREATE TRIGGER IF NOT EXISTS trg_relay_log_grant_deleted AFTER DELETE ON device_capability_grants WHEN OLD.revoked_at IS NULL AND length(OLD.grant_id) = 64 AND lower(OLD.grant_id) NOT GLOB '*[^0-9a-f]*' AND length(OLD.device_pub_hex) = 64 AND lower(OLD.device_pub_hex) NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(OLD.grant_id)) BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('device-grant-revoke', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(OLD.username), NULL, lower(OLD.grant_id), lower(OLD.device_pub_hex), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

CREATE TRIGGER IF NOT EXISTS trg_relay_log_device_revoked AFTER UPDATE OF revoked_at ON device_identities WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) SELECT 'device-grant-revoke', COALESCE(CAST(NEW.revoked_at AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), lower(g.username), NULL, lower(g.grant_id), lower(g.device_pub_hex), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM device_capability_grants g WHERE lower(g.username) = lower(NEW.account_id) AND lower(g.device_pub_hex) = lower(NEW.device_pub_hex) AND g.revoked_at IS NULL AND length(g.grant_id) = 64 AND lower(g.grant_id) NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(g.grant_id)) ORDER BY g.grant_id; END;

CREATE TRIGGER IF NOT EXISTS trg_relay_log_device_deleted AFTER DELETE ON device_identities WHEN OLD.revoked_at IS NULL BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) SELECT 'device-grant-revoke', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(g.username), NULL, lower(g.grant_id), lower(g.device_pub_hex), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM device_capability_grants g WHERE lower(g.username) = lower(OLD.account_id) AND lower(g.device_pub_hex) = lower(OLD.device_pub_hex) AND g.revoked_at IS NULL AND length(g.grant_id) = 64 AND lower(g.grant_id) NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(g.grant_id)) ORDER BY g.grant_id; END;

-- cert-revoke: each cert id new to an account's entitlement revocation list (a list never un-revokes in the log).
CREATE TRIGGER IF NOT EXISTS trg_relay_log_certs_inserted AFTER INSERT ON entitlement_revocation_lists WHEN json_valid(NEW.cert_ids_json) AND length(NEW.username) BETWEEN 1 AND 63 AND lower(NEW.username) NOT GLOB '*[^a-z0-9-]*' AND NEW.username NOT GLOB '-*' AND NEW.username NOT GLOB '*-' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) SELECT 'cert-revoke', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(NEW.username), NULL, NULL, lower(j.value), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM (SELECT DISTINCT value FROM json_each(NEW.cert_ids_json) WHERE type = 'text') j WHERE length(j.value) = 64 AND lower(j.value) NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'cert-revoke' AND r.account = lower(NEW.username) AND r.f2 = lower(j.value)) ORDER BY j.value; END;

CREATE TRIGGER IF NOT EXISTS trg_relay_log_certs_updated AFTER UPDATE OF cert_ids_json ON entitlement_revocation_lists WHEN json_valid(NEW.cert_ids_json) AND length(NEW.username) BETWEEN 1 AND 63 AND lower(NEW.username) NOT GLOB '*[^a-z0-9-]*' AND NEW.username NOT GLOB '-*' AND NEW.username NOT GLOB '*-' BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) SELECT 'cert-revoke', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(NEW.username), NULL, NULL, lower(j.value), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM (SELECT DISTINCT value FROM json_each(NEW.cert_ids_json) WHERE type = 'text') j WHERE length(j.value) = 64 AND lower(j.value) NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'cert-revoke' AND r.account = lower(NEW.username) AND r.f2 = lower(j.value)) ORDER BY j.value; END;

-- relay-revoke: the owner retires a relay.
CREATE TRIGGER IF NOT EXISTS trg_relay_log_relay_retired AFTER UPDATE OF retired_at ON relays WHEN OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('relay-revoke', CAST(NEW.retired_at AS INTEGER), NULL, NULL, NEW.relay_id, NEW.relay_key, '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;
