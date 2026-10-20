-- Where boxes' AI calls may leave through the hub (docs/outbound-hosts.md).
--
-- outbound_hosts: every host a box has asked the hub to reach, with a flag the
-- owner can flip. A host is `allowed` the first time it is seen (a new AI
-- provider just works) and stays so until the owner sets it `blocked`. Only the
-- day it was first seen is kept, not the time.
-- outbound_host_daily: per host and UTC day, how many streams, bytes each way
-- and refusals. The hub reports these in totals across every box.
--
-- Nothing here names an account, a box or a device, and there is no column that
-- could: the hub makes these calls with its own secret and sends only the host.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS outbound_hosts (
  host           TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'blocked')),
  first_seen_day TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  changed_day    TEXT
);

CREATE TABLE IF NOT EXISTS outbound_host_daily (
  day        TEXT NOT NULL,
  host       TEXT NOT NULL,
  streams    INTEGER NOT NULL DEFAULT 0,
  bytes_up   INTEGER NOT NULL DEFAULT 0,
  bytes_down INTEGER NOT NULL DEFAULT 0,
  refused    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, host)
);

-- Seeded with the providers that come baked into the apps (packages/llm-providers:
-- anthropic, openai, google, openrouter; ollama is local and never uses the hub). Every other
-- host, including Flagship's own inference host, is added the first time a box asks for it.
INSERT OR IGNORE INTO outbound_hosts (host, status, first_seen_day, note) VALUES
  ('api.anthropic.com', 'allowed', 'seed', 'baked-in provider'),
  ('api.openai.com', 'allowed', 'seed', 'baked-in provider'),
  ('generativelanguage.googleapis.com', 'allowed', 'seed', 'baked-in provider'),
  ('openrouter.ai', 'allowed', 'seed', 'baked-in provider');
