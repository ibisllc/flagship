-- Merged per-user leftmost-label namespace uniqueness (§3.4 invariant).
-- Spec: docs/per-user-cert-and-addressing.md §3.4 + the per-user-cert
-- worklist task #25.
--
-- Under per-user addressing every public name a user serves shares ONE
-- leftmost-label space beneath `*.<user>`: APP labels (`<label>.<user>`),
-- BOX names (the per-box apex), and DEVICE labels (the v2 device-addressing
-- `<user>.<device-label>` form). They MUST be mutually unique so the
-- resolver's `--`pin → box-name → device-label → app-label precedence can
-- never have a single label mean two different things at once. This table
-- is the `.com`-side serializer of phone-signed name claims — it orders +
-- dedupes so an offline cross-box install race resolves to exactly one
-- owner per label.
--
-- ONE row per (username, label); the UNIQUE index below IS the invariant.
-- Labels are DNS labels (case-folding) — the storage adapters lower-case
-- both `username` and `label` on write so the stored form is already the
-- canonical case-insensitive key. `kind` tags which of the three sources
-- claimed the label; `ref_id` is the stable identity it maps to (an app's
-- stable-id, a box's serverId, or a device-label). A re-claim carrying the
-- IDENTICAL (kind, ref_id) is idempotent; a claim from a DIFFERENT
-- (kind, ref_id) is the "name taken" collision this invariant rejects.
--
-- Distinct from `device_capability_grants` / `routing` / the install table
-- (the three sources of truth that still own their own rows) — this is a
-- thin uniqueness ledger that spans all three, not a replacement.

CREATE TABLE IF NOT EXISTS name_claims (
  -- Account that owns the `*.<user>` namespace (stored lower-cased).
  username    TEXT NOT NULL,
  -- The claimed leftmost DNS label (stored lower-cased).
  label       TEXT NOT NULL,
  -- One of 'app' | 'box' | 'device' — which merged source claimed it.
  kind        TEXT NOT NULL,
  -- The stable identity the label resolves to (app stable-id / box serverId
  -- / device-label). Pairs with `kind` to tell an idempotent re-claim apart
  -- from a genuine collision.
  ref_id      TEXT NOT NULL,
  -- ms since epoch — when the claim was first recorded.
  claimed_at  INTEGER NOT NULL
);

-- THE invariant: at most one claim per (username, label). A second claim
-- for the same pair fails the INSERT unless the adapter recognised it as
-- an identical (kind, ref_id) re-claim first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_name_claims_username_label
  ON name_claims(username, label);

-- Drives `listForUser` (the "what names does this account own" listing).
CREATE INDEX IF NOT EXISTS idx_name_claims_username
  ON name_claims(username);
