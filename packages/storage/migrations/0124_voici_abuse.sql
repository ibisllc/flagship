-- voi.ci pages + Messages, chunk B2: attestation counters, device enrollments, reports, bans, takedowns
-- (docs/voici-and-messages.md §6.3, §9; code in apps/com/src/messagesAttestation.ts, voiciAbuse.ts,
-- deviceIntegrity.ts).
--
-- What is NOT here, on purpose (§6.3, §8.4): no table holds a pseudonym key next to an account. A Messages key
-- attestation leaves one trace, the per-account per-day count in `messages_attest_counters`. The only rows that
-- name a pseudonym are `voici_banned_pseudonyms` (a pseudonym from a confirmed report) and the reported envelope in
-- `voici_reports`; neither names the sender's account until the owner opens the abuse tag offline and bans.
--
-- Re-runnable: CREATE ... IF NOT EXISTS only.

-- New recipients (non-renewal attestations) per account per UTC day (§9.4). Rows older than two days are pruned.
CREATE TABLE IF NOT EXISTS messages_attest_counters (
  username TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (username, day)
);

-- One row per account that enrolled in Messages (its first attestation), §9.5. `platform` ios | android | none.
-- `attest_key_hmac`: HMAC(VOICI_DEVICE_SECRET, App Attest keyId), iOS only. `device_token`: the newest DeviceCheck
-- token or Play Integrity token, kept 30 days (`device_token_at`) so a ban can set the device's bit; then cleared.
CREATE TABLE IF NOT EXISTS messages_enrollments (
  username TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'none')),
  enrolled_at INTEGER NOT NULL,
  attest_key_hmac TEXT,
  device_token TEXT,
  device_token_at INTEGER,
  ban_marked_at INTEGER
);

-- App Attest keys .com verified (§9.5): attested once per install, then each assertion moves `counter` up.
-- Keyed by the keyed hash of the key id; names no account.
CREATE TABLE IF NOT EXISTS messages_app_attest_keys (
  key_hmac TEXT PRIMARY KEY,
  public_key_hex TEXT NOT NULL,
  counter INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Reports (§9.2). kind message: the owner's signed report of one envelope (its attestation carries the abuse
-- tag); kind page: anyone's report of a page. The reporter's address is never stored.
CREATE TABLE IF NOT EXISTS voici_reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'page')),
  username TEXT NOT NULL,
  page_id TEXT,
  page_seq INTEGER,
  msg_id TEXT,
  pseudonym_pub TEXT,
  reason TEXT NOT NULL,
  note TEXT,
  envelope_json TEXT,
  attached_b64 TEXT,
  signed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'banned', 'dismissed', 'taken-down')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voici_reports_message ON voici_reports(page_id, msg_id) WHERE kind = 'message';
CREATE INDEX IF NOT EXISTS idx_voici_reports_status ON voici_reports(status, created_at);

-- Accounts banned from Messages and pages (§9.3): no new attestations or renewals.
CREATE TABLE IF NOT EXISTS voici_bans (
  username TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  report_id TEXT,
  banned_at INTEGER NOT NULL
);

-- Pseudonyms refused at once on send (§9.3), from the report that led to a ban.
CREATE TABLE IF NOT EXISTS voici_banned_pseudonyms (
  pseudonym_pub TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  banned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voici_banned_pseudonyms_report ON voici_banned_pseudonyms(report_id);

-- Pages taken down (§9.6). `page_id` and `purge_pending` let a takedown finish its R2 deletes and cache purges over
-- several calls.
CREATE TABLE IF NOT EXISTS voici_takedowns (
  username TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  page_id TEXT,
  purge_pending INTEGER NOT NULL DEFAULT 1,
  taken_down_at INTEGER NOT NULL
);
