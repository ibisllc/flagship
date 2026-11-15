-- voi.ci calls on `.com` (docs/voici-calls.md §6; storage packages/storage/src/voiciCalls.ts, handlers
-- packages/control-plane/src/voiciCalls.ts, the call room apps/com/src/voiciCallRoom.ts). `.com` arranges a call and
-- never carries it: nothing here holds audio, keys or a call log. An answered call leaves no row once it ends.
--
-- Re-runnable: every statement is CREATE ... IF NOT EXISTS.

-- Rings per page per UTC day, for the page's daily limit only (no caller, no time of day).
CREATE TABLE IF NOT EXISTS voici_call_counts (
  page_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  rings   INTEGER NOT NULL,
  PRIMARY KEY (page_id, day)
);

-- One live call per account: the row lives while a call rings or runs and is removed when its room closes
-- (expires_at bounds a room that died without closing).
CREATE TABLE IF NOT EXISTS voici_live_calls (
  username   TEXT PRIMARY KEY,
  call_id    TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- iOS PushKit tokens (a VoIP push needs its own token and topic). Android rings through its existing FCM or
-- UnifiedPush token. Registered by the device's signed request; only admin devices are rung.
CREATE TABLE IF NOT EXISTS voici_voip_tokens (
  username      TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  device_pub    TEXT NOT NULL,
  token         TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (username, device_id)
);

-- The owner's signed flagship/voici-call-allow/v1 orders: with "Who can call: accepted conversations" a
-- conversation may call once the owner replied, accepted it, or allowed it here. Newest issuedAt wins.
CREATE TABLE IF NOT EXISTS voici_call_allows (
  page_id    TEXT NOT NULL,
  conv       TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('allow', 'disallow')),
  issued_at  INTEGER NOT NULL,
  signature  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, conv)
);

-- Missed calls, sealed to the page's inbox key (flagship/voici-missed-call/v1, which carries the caller's signed
-- request so Block and Report work on it). Kept 180 days, as the mailbox.
CREATE TABLE IF NOT EXISTS voici_missed_calls (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id   TEXT NOT NULL,
  conv      TEXT NOT NULL,
  call_id   TEXT NOT NULL UNIQUE,
  sealed    TEXT NOT NULL,
  stored_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voici_missed_calls_page ON voici_missed_calls(page_id, id);
CREATE INDEX IF NOT EXISTS idx_voici_missed_calls_stored ON voici_missed_calls(stored_at);
