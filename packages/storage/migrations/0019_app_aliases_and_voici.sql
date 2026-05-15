-- voi.ci shortener + user-controlled app URL aliases.
--
-- Two related concepts shipping together:
--
--   1. user_app_aliases — per (username, appId) override of the URL
--      stem the app surfaces at. Defaults to the slug-creator derived
--      label; the user can Replace it to hide the package identity
--      and / or rotate after a spam campaign. The internal appId
--      stays stable so daemons / membership stores / R2 backups keep
--      working.
--
--   2. voici_links — short-code → target mapping for the voi.ci
--      shortener. The Worker mints codes on demand, and the voi.ci
--      hostname route looks them up + 302-redirects. Rename deletes
--      old codes for the affected app and mints fresh ones, so a
--      previously-shared link breaks the moment the user renames
--      (that's the whole point — adversary's saved URL goes dead).
--
-- A user_app_aliases row is created lazily on first Replace; absent
-- = use the default slug-creator label. Worker code falls back to
-- the default everywhere a row is missing so this migration is
-- backwards compatible with every existing install.

CREATE TABLE IF NOT EXISTS user_app_aliases (
  -- Composite key — one alias per (user, app).
  username TEXT NOT NULL,
  app_id   TEXT NOT NULL,
  -- The URL stem the user picked. Validated against
  -- DNS_LABEL_RE on the way in.
  display_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, app_id)
);

-- For "give me every alias for user U" — drives the daemon's apps
-- list join + the apps-list BFF on /api/users/:u/apps/links.
CREATE INDEX IF NOT EXISTS idx_user_app_aliases_username
  ON user_app_aliases(username);

CREATE TABLE IF NOT EXISTS voici_links (
  -- Short code; primary key. 6 base36 chars at mint time but we
  -- keep the column wide (10) in case we grow the alphabet later.
  code TEXT PRIMARY KEY,
  -- The owning username. Renames + revokes cascade-delete here.
  username TEXT NOT NULL,
  -- Optional appId — when present, deleting the app's aliases
  -- cascades these too. NULL for one-off pod-level shortens.
  app_id TEXT,
  -- Where the code redirects (full URL, scheme included).
  target_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Soft TTL — the Worker route returns 410 Gone past this point.
  -- NULL = no expiry (which is what app links use; we manage their
  -- lifecycle via app_id cascade).
  expires_at INTEGER
);

-- For the cascade-delete-on-rename path.
CREATE INDEX IF NOT EXISTS idx_voici_links_user_app
  ON voici_links(username, app_id);

-- For the periodic GC of expired one-off codes.
CREATE INDEX IF NOT EXISTS idx_voici_links_expires
  ON voici_links(expires_at)
  WHERE expires_at IS NOT NULL;
