-- Paid marketplace apps + purchase entitlements (#14 — the golden goose).
--
-- A listing may carry a price (price_usd_cents; NULL/0 = free). A paid app
-- can't be installed without a purchase row attributing it to a username.
-- Purchases are the install-entitlement primitive: granted by the Stripe app
-- webhook (mode=payment), an admin comp, or a voucher — always through the
-- single grantAppPurchase writer, idempotently.
--
-- Price-setting is curated (admin) for now; developer self-serve pricing +
-- payouts + the revenue cut are #15. Distribution stays box-direct over the
-- listing's canonical pipe — .com only attests ownership, it never proxies the
-- app's content.

ALTER TABLE marketplace_listings ADD COLUMN price_usd_cents INTEGER;

CREATE TABLE IF NOT EXISTS app_purchases (
  username     TEXT NOT NULL,
  creator      TEXT NOT NULL,
  slug         TEXT NOT NULL,
  purchased_at INTEGER NOT NULL,
  -- how the entitlement was granted: "stripe" | "admin" | "voucher".
  source       TEXT NOT NULL,
  -- opaque provenance ref (stripe event id / admin note / voucher hash). Audit only.
  ref          TEXT,
  -- one entitlement per (user, app); a redelivery / re-purchase is a no-op.
  PRIMARY KEY (username, creator, slug)
);

CREATE INDEX IF NOT EXISTS idx_app_purchases_user ON app_purchases (username);
