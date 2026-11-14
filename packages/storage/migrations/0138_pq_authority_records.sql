-- Quantum-safe stage 1 (docs/architecture-v2/pq-suites.md §20): the hybrid companions of admin-root
-- rotations and device capability grants. `.com` stores and relays them; boxes verify them under
-- the bindings they pin and, while strict is in force, re-pin a root or count a device only with one.
-- NULL for every existing row (classical only).
-- apply-once (bare ADD COLUMN; a re-run aborts on the duplicate column, which is expected).
ALTER TABLE admin_root_rotations ADD COLUMN pq_json TEXT;
ALTER TABLE device_capability_grants ADD COLUMN pq_signature_json TEXT;
