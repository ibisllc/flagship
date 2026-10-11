-- Latest box-signed health report per server (memory, OOM kills, daemon
-- restarts, tunnel, disk). Written by a timer on the box that runs even when
-- the daemon is down, so an owner can see why a box went quiet. One row per
-- server; replaced on every report.
CREATE TABLE server_health (
  server_domain TEXT PRIMARY KEY,
  report_json   TEXT NOT NULL,
  reported_at   INTEGER NOT NULL,
  received_at   INTEGER NOT NULL
);
