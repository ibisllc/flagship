-- Who may call a page, and ringing a caller back (docs/voici-calls.md, owner-approved 2026-11-15). Storage
-- packages/storage/src/voiciCalls.ts, handlers packages/control-plane/src/voiciCallModes.ts.
--
-- Re-runnable: every statement is CREATE ... IF NOT EXISTS.

-- A caller's ring-back channel for one conversation (flagship/voici-ring-back/v1). `username` is the caller's
-- account when their app attached it (its devices get the ring push), NULL when only a browser did (the open voi.ci
-- tab and the apps see the ring in their thread fetch). Policy, said plainly to the caller: Flagship knows this
-- conversation can ring that account's phone. No log of who called whom: the row is replaced by the next attach,
-- deleted by "Stop call-backs", when the owner blocks the caller or removes the page, and lapses after 90 days.
CREATE TABLE IF NOT EXISTS voici_ring_backs (
  page_id      TEXT NOT NULL,
  conv         TEXT NOT NULL,
  username     TEXT,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (page_id, conv)
);
CREATE INDEX IF NOT EXISTS idx_voici_ring_backs_expires ON voici_ring_backs(expires_at);

-- The owner's ring that is still ringing (flagship/voici-ring/v1), one per conversation, kept about a minute: the
-- caller's open voi.ci tab and app see it in their thread fetch. The hint is sealed to the caller's thread key.
CREATE TABLE IF NOT EXISTS voici_rings (
  page_id    TEXT NOT NULL,
  conv       TEXT NOT NULL,
  ring_id    TEXT NOT NULL,
  hint       TEXT NOT NULL,
  media      TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, conv)
);

-- Proof-of-work challenges already spent by an anonymous call (flagship/voici-call-pow/v1), until they would have
-- expired anyway. Only the challenge's hash.
CREATE TABLE IF NOT EXISTS voici_pow_spent (
  challenge_hash TEXT PRIMARY KEY,
  expires_at     INTEGER NOT NULL
);

-- "Block this caller" for an anonymous browser key: its conversation id, for 30 days.
CREATE TABLE IF NOT EXISTS voici_anon_blocks (
  page_id    TEXT NOT NULL,
  conv       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, conv)
);
