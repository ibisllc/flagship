-- v1-sec GAP 3 — transfer-a-box LEGACY re-home authorization
-- (docs/account-deletion-and-name-reclaim.md §4; packages/protocol RehomeAuthorization).
--
-- A box with NO pinned admin master root used to write its re-home marker (new
-- FQDN + acquirer IRK) purely on `.com`'s unauthenticated word — a rogue `.com`
-- could move a legacy box's FQDN/cert/routing into an attacker namespace. The
-- box side (transferRehomeConsumer) now REFUSES to re-home unless the rehome
-- read carries a giver-owner-IRK-signed `flagship/server-rehome-auth/v1` proof
-- that verifies against its pinned owner IRK. These two columns persist that
-- giver-signed proof on the CLAIMED transfer row so `.com` can relay it (it
-- verifies the signature against the giver account's registered IRK as a
-- garbage filter, and cannot forge it).
--
-- The proof commits to (oldServerDomain, newServerDomain, acquirerIrkPub,
-- issuedAt) — all of which live on the row already (server_domain, the
-- re-derived acquirer canonical, acquirer_irk_pub_hex) — so only issuedAt +
-- the signature need columns. Mirrors the 0060 disk-key / 0068 admin-handoff
-- shape (deposited post-claim, idempotent re-deposit replaces). All hex stored
-- lowercase.
--
-- Numbering: 0069–0079 stay reserved for main's organic allocations; this
-- branch's feature migrations are parked in the 0080+ block (0080/0081 taken).

ALTER TABLE server_transfers ADD COLUMN rehome_auth_issued_at INTEGER;
ALTER TABLE server_transfers ADD COLUMN rehome_auth_sig_hex TEXT;
