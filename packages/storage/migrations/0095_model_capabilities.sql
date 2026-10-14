-- The capability table behind own-key AI model menus (context size, image
-- input, tool calling, reasoning efforts), rebuilt daily by the .com cron
-- from OpenRouter's public catalog (apps/com/src/inferenceModelRoutes.ts).
-- first_seen = 0 for models already listed when tracking began; the admin
-- view lists models first seen in the last two weeks. Re-runnable.
CREATE TABLE IF NOT EXISTS model_capabilities (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_capabilities_last_seen ON model_capabilities(last_seen);
