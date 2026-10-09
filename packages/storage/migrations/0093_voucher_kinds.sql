-- Voucher kinds (docs/naming-recovery-and-name-change.md §6, decided 2026-10-09).
--
-- The anonymous voucher rail (0052) only ever granted a Pro tier. Two
-- single-use entitlements ride the same rail: a $10 name change and a $20 dibs
-- claim. They carry no tier/duration (left as "free"/0) and are consumed by
-- the name-change endpoint, never by the tier redeem path.
ALTER TABLE vouchers ADD COLUMN kind TEXT NOT NULL DEFAULT 'tier';
