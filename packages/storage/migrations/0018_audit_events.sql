-- Audit log of account-level events the user might want to see in the
-- Activity feed: device disconnects, IRK rotations (Replace device),
-- UMK rotations (Wipe & restart, in v1.1), recovery passkey
-- registrations, recovery-passkey rotations.
--
-- Each row is per-user, append-only, keyed by an auto-increment seq
-- so clients can poll incrementally with `?since=<seq>`. The
-- `event_kind` strings live in a controlled vocabulary, defined in
-- packages/control-plane/src/auditEvents.ts.
--
-- `detail` is a free-form short string surfaced verbatim in the UI
-- ("Disconnected iPhone (kitchen)"). The handler bounds length on
-- ingest so the table can't grow unbounded from a chatty caller.
--
-- We keep these events for 90 days; a periodic vacuum trims older
-- rows. The Activity feed only renders the last ~50 per user.

CREATE TABLE IF NOT EXISTS audit_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL,
  event_kind     TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '',
  -- Optional reference to the device the event involved (push-token
  -- prefix for legibility — same scheme as the /devices listing).
  -- Empty when the event isn't device-scoped.
  device_prefix  TEXT NOT NULL DEFAULT '',
  posted_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_seq
  ON audit_events(username, seq);
CREATE INDEX IF NOT EXISTS idx_audit_events_posted_at
  ON audit_events(posted_at);
