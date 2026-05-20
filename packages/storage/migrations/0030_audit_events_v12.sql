-- v1.2 Plan B Phase 5 — extend audit_events with account-type-aware
-- columns so the /api/users/:u/audit feed can render the recovery
-- mode + quarantine state that was in effect when the event landed.
--
-- See docs/v1.2-security-cascade.md §"Phase 5 — audit + push enhancements".
--
--   account_type_at_event   Snapshot of the account's mode at insert
--                           time. NULL on pre-v1.2 rows; one of
--                           'single' | 'multi' | 'demo' from v1.2
--                           onward. The "at_event" suffix is the
--                           important bit — the account's CURRENT
--                           type can change (totp-disable flips
--                           multi → single) but the audit row must
--                           remember the type that was in effect.
--
--   quarantine_until        Set on `device-added` rows that landed
--                           under the 14-day quarantine. NULL when
--                           the event isn't device-admission-scoped.
--                           Wall-clock ms (epoch).
--
--   recovery_method         Set on re-pair-related rows so the UI
--                           can render "Recovered via TOTP" vs
--                           "Recovered via recovery code" vs
--                           "Recovered without 2FA". One of
--                           'totp' | 'recovery-code' | 'none'; NULL
--                           otherwise. The single-dash form is used
--                           on the wire to keep CSS/UI predictable.

ALTER TABLE audit_events ADD COLUMN account_type_at_event TEXT;
ALTER TABLE audit_events ADD COLUMN quarantine_until      INTEGER;
ALTER TABLE audit_events ADD COLUMN recovery_method       TEXT;
