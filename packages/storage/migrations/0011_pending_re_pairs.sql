-- Recovery re-pair (J.3) — when a user has recovered their UMK on
-- a fresh device with a NEW IRK, they POST a re-pair envelope so
-- .com can swap the username's IRK pubkey after a 24h grace window.
-- The grace lets the OLD device (if it still exists) file an
-- objection and cancel the takeover.
--
-- Single row per username — only one re-pair can be pending at a
-- time. Initiating again while a row exists is rejected; the new
-- IRK has to either wait for the existing one to complete/expire,
-- or use the (different) IRK key-rotation flow.
CREATE TABLE IF NOT EXISTS pending_re_pairs (
  username TEXT PRIMARY KEY,
  new_irk_pub_hex TEXT NOT NULL,
  old_irk_pub_hex TEXT NOT NULL,
  initiated_at INTEGER NOT NULL,
  completes_at INTEGER NOT NULL,
  objected_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pending_re_pairs_completes
  ON pending_re_pairs(completes_at);
