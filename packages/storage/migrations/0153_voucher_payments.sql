-- Payments that bought blind-signed vouchers (docs/payments-privacy-and-rails.md §11).
--
-- One row per payment `.com` signed vouchers for (or learned was refunded before it could): the SHA-256 of the
-- rail and its payment id (Stripe Checkout session, App Store transaction id, Play purchase token; never the id
-- itself), the rail, the units, the key, the SHA-256 of the blinded set (a retry with the same set gets the same
-- signatures, another set is refused), the UTC day and a state: 'signed' or 'refunded'.
-- Never an account, an address, an email, a store country or a time finer than the day: a payment must not be
-- joinable to the account its vouchers paid for.
--
-- Re-runnable: CREATE ... IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS voucher_payments (
  payment_hash TEXT PRIMARY KEY,
  rail         TEXT NOT NULL,
  units        INTEGER NOT NULL,
  key_id       TEXT NOT NULL,
  blinded_hash TEXT NOT NULL,
  day          TEXT NOT NULL,
  state        TEXT NOT NULL
);
