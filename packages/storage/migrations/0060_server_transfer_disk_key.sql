-- transfer-a-box disk-key handoff (docs/account-deletion-and-name-reclaim.md §4,
-- Layer B). After the acquirer claims, only the GIVER's phone can unseal the box's
-- LUKS disk key (it holds the giver IRK; the box holds only the sealed blob). The
-- giver's phone unseals it, RE-SEALS it to the ACQUIRER IRK, and deposits it here
-- so the acquirer's phone can pick it up and complete the box-sealed-lease deposit
-- — the accepted two-phone handshake (giver first). The blob is sealed to the
-- acquirer IRK ⇒ `.com` stays content-blind (I1). Stored on the claimed transfer
-- row; consume-once on read.
ALTER TABLE server_transfers ADD COLUMN disk_key_handoff_hex TEXT;
ALTER TABLE server_transfers ADD COLUMN disk_key_handoff_at INTEGER;
