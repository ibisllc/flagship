-- 0062: the "recently-offered handles" roster (docs/username-suggestion-queue.md).
--
-- A username is claimable ONLY if the server recently SUGGESTED it (the generator
-- vets it — not claimed, not a .com — before it can be offered). This table is the
-- roster: one row per name handed to a client, consumed on claim, pruned on expiry.

CREATE TABLE IF NOT EXISTS username_offer (
  name TEXT PRIMARY KEY,
  device_key TEXT NOT NULL,
  offered_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username_offer_offered
  ON username_offer (offered_at);
