-- @ibisllc/billing-metering: counter table for a SQL-backed MeterStore.
--
-- Portable across SQLite (3.35+, incl. Cloudflare D1) and PostgreSQL. One
-- row per (account, resource, period); `amount` only ever grows within a
-- period. It holds an account id and a number, never what was metered.

CREATE TABLE IF NOT EXISTS meter_counters (
  account    TEXT   NOT NULL,
  resource   TEXT   NOT NULL,
  period     TEXT   NOT NULL,
  amount     BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (account, resource, period)
);

-- add(account, resource, period, delta, now) — one atomic statement:
--
--   INSERT INTO meter_counters (account, resource, period, amount, updated_at)
--   VALUES (?, ?, ?, ?, ?)
--   ON CONFLICT (account, resource, period) DO UPDATE SET
--     amount     = meter_counters.amount + excluded.amount,
--     updated_at = excluded.updated_at
--   RETURNING amount;
--
-- get(account, resource, period):
--
--   SELECT account, resource, period, amount, updated_at
--   FROM meter_counters WHERE account = ? AND resource = ? AND period = ?;
