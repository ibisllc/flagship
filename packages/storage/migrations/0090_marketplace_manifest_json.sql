-- Carry the app's public manifest JSON on the marketplace listing.
--
-- Blocker-1 (feat/marketplace) — the install path was forked: the webapp
-- expected the listing to CARRY the manifest while the mobile clients tried
-- to fetch it from the pod. Resolution (option A): store the manifest JSON on
-- the listing (it is public app config, not a secret). The listing already
-- commits to `manifest_hash_hex`; .com verifies `manifest_hash_hex ==
-- sha256(manifest_json)` at listing-write time, and every install client
-- re-checks the same hash before installing. This keeps the IRK signature
-- byte-identical (manifest_json is NOT part of the canonical bytes).
--
-- Numbered 0090 (not 0083–0089): main is at 0082 and those numbers are
-- reserved for main's next organic allocations while feature branches park in
-- a far block. See packages/control-plane/src/schemaStatus.ts.

ALTER TABLE marketplace_listings ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '';
