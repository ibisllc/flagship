-- AcmeAccountKeyDelivery — seal-to-box delivery of the shared ACME account
-- key (#28 Option B). Spec: docs/per-user-cert-and-addressing.md §4.
-- Envelope: AcmeAccountKeyGrant in packages/protocol/src/auth.ts (IRK-signed) —
-- REUSED (no new protocol type). The grant's recipientPubKey is the box STK.
--
-- Deposit-and-release, mirroring box_sealed_leases (0037): an admin DEPOSITS
-- the account key sealed to the box STK; the box RELEASES the slot on boot and
-- unseals with its STK private key. `.com` holds only the OPAQUE ciphertext
-- (sealed_account_key_hex) — it can carry the key but never read it (I1), and
-- the recipient is the directory-bound box STK so .com cannot retarget the
-- seal (I2).
--
-- ONE slot per box (server_domain PK), distinct from acme_account_key_grants
-- (0043) which keeps the per-admin-device fan-out + audit/requireMinter copies.
-- account_key_id is indexed so the rotation hook (RevokeAcmeAccountKeyGrant)
-- can DROP the box's slot for a retired key in one statement — a stolen box
-- can't re-release a dead key. revoked_at is nullable: a delivery-revoke is
-- deleteByDomain (the row is removed), but the column is kept so a future
-- soft-revoke + audit variant needs no schema change, and the release gate
-- reads it defensively.

CREATE TABLE IF NOT EXISTS acme_account_key_delivery (
  -- Box FQDN the sealed key is delivered to (one slot per box).
  server_domain           TEXT PRIMARY KEY,
  -- sha256-hex of the ACME account PUBLIC key; rotation changes it. The handle
  -- deleteByAccountKeyId keys on this to drop a retired key's slot.
  account_key_id          TEXT NOT NULL,
  -- The ACME account key sealed to recipient_pub_hex — opaque ciphertext hex.
  -- NEVER plaintext (I1). The box unseals with its STK private key.
  sealed_account_key_hex  TEXT NOT NULL,
  -- The PINNED seal recipient — box STK pubkey, 32 bytes hex (the directory-
  -- bound identity for server_domain; covered by the IRK signature on the
  -- grant, verified at deposit time).
  recipient_pub_hex       TEXT NOT NULL,
  -- ms since epoch.
  issued_at               INTEGER NOT NULL,
  -- ms since epoch; re-seal before expiry.
  expires_at              INTEGER NOT NULL,
  -- ms since epoch, NULL = active. Set on a soft delivery-revoke variant.
  revoked_at              INTEGER
);

-- Rotation hook: drop every slot of a retired account key in one statement.
CREATE INDEX IF NOT EXISTS idx_aakd_account_key_id
  ON acme_account_key_delivery(account_key_id);
