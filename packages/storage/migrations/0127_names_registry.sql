-- One registry for every voi.ci path (docs/voici-namespace-spec.md; storage in packages/storage/src/names.ts).
--
-- `names` holds every username, custom link name, code and reserved word. The partial UNIQUE index on `safety_key`
-- (lower case, hyphens removed, 0 read as o, 1 as l) over every row that is not `released` is the only collision
-- check: a claim is one INSERT, and a unique violation means "taken or too similar to an existing name" (D8, D9).
-- Lookups match the exact `name`, never the key.
--
--   kind       statuses                    notes
--   username   active | held | released    owner = the account's username; held = given up (account deleted, later
--                                          renamed), blocks for 30 days (held_until), then a job releases it
--   link       active | retired            custom link names; retired blocks for ever (D7)
--   code       active | retired            system-minted; never reused (D7)
--   reserved   active                      config file packages/control-plane/src/reservedNames.json; no owner
--
-- It replaces the plain collision checks: `voici_links` (codes) and `voici_names` (custom link names, whose 30-day
-- wait used to free a name; under D7 a given-up link name is retired for good) are copied in below and no longer read.
-- They are left in place, unread, so this migration loses nothing; a later one may drop them. `usernames` stays the
-- account record; every write to it claims or holds its row here in the same transaction.
--
-- Read-only checks first (spec, Migration steps 1 to 3): `node scripts/voici-namespace-report.mjs` (prod) and
-- `--gym` list usernames that fail the format, safety-key duplicates and reserved collisions. Nothing is renamed: a
-- name that fails the format keeps its account and its row; of two names with one safety key the older claim gets
-- the row (INSERT OR IGNORE, oldest first) and the other is reported; a reserved word an existing name already
-- holds stays with that name (reserved rows are inserted last).
--
-- Re-runnable: CREATE ... IF NOT EXISTS and INSERT OR IGNORE throughout (a second run adds nothing that is there).
-- Needs 0111 (voici_names, voici_links.retired_at) applied first.

CREATE TABLE IF NOT EXISTS names (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  safety_key        TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('username', 'link', 'code', 'reserved')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'held', 'released', 'retired')),
  owner             TEXT,
  service_id        TEXT,
  target            TEXT,
  expires_at        INTEGER,
  held_until        INTEGER,
  last_active_at    INTEGER,
  warned            INTEGER NOT NULL DEFAULT 0,
  reason            TEXT,
  created_at        INTEGER NOT NULL,
  status_changed_at INTEGER NOT NULL,
  CHECK (
    (kind = 'username' AND status IN ('active', 'held', 'released')) OR
    (kind IN ('link', 'code') AND status IN ('active', 'retired')) OR
    (kind = 'reserved' AND status = 'active')
  ),
  CHECK (status <> 'held' OR held_until IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS names_safety_key_live ON names(safety_key) WHERE status <> 'released';
CREATE INDEX IF NOT EXISTS names_name ON names(name);
CREATE INDEX IF NOT EXISTS names_owner ON names(owner, kind, status);
CREATE INDEX IF NOT EXISTS names_service ON names(owner, service_id, kind, status);
CREATE INDEX IF NOT EXISTS names_held ON names(held_until) WHERE status = 'held';

-- Step 4a: every account's username, oldest claim first.
INSERT OR IGNORE INTO names (name, safety_key, kind, status, owner, warned, created_at, status_changed_at)
  SELECT username, replace(replace(replace(lower(username), '-', ''), '0', 'o'), '1', 'l'), 'username', 'active', username, 0, claimed_at, claimed_at
  FROM usernames ORDER BY claimed_at, username;

-- Step 4b: codes (a retired code stays retired; a one-off keeps its expiry and answers 410 after it).
INSERT OR IGNORE INTO names (name, safety_key, kind, status, owner, service_id, target, expires_at, warned, reason, created_at, status_changed_at)
  SELECT code, replace(replace(replace(lower(code), '-', ''), '0', 'o'), '1', 'l'), 'code', CASE WHEN retired_at IS NULL THEN 'active' ELSE 'retired' END, username, service_id,
         target_url, expires_at, 0, CASE WHEN retired_at IS NULL THEN NULL ELSE 'deleted' END, created_at, COALESCE(retired_at, created_at)
  FROM voici_links ORDER BY created_at, code;

-- Step 4c: custom link names; one in its old 30-day wait is retired (D7).
INSERT OR IGNORE INTO names (name, safety_key, kind, status, owner, service_id, last_active_at, warned, reason, created_at, status_changed_at)
  SELECT display, replace(replace(replace(lower(display), '-', ''), '0', 'o'), '1', 'l'), 'link', CASE WHEN state = 'live' THEN 'active' ELSE 'retired' END, username, service_id,
         last_active_at, warned, release_reason, set_at, COALESCE(released_at, set_at)
  FROM voici_names ORDER BY set_at, display;

-- Step 4d: the reserved words (packages/control-plane/src/reservedNames.json as of this migration).
INSERT OR IGNORE INTO names (name, safety_key, kind, status, warned, created_at, status_changed_at)
  SELECT column1, replace(replace(replace(lower(column1), '-', ''), '0', 'o'), '1', 'l'), 'reserved', 'active', 0, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  FROM (VALUES
  ('about'), ('abuse'), ('account'), ('admin'), ('administrator'), ('all'), ('api'), ('app'), ('apps'), ('assets'),
  ('auth'), ('billing'), ('blog'), ('broadcast'), ('cdn'), ('ci'), ('console'), ('contact'), ('control'),
  ('control-plane'), ('dashboard'), ('dev'), ('dns'), ('docs'), ('download'), ('downloads'), ('e2e'), ('email'),
  ('files'), ('flagship'), ('flagship-services'), ('flagshipserver'), ('ftp'), ('git'), ('gym'), ('help'), ('home'),
  ('host'), ('imap'), ('index'), ('lb'), ('legal'), ('localhost'), ('login'), ('logout'), ('mail'), ('ns1'), ('ns2'),
  ('null'), ('official'), ('ops'), ('payment'), ('pop'), ('pricing'), ('privacy'), ('prod'), ('qa'), ('register'),
  ('relay-fallback'), ('remote'), ('root'), ('security'), ('servers'), ('service'), ('services'), ('settings'),
  ('signin'), ('signup'), ('smtp'), ('staff'), ('staging'), ('static'), ('status'), ('studio'), ('support'),
  ('team'), ('terms'), ('test'), ('tunnel'), ('undefined'), ('voi'), ('voici'), ('webapp'), ('www')
  );
