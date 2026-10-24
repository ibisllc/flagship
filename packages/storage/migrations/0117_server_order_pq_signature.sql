-- Architecture v2 milestone 4 (docs/architecture-v2/pq-suites.md §13.6): the owner's
-- hybrid signature beside the server order's classical one. `.com` keeps it opaque and
-- serves it with the order; boxes in a strict installation require it and verify it
-- under the signer's PQ binding themselves. NULL = the order was signed classically only.
ALTER TABLE server_orders ADD COLUMN pq_signature_json TEXT;
