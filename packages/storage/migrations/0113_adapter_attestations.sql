-- Community adapter vetting (SEC-ADAPTER-002, apps/com/src/adapterVetting.ts). Re-runnable.
--
-- adapter_attestations: every signed flagship/adapter-attestation/v1 the pipeline made, pass or
-- revoked, with the evidence its hash covers. `digest` is the SHA-256 of the canonical bytes. A
-- revoked row is final for its adapter. Nothing here names who submitted, installed or reported.
CREATE TABLE IF NOT EXISTS adapter_attestations (
  digest          TEXT PRIMARY KEY,
  adapter_sha256  TEXT NOT NULL,
  repo            TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  reason          TEXT,
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  signed_json     TEXT NOT NULL,
  evidence_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adapter_attestations_adapter ON adapter_attestations(adapter_sha256, issued_at);
CREATE INDEX IF NOT EXISTS idx_adapter_attestations_expires ON adapter_attestations(expires_at);

-- adapter_index_versions: the chain of signed flagship/adapter-index/v1 documents (the document
-- itself is in R2 at r2_key). `sequence` is the primary key so two racing publishes cannot both
-- take one number; `listed` is what the version lists, to tell whether the next one is needed.
CREATE TABLE IF NOT EXISTS adapter_index_versions (
  sequence    INTEGER PRIMARY KEY,
  digest      TEXT NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  listed      TEXT NOT NULL
);

-- adapter_complaint_sources: one row per adapter and distinct network that complained about it.
-- `source` is a keyed hash (ADAPTER_COMPLAINT_SALT) of the network and the adapter, never an
-- address; withdrawal counts these rows, not complaints. Day only, pruned with the complaints.
CREATE TABLE IF NOT EXISTS adapter_complaint_sources (
  file_sha256 TEXT NOT NULL,
  source      TEXT NOT NULL,
  day         TEXT NOT NULL,
  PRIMARY KEY (file_sha256, source)
);
CREATE INDEX IF NOT EXISTS idx_adapter_complaint_sources_day ON adapter_complaint_sources(day);
