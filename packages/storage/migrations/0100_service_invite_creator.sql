-- Who may invite (owner decision 2026-10-15, docs/service-access-gating.md
-- "Who can invite"): any device of an account may invite someone to an app at
-- Member; only an admin device grants a higher rank. `.com` records which tier
-- signed each create so the members list can say who invited whom and so a
-- device can withdraw an invite it made.
--
--   creator_tier       'admin' | 'member'; NULL on rows from before this file.
--   creator_pub_hex    the key the create verified under (the only non-admin
--                      key that may revoke the invite).
--   creator_device_id  the account device id the creating device named
--                      (attribution only; device names stay sealed in the
--                      account directory).
--
-- Apply-once (bare ADD COLUMN): see README.md.
ALTER TABLE service_invites ADD COLUMN creator_tier TEXT;
ALTER TABLE service_invites ADD COLUMN creator_pub_hex TEXT;
ALTER TABLE service_invites ADD COLUMN creator_device_id TEXT;
