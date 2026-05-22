-- Device-identifying metadata for the "your server is being installed"
-- UI. The detail page shows IP / location / OS / size so a demo user can
-- confirm the box they're watching is theirs ("my device is at 1.2.3.4,
-- in fsn1, on debian-12, a cx22").
--
-- `region` (location) + `size` (server_type) already exist as columns
-- (migration 0027). This migration adds the two the row didn't carry:
--
--   active_server_ip  — public IPv4 the provider returned at create time
--                       (createServerWithUserData → prov.ipv4). NULL
--                       until the provider hands it back.
--   image             — the OS the box was provisioned from, e.g.
--                       `debian-12`. NULL on pre-0036 rows.
--
-- Additive + idempotent: two nullable columns, no backfill needed
-- (existing rows read NULL = "not captured yet"; the resolve block omits
-- absent fields).

ALTER TABLE demo_users ADD COLUMN active_server_ip TEXT;
ALTER TABLE demo_users ADD COLUMN image            TEXT;
