-- Relay log: device-grant-revoke for every real grant id (docs/architecture-v2/relay-mesh.md §4.2).
--
-- 0122's grant triggers appended a `device-grant-revoke` only for a 64-hex grant id, but the apps choose grant ids
-- themselves and use UUIDs (the webapp's crypto.randomUUID, iOS and Android UUID()), so no real grant's revocation
-- ever reached a mesh relay: a phone whose admin grant was revoked kept the bare name (gym run 28, phone-route
-- scenario 8). The triggers now take any lowercased id of hex digits and dashes up to 64 characters
-- (`RELAY_LOG_GRANT_ID` in packages/protocol/src/relayMesh.ts, `relay_log_grant_id_ok` in flagship-crypto), and the
-- relays compare grant ids lowercased. The feed's backfill (apps/com/src/relayFeed.ts) appends the grants revoked
-- before this ran.
--
-- Re-runnable: each trigger is dropped if it exists and created again.

DROP TRIGGER IF EXISTS trg_relay_log_grant_revoked;
CREATE TRIGGER IF NOT EXISTS trg_relay_log_grant_revoked AFTER UPDATE OF revoked_at ON device_capability_grants WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND length(NEW.grant_id) BETWEEN 1 AND 64 AND lower(NEW.grant_id) NOT GLOB '*[^0-9a-f-]*' AND NEW.grant_id NOT GLOB '-*' AND length(NEW.device_pub_hex) = 64 AND lower(NEW.device_pub_hex) NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(NEW.grant_id)) BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('device-grant-revoke', COALESCE(CAST(NEW.revoked_at AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), lower(NEW.username), NULL, lower(NEW.grant_id), lower(NEW.device_pub_hex), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

DROP TRIGGER IF EXISTS trg_relay_log_grant_deleted;
CREATE TRIGGER IF NOT EXISTS trg_relay_log_grant_deleted AFTER DELETE ON device_capability_grants WHEN OLD.revoked_at IS NULL AND length(OLD.grant_id) BETWEEN 1 AND 64 AND lower(OLD.grant_id) NOT GLOB '*[^0-9a-f-]*' AND OLD.grant_id NOT GLOB '-*' AND length(OLD.device_pub_hex) = 64 AND lower(OLD.device_pub_hex) NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(OLD.grant_id)) BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES ('device-grant-revoke', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(OLD.username), NULL, lower(OLD.grant_id), lower(OLD.device_pub_hex), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

DROP TRIGGER IF EXISTS trg_relay_log_device_revoked;
CREATE TRIGGER IF NOT EXISTS trg_relay_log_device_revoked AFTER UPDATE OF revoked_at ON device_identities WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) SELECT 'device-grant-revoke', COALESCE(CAST(NEW.revoked_at AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), lower(g.username), NULL, lower(g.grant_id), lower(g.device_pub_hex), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM device_capability_grants g WHERE lower(g.username) = lower(NEW.account_id) AND lower(g.device_pub_hex) = lower(NEW.device_pub_hex) AND g.revoked_at IS NULL AND length(g.grant_id) BETWEEN 1 AND 64 AND lower(g.grant_id) NOT GLOB '*[^0-9a-f-]*' AND g.grant_id NOT GLOB '-*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(g.grant_id)) ORDER BY g.grant_id; END;

DROP TRIGGER IF EXISTS trg_relay_log_device_deleted;
CREATE TRIGGER IF NOT EXISTS trg_relay_log_device_deleted AFTER DELETE ON device_identities WHEN OLD.revoked_at IS NULL BEGIN INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) SELECT 'device-grant-revoke', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), lower(g.username), NULL, lower(g.grant_id), lower(g.device_pub_hex), '', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM device_capability_grants g WHERE lower(g.username) = lower(OLD.account_id) AND lower(g.device_pub_hex) = lower(OLD.device_pub_hex) AND g.revoked_at IS NULL AND length(g.grant_id) BETWEEN 1 AND 64 AND lower(g.grant_id) NOT GLOB '*[^0-9a-f-]*' AND g.grant_id NOT GLOB '-*' AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(g.grant_id)) ORDER BY g.grant_id; END;
