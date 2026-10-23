# 0.3 security-hardening progress (branch `release/0.3`)

Working tracker for `SECURITY-HARDENING-PLAN.md`. Squashed away with the rest of the
branch history before review. Owner decisions (2026-10-22): install path goes straight
to the signed offline artifact; lock/dead-man ships on every client at once; scope is
everything that is testable in software (keyd, opaque TLS/ACME, chat API included;
TPM/measured boot only as far as software can prove).

## Done (committed and pushed)
- SEC-MIG-001  creator updates manual, script migrations refused (updateClient/runMigration/servicePlatform)
- SEC-AUTH-001 owner-only gate on /api/build, /api/llm/sessions, identity rotate, app backups, build/tab websockets; companion sessions ended once on first boot
- SEC-ADAPTER-001 community adapters not published (.com) nor looked up (box); code switches
- SEC-BROWSER-001 app browser off in code, compose service removed, shared profile deleted at boot
- SEC-MAC-001  helper pinned to Team ID; image/log/disk validated by the helper (12 XCTests)
- N02/E01      one byte-level address classifier in @flagship/protocol, used by egress proxy and provider guard
- N02/E04      git clone pinned to checked addresses, no redirects/hooks/helpers, minimal env
- N01/E02/E03  control API on Node's strict parser (controlHttp.ts): one dispatch, framing refusals, caps
- SEC-UPD-001  no npm install fallback in update or rollback guard

## Open, in order
1. SEC-LOCK-001/SEC-DEADMAN-001  durable boot suspension (+ iOS, Android, webapp)
2. SEC-REL / SEC-NODE / SEC-INSTALL / SEC-BOOTSTRAP  signed offline box artifact, Node 24.22.1+, exact commit+digest recipes
3. SEC-RECIPE-001 raw swkHex sibling (box ignores it; needs signed offline carrier) -- left alone so far: gym + advanced/offline mode use it
4. N03 signed recovery record; N04 recovery wait/veto; N05 transactions/revocation; N06 keyless web; N07 freshness/lead
5. SEC-AUTH-002 central capability matrix + delegated companion build/deploy
6. SEC-MIG-002 migration sandbox; SEC-BROWSER-002 per-app contexts + grants; SEC-ADAPTER-002 attested index
7. N09 restore, N11 identity pins/forks, N12 build/credential boundary
8. keyd, opaque TLS/ACME, native pin fail-closed
9. chat API (N08), N13 resources/rollout, N14 security sliver
