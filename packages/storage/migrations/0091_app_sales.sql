-- Developer payouts + revenue cut (#15 — feat/marketplace).
--
-- A completed PAID install writes one row here: the gross the buyer paid,
-- the platform cut (MARKETPLACE_CUT_BPS), and the net owed to the creator.
-- This is the payout ledger the developer console reads (gross/cut/net
-- per creator); actual disbursement is an owner/ops process, not a money
-- integration.
--
-- SINGLE-WRITER IDEMPOTENT: `sale_key` is the idempotency key — the Stripe
-- event id for a card purchase, or `<source>:<creator>:<slug>:<buyer>` for
-- an admin comp / voucher. INSERT OR IGNORE on a redelivery / re-grant
-- changes 0 rows, so a Stripe webhook redelivery never double-counts a
-- sale (mirrors app_purchases + stripe_events idempotency).
--
-- Numbered 0091 (main is at 0082; 0090 taken on this branch): feature
-- branches park in a far block so main keeps 0083+ free for its next
-- organic allocations. See packages/control-plane/src/schemaStatus.ts.

CREATE TABLE IF NOT EXISTS app_sales (
  -- idempotency key: stripe event id, or `<source>:<creator>:<slug>:<buyer>`.
  sale_key        TEXT NOT NULL PRIMARY KEY,
  -- composite listing id `<creator>--<slug>` (the marketplace addressing form).
  listing_id      TEXT NOT NULL,
  creator_account TEXT NOT NULL,
  buyer_account   TEXT NOT NULL,
  gross_cents     INTEGER NOT NULL,
  cut_cents       INTEGER NOT NULL,
  net_cents       INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'usd',
  -- audit provenance; NULL for admin/voucher comps.
  stripe_event_id TEXT,
  at              INTEGER NOT NULL
);

-- The developer console lists + rolls up a creator's sales, newest first.
CREATE INDEX IF NOT EXISTS idx_app_sales_creator ON app_sales (creator_account, at DESC);
