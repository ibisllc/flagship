-- Abuse reports for links and apps, notices to an account, suspensions (docs/abuse-handling.md; code in
-- apps/com/src/abuseCases.ts). Extends the voi.ci reports of migration 0124 (messages and pages) to anyone's report of
-- a voi.ci link or page, or of an app by its hostname.
--
-- No reporter address is stored (the rate limiter counts it in Durable Objects only). `contact_email` is what the
-- reporter chose to leave for an acknowledgement and is deleted with the report. Nothing here is sealed content:
-- `.com` stores what the reporter typed and what the public routing records say.
--
-- Re-runnable: CREATE ... IF NOT EXISTS only.

-- One row per report. `kind` link | app. `subject` is what was reported, normalised (a voi.ci path or a hostname).
-- Resolution at intake: `account` (the owning username), `target_kind` page | link | app | box | account, `target`
-- (the page URL, the link's stored target or the host), `service_id`, `server_domain` where known.
-- `status` open | noticed | dismissed | closed. Deleted a year after `resolved_at`.
CREATE TABLE IF NOT EXISTS abuse_reports (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('link', 'app')),
  subject       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  contact_email TEXT,
  account       TEXT,
  target_kind   TEXT,
  target        TEXT,
  service_id    TEXT,
  server_domain TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'noticed', 'dismissed', 'closed')),
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_status ON abuse_reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_account ON abuse_reports(account);

-- An operator's notice to an account: what (`subject_kind` app | page | link | box, `subject`), why (`category`), what
-- to do (`action` modify | take-down) and by when (`deadline_at`). The account's admin marks it done with a signed
-- note (flagship/abuse-notice-done/v1): `done_*`. `withdrawn_at` closes it (the account stops seeing it).
CREATE TABLE IF NOT EXISTS abuse_notices (
  id             TEXT PRIMARY KEY,
  account        TEXT NOT NULL,
  report_id      TEXT,
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('app', 'page', 'link', 'box')),
  subject        TEXT NOT NULL,
  service_id     TEXT,
  category       TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('modify', 'take-down')),
  detail         TEXT NOT NULL DEFAULT '',
  deadline_at    INTEGER NOT NULL,
  issued_at      INTEGER NOT NULL,
  done_at        INTEGER,
  done_note      TEXT,
  done_signer    TEXT,
  done_signature TEXT,
  withdrawn_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_abuse_notices_account ON abuse_notices(account, issued_at);

-- A suspended account (one row while suspended). `servers_json`: the server names this suspension revoked, so
-- un-suspending restores exactly those. `page_taken_down`: 1 when the suspension took the voi.ci page down (restore
-- puts it back only then).
CREATE TABLE IF NOT EXISTS account_suspensions (
  account         TEXT PRIMARY KEY,
  category        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  notice_id       TEXT,
  urgent          INTEGER NOT NULL DEFAULT 0,
  suspended_at    INTEGER NOT NULL,
  servers_json    TEXT NOT NULL DEFAULT '[]',
  page_taken_down INTEGER NOT NULL DEFAULT 0
);
