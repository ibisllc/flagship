-- Slice D — Phase 3: the served admin-master-root ROTATION lane
-- (docs/device-admin-tier-spec.md §5, "the box must not trust `.com`").
--
-- When credential recovery mints a fresh admin master root, the OLD admin root
-- signs a `flagship/admin-root-rotation/v1` proof (old → new). `.com`'s apply
-- endpoint verifies that proof against the account's CURRENTLY-stored
-- `admin_root_pub_hex` (migration 0064), atomically swaps the stored root to
-- `new`, AND appends the signed proof here. This table is the SERVED chain: a
-- box that was offline across one or more rotations fetches the full ordered
-- sequence and REPLAYS it (old → … → new), verifying each hop against the anchor
-- it currently pins — so `.com` can relay a new authority root but can never
-- FORGE one (it holds no admin master root). The stored proof, not `.com`'s
-- word, is what re-pins the box.
--
-- One row per rotation, ordered by `seq` (1-based, append order) within an
-- account. `(username, seq)` is the PK; a per-username index serves the box
-- replay read. All hex columns are lowercase. Additive + backward-compatible:
-- accounts that never rotate simply have no rows here (and boxes with no pinned
-- admin root ignore the lane entirely).

CREATE TABLE IF NOT EXISTS admin_root_rotations (
  username                 TEXT NOT NULL,
  seq                      INTEGER NOT NULL,
  old_admin_root_pub_hex   TEXT NOT NULL,
  new_admin_root_pub_hex   TEXT NOT NULL,
  issued_at                INTEGER NOT NULL,
  signature_hex            TEXT NOT NULL,
  PRIMARY KEY (username, seq)
);

CREATE INDEX IF NOT EXISTS idx_admin_root_rotations_user
  ON admin_root_rotations(username, seq);
