-- Watch delegate keys — opt-in quick-approve from the Apple Watch / Wear.
-- Spec: docs/watch-delegate-key-design.md. Envelope: WatchDelegateKey in
-- packages/protocol/src/auth.ts (IRK-signed, scoped to "boot-approval" ONLY,
-- short-TTL, independently revocable).
--
-- A separate, IRK-attested signing key lets the owner approve a server BOOT
-- from the Watch without a fresh phone biometric prompt, while the IRK stays
-- fully biometric-gated for every destructive operation. The boot worker +
-- the Worker accept a delegate signature for a boot approval and NOTHING else.
--
-- Shape parallels device_capability_grants (0031) — TEXT primary key (the
-- envelope's v4-UUID grantId, which is itself part of the signed canonical
-- bytes), hex crypto material, ms-since-epoch
-- timestamps, a nullable revoked_at so the row is RETAINED on revoke for
-- audit + replay. Simpler than device grants: ONE active delegate per user
-- (no device label), enforced by the unique partial index below — re-minting
-- MUST revoke the prior row first.

CREATE TABLE IF NOT EXISTS watch_delegates (
  -- SHA-256 hex of the WatchDelegateKey canonical bytes.
  grant_id          TEXT PRIMARY KEY,
  -- The user whose IRK signed the delegate.
  username          TEXT NOT NULL,
  -- The watch-delegate's Ed25519 pubkey, 32 bytes hex.
  delegate_pub_hex  TEXT NOT NULL,
  -- JSON array of DelegateScope strings (v1: ["boot-approval"]).
  scopes_json       TEXT NOT NULL,
  -- ms since epoch.
  issued_at         INTEGER NOT NULL,
  -- ms since epoch.
  expires_at        INTEGER NOT NULL,
  -- Ed25519 over canonical bytes, 64 bytes hex.
  signature_hex     TEXT NOT NULL,
  -- ms since epoch, NULL = active. Set when a RevokeWatchDelegate lands.
  revoked_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wd_username      ON watch_delegates(username);
CREATE INDEX IF NOT EXISTS idx_wd_delegate_pub  ON watch_delegates(delegate_pub_hex);
CREATE INDEX IF NOT EXISTS idx_wd_expires_at    ON watch_delegates(expires_at);

-- At most one ACTIVE delegate per user. Re-minting produces a new row + a
-- tombstone (revoked_at) on the previous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wd_username_active
  ON watch_delegates(username)
  WHERE revoked_at IS NULL;
