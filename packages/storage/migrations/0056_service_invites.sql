-- service_invites — bearer-link service-access capability invites bound to the
-- redeemer's STABLE account identity (docs/service-access-gating.md).
--
-- A service admin gates a pod-resident service open/restricted; a restricted
-- service's allow-list is managed via invite links. Each link carries a random
-- 32-byte secret; `.com` stores only its SHA-256 (`secret_hash`) and the
-- household-key-sealed `{name, photo?}` bundle (ciphertext — `.com` holds no
-- UMK, so it cannot read the name/photo). On FIRST redeem the invite binds to
-- the friend's AID (`deriveAccountId(UMK)` — the NON-rotating identity, NOT the
-- versioned IRK); a re-redeem by the same AID is idempotent, a different AID is
-- rejected. `invite_id` = hash(AID_author)·hash(devicePub)·counter (unique +
-- attributable + monotonic). The create envelope is IRK-signed by the author,
-- redeem AID-signed by the friend, revoke IRK-signed by the author — all
-- verified at the handler boundary; this table is the directory.
--
-- ADDITIVE + IDEMPOTENT.

CREATE TABLE IF NOT EXISTS service_invites (
  invite_id         TEXT PRIMARY KEY,
  author_aid        TEXT NOT NULL,
  service_ref       TEXT NOT NULL,
  encrypted_bundle  TEXT NOT NULL,
  secret_hash       TEXT NOT NULL,
  bound_aid         TEXT,
  bound_at          INTEGER,
  created_at        INTEGER NOT NULL,
  revoked_at        INTEGER
);

-- Redeem lookup is by secret_hash; make it unique so a secret maps to exactly
-- one invite (a hash collision / duplicate would be a bug, not a feature).
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_invites_secret_hash
  ON service_invites(secret_hash);

-- Author-owned listing.
CREATE INDEX IF NOT EXISTS idx_service_invites_author
  ON service_invites(author_aid, created_at DESC);
