-- Custom (external) domain orders (#79A).
--
-- One row per (service_id, user_id). A new attach request DESTRUCTIVELY
-- replaces any prior order for the pair (decided design: irreversible;
-- doubles as the only "forget a custom domain" affordance — see
-- project_external_domains memory + docs/plan-external-domains-and-demo.md).
--
-- The .com POST path only RECORDS the request (status='pending') and
-- enforces a 300s rate limit off last_changed. The CNAME is verified
-- out-of-band by the Phase-4 verifier, which flips status to
-- 'active'/'failed' and bumps fail_count. status='active' is what the
-- services-list "it's live" swap and the #82 re-verify sweep key on.
--
-- Pre-launch: no production rows, so the CREATE is non-destructive.

CREATE TABLE IF NOT EXISTS custom_domain_orders (
  service_id   TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  fqdn         TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('pending', 'active', 'failed')),
  last_changed INTEGER NOT NULL,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (service_id, user_id)
);

-- The Phase-4 #82 sweep scans active orders.
CREATE INDEX IF NOT EXISTS idx_cdo_status ON custom_domain_orders (status);
