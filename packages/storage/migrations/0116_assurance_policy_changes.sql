-- Architecture v2 milestone 2 (docs/architecture-v2/pq-suites.md §11).
--
-- assurance_policy_changes: every owner-signed AssurancePolicyChange per scope, in
--   generation order (packages/protocol/src/assurancePolicy.ts). Generation g's
--   prev_digest is generation g-1's digest (genesis: 64 zeros). .com verifies each
--   change with the critical-signature gate before appending, and appends only at
--   head + 1 (compare-and-swap on the scope's assurance_policy_states row), so the
--   chain never forks and a stale generation is refused. Boxes and clients fetch the
--   whole chain and replay it themselves from legacy; .com is a relay, not a root.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS assurance_policy_changes (
  scope_kind      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  account         TEXT NOT NULL,
  change_json     TEXT NOT NULL,
  suite           TEXT NOT NULL,
  signature_hex   TEXT NOT NULL,
  digest          TEXT NOT NULL,
  prev_digest     TEXT NOT NULL,
  stored_at       INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, generation)
);

CREATE INDEX IF NOT EXISTS assurance_policy_changes_account ON assurance_policy_changes (account);
