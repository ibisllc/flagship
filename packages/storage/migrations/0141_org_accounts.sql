-- Enterprise accounts (docs/enterprise-accounts.md, phase E2): org rows, every signed org object
-- (authority chain entries, seat invites, accepts, grants, revokes, freezes, overturns, vetoes,
-- ceremonies in progress) and the org's audit hash chain. `.com` verifies every object before it
-- stores it; boxes and phones verify them again themselves. Labels are sealed: `.com` keeps the
-- structure, never the pseudonyms.
CREATE TABLE IF NOT EXISTS orgs (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  genesis_hash TEXT NOT NULL,
  plan_tier TEXT NOT NULL DEFAULT 'enterprise-trial',
  seat_limit INTEGER,
  paid_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_objects (
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  body_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  stored_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, kind, object_key)
);
CREATE INDEX IF NOT EXISTS idx_org_objects_kind ON org_objects(org_id, kind, issued_at);

CREATE TABLE IF NOT EXISTS org_log (
  org_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_sha256 TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (org_id, seq)
);
