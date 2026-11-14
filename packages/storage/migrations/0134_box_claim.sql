-- Retail box claims (docs/retail-box-setup.md §4 step 8, §15.1; code in packages/control-plane/src/boxClaim.ts).
--
-- box_claim_keys: the box key a phone saw in the claim receipt, registered under the AuthCode before the phone sends
-- the Wi-Fi password. `/api/server/register` then accepts this AuthCode's server only under `stk_pub_hex`, so a relay's
-- real box is refused. One row per AuthCode serial, first write wins. Nothing about the hardware is stored.
--
-- box_claim_mailbox: the blind mailbox of a remote claim. `mailbox_id` is SHA-256 of the box's setup code under its own
-- tag; `.com` never sees the code and cannot derive the handshake key from the id. `body` is opaque handshake and
-- AES-GCM record bytes (base64). A mailbox lives an hour from its first message; expired rows are swept.
--
-- Re-runnable: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS box_claim_keys (
  serial         TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  server_domain  TEXT NOT NULL,
  stk_pub_hex    TEXT NOT NULL,
  signer_pub_hex TEXT NOT NULL,
  issued_at      INTEGER NOT NULL,
  recorded_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS box_claim_mailbox (
  mailbox_id TEXT NOT NULL,
  dir        TEXT NOT NULL CHECK (dir IN ('to-box', 'to-phone')),
  seq        INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, dir, seq)
);
CREATE INDEX IF NOT EXISTS idx_box_claim_mailbox_expires ON box_claim_mailbox(expires_at);
