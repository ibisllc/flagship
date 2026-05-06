-- Marketplace listings + LLM promo usage tracking + tier billing.
--
-- These tables are added to support v1 alpha: anyone can list an app,
-- anyone can install someone else's, the promo tracks daily/lifetime
-- LLM call counts so we can enforce limits, and tier records the
-- user's current subscription state (driven by Stripe webhooks).
--
-- Privacy invariants reinforced here:
--   - We store ONLY app metadata (name, description, screenshots, URL).
--     Never the app's source. Never any user data.
--   - LLM-promo usage is per-user, by day. We don't store prompts.
--   - Tier is per-user (not per-server) so multiple servers under one
--     account share the same quota.

-- ──────────────────────────────────────────────────────────────────────
-- Marketplace
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_listings (
  -- Composite key: a creator can list one app per slug. Listing a new
  -- version = update existing row; listing a different app = new row.
  creator TEXT NOT NULL,
  slug TEXT NOT NULL,
  -- Display fields. Description is markdown.
  name TEXT NOT NULL,
  tagline TEXT NOT NULL,
  description_md TEXT NOT NULL,
  category TEXT NOT NULL,
  tags_csv TEXT NOT NULL DEFAULT '',
  -- Canonical URL of the creator's pod. Subscribers pull from here.
  canonical_url TEXT NOT NULL,
  -- Manifest hash committed to at listing time. Phone re-checks before install.
  manifest_hash_hex TEXT NOT NULL,
  -- Up to 5 screenshot R2 keys, JSON array of strings.
  screenshot_keys_json TEXT NOT NULL DEFAULT '[]',
  -- Listing visibility. Private listings are still queryable by URL but
  -- hidden from search; takedown sets to "removed".
  status TEXT NOT NULL CHECK (status IN ('listed', 'private', 'removed')) DEFAULT 'listed',
  -- Verified-by-Flagship security scan.
  scan_grade TEXT CHECK (scan_grade IN ('A', 'B', 'C', 'D', 'F')),
  scan_report_key TEXT,
  scan_completed_at INTEGER,
  -- Featured slot (paid).
  featured_until INTEGER,
  -- Soft ranking signal — install_count + scan_grade + featured all feed it.
  rank_score REAL NOT NULL DEFAULT 0,
  install_count INTEGER NOT NULL DEFAULT 0,
  -- Distribution flag mirrors `manifest.distribution.public`. Drives
  -- whether subscribers must be explicitly added.
  public_distribution INTEGER NOT NULL DEFAULT 0,
  listed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- IRK signature over the listing canonical bytes; lets us prove
  -- authorship + revoke on suspicion.
  irk_signature_hex TEXT NOT NULL,
  PRIMARY KEY (creator, slug)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_status ON marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_category ON marketplace_listings(category);
CREATE INDEX IF NOT EXISTS idx_marketplace_rank ON marketplace_listings(status, rank_score DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_featured
  ON marketplace_listings(featured_until)
  WHERE featured_until IS NOT NULL;

-- Per-listing install events. Phones POST these on successful install
-- so the creator + Flagship can show install counts. Deduped on
-- (puller_irk, creator, slug, day) to defeat refresh-spam.
CREATE TABLE IF NOT EXISTS marketplace_installs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator TEXT NOT NULL,
  slug TEXT NOT NULL,
  puller_irk_pub_hex TEXT NOT NULL,
  installed_day INTEGER NOT NULL,           -- floor(ms / 86_400_000)
  installed_at INTEGER NOT NULL,
  UNIQUE (creator, slug, puller_irk_pub_hex, installed_day)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_installs_listing
  ON marketplace_installs(creator, slug);

-- ──────────────────────────────────────────────────────────────────────
-- LLM-promo usage (free-tier daily/lifetime limits)
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS llm_promo_usage (
  username TEXT NOT NULL,
  day INTEGER NOT NULL,                     -- floor(ms / 86_400_000)
  daily_count INTEGER NOT NULL DEFAULT 0,
  daily_input_tokens INTEGER NOT NULL DEFAULT 0,
  daily_output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, day)
);

CREATE TABLE IF NOT EXISTS llm_promo_lifetime (
  username TEXT PRIMARY KEY,
  lifetime_count INTEGER NOT NULL DEFAULT 0,
  lifetime_input_tokens INTEGER NOT NULL DEFAULT 0,
  lifetime_output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Per-tier overrides, JSON: `{"daily_calls": 100, "lifetime_calls": null}`.
  -- Null in a field means "fall back to global default for the user's tier."
  override_json TEXT,
  updated_at INTEGER NOT NULL
);

-- Each one-shot LLM-promo key issued is recorded so we can de-dupe and
-- so the provider's billing webhook can correlate back to a user.
CREATE TABLE IF NOT EXISTS llm_promo_issues (
  issue_id TEXT PRIMARY KEY,                -- random 16-byte hex
  username TEXT NOT NULL,
  provider TEXT NOT NULL,                   -- 'anthropic' | 'openai' | 'google'
  scoped_key_hex TEXT NOT NULL,             -- ENCRYPTED with worker secret; never plain
  daily_input_token_cap INTEGER NOT NULL,
  daily_output_token_cap INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,                      -- when the box pulled it
  consumed_by_server TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_promo_issues_user
  ON llm_promo_issues(username, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_promo_issues_unconsumed
  ON llm_promo_issues(consumed_at)
  WHERE consumed_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────
-- Tier billing
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tier_subscriptions (
  username TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('free', 'hobby', 'maker')) DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_end INTEGER,
  -- Phone-signed acknowledgement of the current tier (canonical bytes
  -- include username + tier + stripe_subscription_id + period_end).
  -- Required before privileged-tier operations — stops a Stripe-only
  -- compromise from upgrading without phone consent.
  irk_receipt_hex TEXT,
  irk_signature_hex TEXT,
  updated_at INTEGER NOT NULL
);

-- Hardware orders (Path A: pre-built box).
CREATE TABLE IF NOT EXISTS hardware_orders (
  order_id TEXT PRIMARY KEY,                -- random 16-byte hex
  username TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('tiny', 'standard', 'pro')),
  peer_backup_addon TEXT,                   -- '250GB' | '500GB' | '1TB' | NULL
  shipping_address_json TEXT NOT NULL,      -- JSON; encrypted-at-rest at app layer
  stripe_payment_intent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'placed', 'paid', 'assembled', 'shipped', 'delivered', 'plugged_in', 'cancelled', 'refunded'
  )) DEFAULT 'placed',
  -- Per-order pre-installed box key, burnt at assembly time. Allows the
  -- box's first-boot apkovl to authenticate to /api/box/order/<id>/blob
  -- without any prior identity registration.
  box_pre_install_key_hex TEXT,
  -- The build code blob the user's phone minted, fetched by the box on
  -- first boot.
  build_blob_json TEXT,
  build_blob_signature_hex TEXT,
  placed_at INTEGER NOT NULL,
  delivered_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hardware_orders_user
  ON hardware_orders(username, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_hardware_orders_status
  ON hardware_orders(status);

-- ──────────────────────────────────────────────────────────────────────
-- Push notification routing
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS push_tokens (
  token_id TEXT PRIMARY KEY,                -- random 16-byte hex
  username TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('apns', 'fcm', 'webpush')),
  -- Provider-specific token (APNs device token, FCM registration token,
  -- WebPush endpoint). Stored as opaque blob; we don't introspect.
  provider_token TEXT NOT NULL,
  -- Public-key the phone pre-shared at pair time. Worker-bound payloads
  -- are encrypted to this so Worker code can't read user-bound notif
  -- bodies.
  push_x25519_pub_hex TEXT NOT NULL,
  -- Phone IRK-signature over the registration canonical bytes.
  registration_signature_hex TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(username);

-- ──────────────────────────────────────────────────────────────────────
-- Recovery shards (optional social recovery in v2; table present so the
-- migration sequence stays stable when we wire it).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recovery_shards (
  username TEXT NOT NULL,
  shard_id INTEGER NOT NULL,
  -- N-of-K Shamir-shared, encrypted to a friend's IRK pubkey. The
  -- friend's phone holds it; .com only stores the metadata for
  -- discovery during a recovery flow.
  guardian_irk_pub_hex TEXT NOT NULL,
  shard_meta_json TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (username, shard_id)
);
