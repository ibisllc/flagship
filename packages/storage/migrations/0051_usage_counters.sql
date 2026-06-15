-- Public-egress metering — per-account monthly usage counter.
--
-- The only cost that scales with usage is public-ingress traffic routed
-- through the `.services` relay (all visitor bytes transit the Fly hub; Fly
-- bills outbound egress). This table holds the cumulative egress bytes per
-- account per UTC month, so the control plane can answer the relay's gating
-- question: "is this free account over its monthly quota?" (free = hard cap;
-- paid = bills overage). See packages/control-plane/src/metering.ts and
-- docs/monetization-free-tier-first.md for the quota model + locked pricing.
--
-- Workspace artifact: this migration lives on `main` (like marketplace_listings)
-- even though the metering APPLICATION code lives on `feat/metering` until the
-- paid tier launches.

CREATE TABLE IF NOT EXISTS usage_counters (
  -- Lowercased username.
  username     TEXT NOT NULL,
  -- Billing period, "YYYY-MM" (UTC month). The egress quota resets here.
  period       TEXT NOT NULL,
  -- Cumulative public-ingress egress bytes routed through the relay for this
  -- account in this period. Monotonic within a period; never decremented.
  bytes_egress INTEGER NOT NULL DEFAULT 0,
  -- ms since epoch — last time the relay reported a delta for this row.
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (username, period)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_username ON usage_counters(username);
