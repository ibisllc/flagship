-- One push-token row per (account, device, platform, provider token). Two registrations of the same token that
-- raced (FCM's onNewToken and the Settings switch, 13 ms apart) each inserted a row, so the device got every push
-- twice. Duplicates already stored are dropped, keeping the oldest row (its token id and quarantine stamps), and a
-- unique index makes the registration upsert converge on one row.
--
-- Re-runnable: the delete finds nothing once the index exists, and the index uses IF NOT EXISTS.
DELETE FROM push_tokens
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM push_tokens GROUP BY username, device_id, platform, provider_token
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_one_per_token ON push_tokens(username, device_id, platform, provider_token);
