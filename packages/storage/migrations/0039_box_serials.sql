-- Branded-tier box serials (N-CLOUD-1/2/3).
--
-- One row per manufactured box, allocated at production time. The
-- retailer "activates" the row at the point of sale, then on first
-- ownership claim the row is bound to the box's STK pubkey + 6-hex
-- suffix (used for LAN disambiguation per the NFC pairing design).
--
-- See:
--   - docs/nfc-box-pairing.md
--   - docs/v1-operational-tasks.md § N-CLOUD
--
-- Q1 in the locked decisions: defer online-sales activation gate. v1
-- treats activation as a *retailer-recorded* state — the actual
-- "in-store-only" enforcement is via the retailer's POS terminal
-- holding the shared HMAC secret. First-claim still requires
-- `activated_at IS NOT NULL` for any branded SKU.

CREATE TABLE IF NOT EXISTS box_serials (
  serial         TEXT PRIMARY KEY,
  sku            TEXT NOT NULL,
  -- Null until the retailer marks the box activated at PoS.
  activated_at   INTEGER,
  -- Free-text identifier the retailer included with the activation
  -- request (e.g. store id, register #). Audit/observability only.
  activated_by   TEXT,
  -- Populated on first successful ownership claim. Binding is one-shot:
  -- once stk_pub_hex is set, attempts to bind a different one are
  -- rejected (a re-pair after BoxUnpair binds the SAME stkPub again
  -- since the box rebuilds it from the same persisted material; if the
  -- physical key material is lost — full RESET — the serial is
  -- effectively burned).
  stk_pub_hex    TEXT,
  -- Last 6 hex of stk_pub_hex. Denormalized so the rendezvous lookup
  -- can be an index-only scan.
  suffix6        TEXT,
  bound_at       INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_box_serials_sku
  ON box_serials(sku);

CREATE INDEX IF NOT EXISTS idx_box_serials_suffix6
  ON box_serials(suffix6)
  WHERE suffix6 IS NOT NULL;
