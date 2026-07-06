-- 0061: random username suggestion queue + escalating per-device regenerate
-- throttle (docs/username-suggestion-queue.md).
--
-- The queue holds pre-validated available names (grammar + not-claimed + not a
-- .com property); a suggestion POPS the oldest (delete-and-return), so a refused
-- name is lost. The throttle carries the increasing per-device cooldown.

CREATE TABLE IF NOT EXISTS username_suggestion_queue (
  name TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username_suggestion_queue_order
  ON username_suggestion_queue (enqueued_at, name);

CREATE TABLE IF NOT EXISTS username_suggest_throttle (
  device_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  next_allowed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username_suggest_throttle_last
  ON username_suggest_throttle (last_at);
