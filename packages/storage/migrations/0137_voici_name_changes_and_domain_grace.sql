-- voi.ci link-name changes record what they were (docs/named-links.md §2.6): `op` is `set` (a claim of a name) or
-- `clear`, so the account's claim budget counts claims only; `counted` is 0 for a correction made within 15 minutes
-- of a set, which the per-service limits skip. Existing rows count as counted claims (the stricter reading).
--
-- custom_domain_orders.lapsed_at: when the verifier first found an active domain outside the account's plan (the
-- subscription lapsed or shrank). The domain keeps serving for a 30-day grace, then is suspended (fail closed); back
-- within the plan clears it. NULL for every existing order.
--
-- apply-once (bare ADD COLUMN; a re-run aborts on the duplicate column, which is expected).
ALTER TABLE voici_name_changes ADD COLUMN op TEXT NOT NULL DEFAULT 'set';
ALTER TABLE voici_name_changes ADD COLUMN counted INTEGER NOT NULL DEFAULT 1;
ALTER TABLE custom_domain_orders ADD COLUMN lapsed_at INTEGER;
