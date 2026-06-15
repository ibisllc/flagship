-- Stripe webhook idempotency (#11).
--
-- Stripe delivers each event AT LEAST once and retries on any non-2xx, so the
-- same `checkout.session.completed` / `invoice.paid` can arrive several times.
-- We grant a tier from these events, so a replay must NOT re-grant. The webhook
-- claims an event id ATOMICALLY here (INSERT … the PRIMARY KEY makes a duplicate
-- a no-op) before it writes the entitlement; only the first claimer proceeds.
--
-- Holds no payment data — just the opaque Stripe event id + when we processed
-- it (and the event type, for audit). The actual entitlement lives in
-- tier_subscriptions via grantTier.

CREATE TABLE IF NOT EXISTS stripe_events (
  -- Stripe's `evt_…` event id.
  event_id     TEXT PRIMARY KEY,
  -- e.g. "checkout.session.completed" — for audit only.
  event_type   TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
