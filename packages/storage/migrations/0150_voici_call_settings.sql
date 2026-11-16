-- The owner's call hours, synced between the owner's own devices (docs/voici-calls.md, owner decision 2026-11-16,
-- option c): one sealed blob per account (flagship/voici-call-settings/v1, AES-GCM under a key from the account's
-- UMK). `.com` stores ciphertext only and never learns the hours or the time zone. Compare-and-set on `version`.
-- Storage packages/storage/src/voiciCalls.ts, handlers packages/control-plane/src/voiciCallModes.ts.
--
-- Re-runnable: CREATE ... IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS voici_call_settings (
  username   TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
