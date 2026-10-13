-- Metering core — one usage counter per (account, resource, period).
--
-- Replaces usage_counters (0051), whose primary key (username, period) could
-- only ever hold relay egress bytes. The control plane now meters every
-- resource that costs us money through one module
-- (packages/control-plane/src/meter.ts): "egress" (public bytes through the
-- .services relay, both directions) and "ai-tokens" (tokens served by the
-- in-house model). A new resource needs no schema change.
--
-- Privacy: an account name and a number. Never content, hosts, IPs or
-- prompts.
--
-- Re-runnable: CREATE IF NOT EXISTS, and the copy takes the larger value, so a
-- second run never double-counts. Apply BEFORE deploying the .com Worker that
-- reads this table. Relay reports that land in usage_counters between this
-- copy and that deploy stay there (an under-count of a few minutes, which the
-- metering model tolerates). usage_counters is left in place for the Worker
-- still running during the deploy; nothing reads it afterwards.

CREATE TABLE IF NOT EXISTS meter_counters (
  -- Lowercased username.
  account    TEXT NOT NULL,
  -- What is counted, e.g. "egress" (bytes) or "ai-tokens" (tokens).
  resource   TEXT NOT NULL,
  -- The window the allowance resets on: "YYYY-MM" (UTC month),
  -- "YYYY-MM-DD" (UTC day) or "all" (lifetime).
  period     TEXT NOT NULL,
  -- Cumulative amount in the resource's unit. Monotonic within a period.
  amount     INTEGER NOT NULL DEFAULT 0,
  -- ms since epoch of the last add.
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account, resource, period)
);

INSERT INTO meter_counters (account, resource, period, amount, updated_at)
  SELECT username, 'egress', period, bytes_egress, updated_at FROM usage_counters WHERE 1
  ON CONFLICT(account, resource, period) DO UPDATE SET
    amount     = MAX(meter_counters.amount, excluded.amount),
    updated_at = MAX(meter_counters.updated_at, excluded.updated_at);
