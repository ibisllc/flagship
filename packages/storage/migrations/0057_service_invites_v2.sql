-- service_invites v2 hardening (docs/service-access-gating.md "## v2 hardening").
--
-- Phase 1 (box-as-authority) + Phase 3 (invite tiers) backing columns, plus a
-- per-bind ledger so a GROUP / multi-use invite can bind more than one AID under
-- one invite_id (the v1 schema had a single bound_aid, which only fits a personal
-- invite). All ADDITIVE + IDEMPOTENT — a v1 row keeps its bound_aid/bound_at, the
-- new columns default to the v1 behavior (single-use, auto-approve, 0 redemptions,
-- no signature stored), so existing rows + signatures are unaffected.
--
--   create_sig       — the author's create-envelope signature (IRK or AID), hex.
--                      Released to the box on redeem so the box verifies the
--                      owner's create itself (demoting .com to a blind store).
--   max_redemptions  — GROUP cap; NULL ⇒ personal/single-use (v1). 0 ⇒ unlimited.
--   expires_at       — optional invite expiry (epoch-ms); NULL ⇒ never.
--   redemptions      — count of distinct AIDs bound (group accounting); DEFAULT 0.
--   approval_mode    — 'auto' (first-bind) | 'manual' (author-confirmed loop);
--                      DEFAULT 'auto' (the v1 behavior).
--
-- usernames.aid_pub_hex — the account's STABLE AID pubkey (deriveAccountId(UMK)),
--   registered alongside the IRK so .com can verify AID-signed create/revoke
--   against it (dual-accept with the IRK during the client transition). NULL on
--   pre-v2 rows ⇒ .com falls back to IRK-verify only.

ALTER TABLE service_invites ADD COLUMN create_sig TEXT;
ALTER TABLE service_invites ADD COLUMN max_redemptions INTEGER;
ALTER TABLE service_invites ADD COLUMN expires_at INTEGER;
ALTER TABLE service_invites ADD COLUMN redemptions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_invites ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE usernames ADD COLUMN aid_pub_hex TEXT;

-- Per-bind ledger: every AID bound to an invite (incl. the first). A GROUP invite
-- accumulates >1 row here; a personal invite has exactly one. Drives the
-- revoked-since boundAIDs list + the box-side group-prune. The main row's
-- bound_aid/bound_at stay the FIRST bind (v1-compatible reads).
CREATE TABLE IF NOT EXISTS service_invite_bindings (
  invite_id  TEXT NOT NULL,
  aid        TEXT NOT NULL,
  bound_at   INTEGER NOT NULL,
  PRIMARY KEY (invite_id, aid)
);

CREATE INDEX IF NOT EXISTS idx_service_invite_bindings_invite
  ON service_invite_bindings(invite_id);
