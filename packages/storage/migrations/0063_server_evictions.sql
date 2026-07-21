-- server_evictions — the graceful-decommission lane
-- (docs/server-replacement-graceful-decommission.md §8b).
--
-- One row per RETIRED box instance under a pod FQDN (podCanonical), holding
-- the owner-IRK-signed decommission order for that instance. The SAME table
-- serves three readers: the RETIRING box fetches its own order by its STK
-- (to consume + wind down), the SUCCESSOR fetches the full chain (every
-- retired instance for the FQDN, to hold the revoked set), and the hub
-- derives its revoked-set from that chain.
--
-- Keyed by (pod_canonical, retired_stk_pub_hex) — re-issuing the same order
-- upserts (INSERT OR REPLACE). The three ack/barrier columns track the
-- handshake: old_acked_at (retiring box consumed it), new_acked_at (successor
-- holds the chain), epoch_complete_at (the §9 final-backup epoch barrier).
-- Rows are GC'd once both sides ack (new_acked_at past its TTL); the epoch
-- barrier is recorded but does not gate GC. All hex columns are lowercase.

CREATE TABLE IF NOT EXISTS server_evictions (
  pod_canonical        TEXT NOT NULL,
  retired_stk_pub_hex  TEXT NOT NULL,
  order_json           TEXT NOT NULL,
  order_signature_hex  TEXT NOT NULL,
  issued_at            INTEGER NOT NULL,
  old_acked_at         INTEGER,
  new_acked_at         INTEGER,
  epoch_complete_at    INTEGER,
  PRIMARY KEY (pod_canonical, retired_stk_pub_hex)
);

CREATE INDEX IF NOT EXISTS idx_server_evictions_pod ON server_evictions(pod_canonical);
