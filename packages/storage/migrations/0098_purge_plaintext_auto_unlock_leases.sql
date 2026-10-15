-- The plaintext auto-unlock lease (flagship/auto-unlock-lease/v1) is gone:
-- `.com` no longer accepts, lists or releases it, and boxes only fetch the
-- box-sealed lease (box_sealed_leases). Rows here held disk keys `.com` could
-- read, so they're erased rather than left to expire.
DELETE FROM auto_unlock_leases;
