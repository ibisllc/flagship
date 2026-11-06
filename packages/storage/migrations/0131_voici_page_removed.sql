-- voi.ci: the owner's "Remove my page" (flagship/voici-page-remove/v1; docs/voici-and-messages.md §3.3, code in
-- packages/control-plane/src/voiciPages.ts handleVoiciRemove). The page row stays (username, page_id, and seq = the
-- removal's seq, so neither the removal nor an old index can be replayed); `removed_at` marks it gone from voi.ci
-- until a publish at seq + 1 clears it. Additive: NULL for every existing page.
--
-- APPLY-ONCE (bare ALTER TABLE ADD COLUMN): a re-run fails with "duplicate column name", which is expected, not a
-- failure. Apply it before the `.com` deploy that reads the column.
ALTER TABLE voici_pages ADD COLUMN removed_at INTEGER;
