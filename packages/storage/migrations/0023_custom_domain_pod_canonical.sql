-- Custom-domain serving pod (#87 / Phase 3).
--
-- The Phase-4 verifier, on confirming a CNAME, records WHICH pod
-- canonical serves the fqdn so `.services` cold-start (#87) can
-- reconstruct the full fqdn→pod redirection set after a restart
-- (the .services redirection table is RAM-only by design). NULL
-- until the verifier confirms (status still 'pending'/'failed').
--
-- Pre-launch: no production rows, so the ALTER is non-destructive.

ALTER TABLE custom_domain_orders ADD COLUMN pod_canonical TEXT;
