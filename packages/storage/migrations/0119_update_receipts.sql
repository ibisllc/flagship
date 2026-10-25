-- Canary update receipts (architecture v2 V02; apps/com/src/updateReceipts.ts, docs/runbooks/canary.md).
-- A box whose owner agreed sends one content-free receipt per update verdict: release, rollout cohort,
-- health gate pass/fail, rolled back yes/no, CPU architecture, container stack. `.com` keeps COUNTS per
-- release, cohort, profile and arrival day; never a row per box, never an address, account or server.
-- `update_receipt_nonces` only drops a resend of the same receipt (a random value per receipt, linking
-- nothing) and is pruned after 14 days. Re-runnable.
CREATE TABLE IF NOT EXISTS update_receipt_counts (
  release_commit TEXT NOT NULL,
  cohort TEXT NOT NULL,
  arch TEXT NOT NULL,
  stack TEXT NOT NULL,
  day TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  stuck INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (release_commit, cohort, arch, stack, day)
);
CREATE TABLE IF NOT EXISTS update_receipt_nonces (
  nonce TEXT PRIMARY KEY,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_update_receipt_nonces_day ON update_receipt_nonces(day);
