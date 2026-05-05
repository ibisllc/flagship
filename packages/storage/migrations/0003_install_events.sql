CREATE TABLE IF NOT EXISTS install_events (
  serial TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (serial, seq)
);
CREATE INDEX IF NOT EXISTS idx_install_events_serial ON install_events(serial);
