-- The Business plan for orgs (docs/plans-and-backup-offer.md "As built"): the trial's end and the seat count the
-- org's vouchers pay for, beside `orgs.paid_until` (0141). An org without a row is on the trial that started at its
-- `created_at` (`.com` reads the trial length from PAYMENTS_CONFIG), so existing orgs need no backfill.
--
-- Nothing here names a person or an account: the org id, two times and a count.
--
-- Re-runnable: CREATE ... IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS org_plan_terms (
  org_id        TEXT PRIMARY KEY,
  trial_ends_at INTEGER NOT NULL,
  paid_seats    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
