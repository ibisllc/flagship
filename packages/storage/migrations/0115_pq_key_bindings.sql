-- Architecture v2 milestone 1 (docs/architecture-v2/pq-suites.md §9-§10).
--
-- pq_key_bindings: one hybrid key binding per identity (role, subject), the
--   ML-DSA-65 key an identity's Ed25519 key has bound with mutual proof of
--   possession (flagship/pq-key-binding/v1). .com verifies each against the key
--   it already trusts before storing (a box STK binding: the registered STK),
--   keeps the first ML-DSA key per Ed25519 key, and readers check
--   ed25519_pub_hex against the identity's current key.
-- server_boot_key_hybrid: the STK's hybrid signature over the boot-key binding
--   (flagship/boot-key-binding/v2), beside the v1 row in server_boot_keys.
-- assurance_policy_states: the PolicyState per scope the critical-signature
--   gate reads (packages/protocol/src/assurancePolicy.ts). No row = legacy.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS pq_key_bindings (
  role             TEXT NOT NULL,
  subject_id       TEXT NOT NULL,
  ed25519_pub_hex  TEXT NOT NULL,
  mldsa_pub_hex    TEXT NOT NULL,
  issued_at        INTEGER NOT NULL,
  signature_hex    TEXT NOT NULL,
  stored_at        INTEGER NOT NULL,
  PRIMARY KEY (role, subject_id)
);

CREATE TABLE IF NOT EXISTS server_boot_key_hybrid (
  server_domain         TEXT PRIMARY KEY,
  stk_pub_hex           TEXT NOT NULL,
  boot_key_pub_hex      TEXT NOT NULL,
  issued_at             INTEGER NOT NULL,
  hybrid_signature_hex  TEXT NOT NULL,
  stored_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assurance_policy_states (
  scope_kind     TEXT NOT NULL,
  scope_id       TEXT NOT NULL,
  profile        TEXT NOT NULL,
  rollout        TEXT NOT NULL,
  generation     INTEGER NOT NULL,
  head_digest    TEXT NOT NULL,
  enforced_ever  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id)
);
