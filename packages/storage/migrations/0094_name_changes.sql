-- Paid name changes (docs/naming-recovery-and-name-change.md §5–6).
--
-- One row per completed rename, keyed by the account's STABLE AID (the
-- username itself changes). Serves two purposes: the per-account rename rate
-- limit (enforced here because the RATE_LIMITER binding is only advisory), and
-- the account's name history — private-profile ciphertext is bound to the
-- account id at write time, so a device reading an older blob needs the names
-- the account used to have.
CREATE TABLE IF NOT EXISTS name_changes (
  aid_pub_hex   TEXT NOT NULL,
  old_username  TEXT NOT NULL,
  new_username  TEXT NOT NULL,
  changed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_name_changes_aid ON name_changes(aid_pub_hex, changed_at);
