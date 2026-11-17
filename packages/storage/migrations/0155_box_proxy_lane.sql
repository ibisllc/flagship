-- The outbound proxy's fallback lane (docs/outbound-proxy.md "Failure handling"):
-- per server, the newest owner-signed proxy order an app left for a box it
-- couldn't reach, and the box's own report that its proxy is failing (shown
-- on /pods, pushed once). No credentials, no address. Re-runnable.
CREATE TABLE IF NOT EXISTS box_proxy_lane (
  server_domain TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  order_json TEXT,
  signature_hex TEXT,
  issued_at INTEGER,
  alert_state TEXT CHECK (alert_state IS NULL OR alert_state IN ('failing', 'fallback')),
  alert_code TEXT,
  alert_since INTEGER,
  alert_at INTEGER
);
CREATE INDEX IF NOT EXISTS box_proxy_lane_user ON box_proxy_lane (username);
