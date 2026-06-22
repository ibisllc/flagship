-- server_transfers — the transfer-a-box broker lane
-- (docs/account-deletion-and-name-reclaim.md §4).
--
-- One pending cross-account ownership offer per box, plus (once claimed) the
-- acquirer's binding. The GIVER's phone deposits an offer (giver-IRK-signed,
-- names the box + a one-time short-TTL nonce, NOT the acquirer); the ACQUIRER's
-- phone claims it (acquirer-IRK-signed, binds their username + IRK pub to the
-- nonce). `.com` verifies the offer under the box's CURRENT owner IRK and the
-- claim under the acquirer's registered IRK, then re-homes the box's namespace
-- (servers + routing + DNS) to the acquirer.
--
-- Keyed by server_domain — a re-issued offer REPLACES any prior unclaimed row
-- (INSERT OR REPLACE). claimed_at gates one-time-ness; a claimed row is kept
-- after offer expiry so the giver's phone can still complete the disk-key
-- re-seal (the box never holds the giver IRK, so the LUKS re-seal is a
-- giver-phone step deposited via the box-sealed-lease lane). All hex/username
-- columns are stored lowercase.

CREATE TABLE IF NOT EXISTS server_transfers (
  server_domain        TEXT PRIMARY KEY,
  giver_username       TEXT NOT NULL,
  transfer_nonce       TEXT NOT NULL,
  giver_irk_pub_hex    TEXT NOT NULL,
  issued_at            INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  offer_signature_hex  TEXT NOT NULL,
  claimed_at           INTEGER,
  acquirer_username    TEXT,
  acquirer_irk_pub_hex TEXT,
  claim_issued_at      INTEGER,
  claim_signature_hex  TEXT
);
