-- voi.ci reply alerts (docs/voici-and-messages.md §8.3 "Alerts:"; code in packages/storage/src/voici.ts,
-- packages/control-plane/src/voiciAlerts.ts, apps/com/src/voiciRoutes.ts). Opt-in: a visitor who has sent a message
-- taps "Get an alert when they reply" and their browser's Web Push subscription is stored here, bound to that one
-- conversation only. When the owner's reply is stored, `.com` sends a content-free push (at most one per conversation
-- an hour).
--
-- Re-runnable: every statement is CREATE ... IF NOT EXISTS.
--
-- Nothing here names an account: the row holds the conversation, its page, the push endpoint with its keys and the
-- browser key that signed it on (so signing that key out removes it). Rows go when the visitor turns alerts off, the
-- push service answers 404/410, the delegation that authorised them expires, the conversation's mail is collected,
-- the page is taken down or the account is deleted.
CREATE TABLE IF NOT EXISTS voici_alerts (
  conv           TEXT NOT NULL,
  endpoint_hash  TEXT NOT NULL,
  page_id        TEXT NOT NULL,
  subscription   TEXT NOT NULL,
  delegate_pub   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  last_pushed_at INTEGER,
  PRIMARY KEY (conv, endpoint_hash)
);
CREATE INDEX IF NOT EXISTS idx_voici_alerts_page ON voici_alerts(page_id);
CREATE INDEX IF NOT EXISTS idx_voici_alerts_delegate ON voici_alerts(delegate_pub);
CREATE INDEX IF NOT EXISTS idx_voici_alerts_expires ON voici_alerts(expires_at);
