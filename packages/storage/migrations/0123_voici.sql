-- voi.ci pages and Messages on `.com` (docs/voici-and-messages.md §2.8, §3, §5.2, §7.3, §8.3, §9.1, §10.1;
-- code in packages/storage/src/voici.ts, packages/control-plane/src/voiciPages.ts and voiciMailbox.ts,
-- apps/com/src/voiciRoutes.ts). Attestation counters, reports, bans and takedown records are chunk B2's (0124).
--
-- Re-runnable: every statement is CREATE ... IF NOT EXISTS.
--
-- Nothing here maps a pseudonym to an account (§6.3): messages carry only the pseudonym key, the page and the
-- sealed envelope. Message bodies are end-to-end sealed; `.com` never opens them.

-- One row per published page: the last accepted signed index (R2 holds only the current object). `seq` moves by
-- exactly one per publish (compare-and-set). `page_id` never changes. A takedown keeps the row and refuses
-- publishes until restored.
CREATE TABLE IF NOT EXISTS voici_pages (
  username         TEXT PRIMARY KEY,
  page_id          TEXT NOT NULL UNIQUE,
  seq              INTEGER NOT NULL,
  issued_at        INTEGER NOT NULL,
  accepts_messages INTEGER NOT NULL CHECK (accepts_messages IN (0, 1)),
  inbox_epoch      INTEGER NOT NULL,
  owner_sign_pub   TEXT NOT NULL,
  index_json       TEXT NOT NULL,
  published_at     INTEGER NOT NULL,
  taken_down_at    INTEGER,
  takedown_reason  TEXT
);

-- Every uploaded piece, hashed by `.com` on upload. `unreferenced_at` is NULL while the current index lists the
-- piece; a piece no index has listed for 30 days is deleted from R2 and here by the cron. `role` and `image_refs`
-- remember a JSON piece's parse under the role it was published as (pieces are immutable), so a publish parses
-- only pieces it has not seen in that role.
CREATE TABLE IF NOT EXISTS voici_pieces (
  page_id         TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  username        TEXT NOT NULL,
  size            INTEGER NOT NULL,
  jpeg            INTEGER NOT NULL CHECK (jpeg IN (0, 1)),
  uploaded_at     INTEGER NOT NULL,
  unreferenced_at INTEGER,
  role            TEXT,
  image_refs      TEXT,
  PRIMARY KEY (page_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_voici_pieces_unreferenced ON voici_pieces(unreferenced_at) WHERE unreferenced_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voici_pieces_user ON voici_pieces(username, uploaded_at);

-- The mailbox: signed envelopes (voici-message and voici-reply), sealed end to end. `id` is the cursor both the
-- owner's inbox and a visitor's thread page by. `fetched_at`: an owner device fetched it ("Delivered"); `direct`:
-- the owner's phone took it directly and forwarded it ("Delivered to their phone"). `delegate_pub`: the browser key a
-- voici-message was signed with (NULL for a reply), so a pseudonym can sign that key out. Kept 180 days (D6).
CREATE TABLE IF NOT EXISTS voici_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    TEXT NOT NULL,
  conv       TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('voici-message', 'voici-reply')),
  from_pub   TEXT NOT NULL,
  delegate_pub TEXT,
  sent_at    INTEGER NOT NULL,
  envelope   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  direct     INTEGER NOT NULL DEFAULT 0,
  pushed     INTEGER NOT NULL DEFAULT 0,
  stored_at  INTEGER NOT NULL,
  fetched_at INTEGER,
  UNIQUE (conv, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_voici_messages_page ON voici_messages(page_id, id);
CREATE INDEX IF NOT EXISTS idx_voici_messages_conv ON voici_messages(conv, id);
CREATE INDEX IF NOT EXISTS idx_voici_messages_stored ON voici_messages(stored_at);
CREATE INDEX IF NOT EXISTS idx_voici_messages_delegate ON voici_messages(delegate_pub) WHERE delegate_pub IS NOT NULL;

-- The owner's signed block orders (§9.1), newest issuedAt wins. `op = 'unblock'` also marks the conversation
-- accepted, which lifts the awaiting-reply cap (§9.4).
CREATE TABLE IF NOT EXISTS voici_blocks (
  page_id       TEXT NOT NULL,
  pseudonym_pub TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('block', 'unblock')),
  issued_at     INTEGER NOT NULL,
  signature     TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (page_id, pseudonym_pub)
);

-- Browser keys signed out by their pseudonym (§6.4), refused until the delegation's own expiry.
CREATE TABLE IF NOT EXISTS voici_revoked_delegates (
  delegate_pub  TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL,
  principal_pub TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voici_revoked_page ON voici_revoked_delegates(page_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_voici_revoked_expiry ON voici_revoked_delegates(expires_at);

-- Sealed draft ops from non-admin devices (§5.2), until an admin device publishes and consumes them (kept 30 days).
CREATE TABLE IF NOT EXISTS voici_drafts (
  username   TEXT NOT NULL,
  op_id      TEXT NOT NULL,
  device_pub TEXT NOT NULL,
  envelope   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (username, op_id)
);
CREATE INDEX IF NOT EXISTS idx_voici_drafts_created ON voici_drafts(created_at);

-- The owner's sealed Messages state blob (§10.1): version compare-and-set.
CREATE TABLE IF NOT EXISTS messages_state (
  username   TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
