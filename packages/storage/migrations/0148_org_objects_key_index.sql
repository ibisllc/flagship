-- Enterprise accounts: `.com` finds which org issued a server code from the serial alone
-- (order status, install events and the appliance specializer for org servers:
-- `SELECT org_id FROM org_objects WHERE kind = 'server-code' AND object_key = ?`). The primary key
-- starts with org_id, so without this index that lookup scanned every org object.
CREATE INDEX IF NOT EXISTS idx_org_objects_kind_key ON org_objects(kind, object_key);
