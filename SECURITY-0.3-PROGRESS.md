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
- SEC-LOCK-001/SEC-DEADMAN-001  durable boot suspension: protocol, storage (0107), boot worker, box, webapp, iOS, Android
- SEC-REL-001/SEC-NODE-001/SEC-INSTALL-001  signed box artifact (k-of-n, sequence, Node floor), offline verifier+installer, reproducible builder, CI workflow `box-artifact.yml`; every bootstrap (d-i, VM appliance, demo cloud-config) installs it for an exact 40-hex commit; engine, goldens, webapp/iOS/Android defaults regenerated from `release/*.json`
- SEC-UPD-001 (artifact update)  self-update downloads the signed release, installs it with the same verifier, flips one symlink; rollback and the update guard only flip back to a release on disk (no git/npm/compiler); release index `releases.json` (advice only); daemon refuses Node below the floor; release-guard fails any return to NodeSource/git/npm/Go or a branch default

- N04 recovery wait/veto: an admin's signed veto of a pending recovery decided against completion by one atomic claim (migration 0108, protocol vectors, `.com`, webapp, iOS, Android)
- SEC-RECIPE-001 offline recipe workload key: `flagship/offline-secrets/v1` commitment signed by the account key (bound to server name + serial + key hash), required by the builder (`loadBlob`) and re-verified on the box; signed by webapp, iOS and Android; Mac passes it through (vectors `test-vectors/offline-secrets`)
- N03 cloud-recovery record v2: one signature over every ciphertext digest, fetch-token/PRF-salt hashes, versions, policy, generation, nonce and the previous record's digest; explicit keep/replace/remove/none per escrow; compare-and-swap in storage (migration 0109); `.com` rejects unknown fields; clients check each ciphertext against its signed digest before unwrapping and the signature after (webapp + recovery sub-origin, iOS, Android; vectors `test-vectors/recovery-record`). A v1 row is labelled legacy until its owner's next enrolment replaces it; wipe & restart still writes a legacy row (no passphrase gate until re-enrolled)
- N05 core: grant index with parent/child revocation, epoch kept in the state dir (not app data), fail-closed on a damaged file; operation ledger (requested..applied/outcome-unknown, single-use challenge, idempotency, recheck at start and before the irreversible commit, crash recovery to outcome-unknown); hub that cancels dependent operations and stops registered work under a deadline; paired sessions, app API keys and IDE keys joined to the index (unknown or revoked = refused; revoking a parent removes the tokens)
- N07 core: authenticated clock (monotonic from an authenticated anchor, none after reboot), freshness checkpoints with forward-only high-water marks and a capped deadline, majority lease with non-overlapping grants/handover/quorum loss/singleton term, propagation lights bound to digest and replica; the app proxy drops an external session when `externalFresh` says no (not yet enabled in the daemon: no checkpoint producer exists)
- N06 partial: paired-session bearers are hashed at rest and listed by opaque id; stream upgrades refuse the session token in the URL and take a single-use ticket (30 s, bound to route and Origin, consumed atomically) or a header; webapp, iOS and Android moved off URL tokens; webapp key-material inventory ratchet
- SEC-MIG-002 partial: creator SQL runs only in a one-shot container (gVisor, app identity, read-only, no mounts, no capabilities, staging bridge, SQL on stdin, secrets in the docker client's private env, bounded time and output, no host fallback) for installs, updates and staging; a migration batch that fails rolls the code back, restores a snapshot when one exists, and otherwise records schema-ahead-of-code and stops updating; the update alert carries the authority a release adds (`capabilityDiff`)
- SEC-BROWSER-002 policy core (`browser/policy`): per-service grants with label-boundary wildcards and local-network exceptions, a per-request judge (schemes, resolved-address classification, redirect chains the browser saw, rebinding), context ownership decided before a paused target resumes, a live-URL before/after action guard; not yet wired into the manager, which stays off
- SEC-ADAPTER-002 core: signed attestations and an append-only, rollback-protected, expiring index with pinned rotating keys (protocol), and a per-service trust decision (exact digest or standing trust in attested digests, withdrawal beats acceptance, integrity cannot be clicked through) on the box; lookups stay off
- N10 honest lock wording on all three clients (a software lock at the boot service; cannot take back a copied key or data; changed software can ignore it) and a budget on the box's set-only lock writes; epoch/seq jump and overflow refusals were already in the suspension protocol. Hardware (TPM) claims are not made
- N09 archive reads bounded (entries, duplicates, sizes, expanded bytes) with hostile-archive tests
- SEC-AUTH-002 one default-deny authorization layer in front of every control-API route
- TLS/ACME with the key in keyd: TLS key + CSR + handshake signing in keyd, ACME account signing by request kind, `KeydAcmeIssuer`, `flagship-tlsd` Go frontend as a crypto.Signer, legacy-key takeover and rotation, tlsd unit + appliance check (end to end against a mock CA and real keyd)
- keyd: out-of-process custody of the box identity, workload and gossip keys (`docs/keyd.md`), opaque stand-ins, unit + migration + install, appliance unit check

## Open, in order
0. Owner/operator before release: publish the first signed artifacts (run `box-artifact.yml`, sign offline, `release-index.ts`), point `release/box-release.json` at that commit and sequence, run `node scripts/gen-box-release.mjs --write`, re-pin the bootstrap sha in userdata.test.ts. Legacy git-installed boxes cannot update in place (installer refuses a real /opt/flagship); reburn. Gym boxes need an artifact for the gym commit signed by the gym trust key.
4. N05 remainder: operation-ledger use by the update/migration/uninstall consumers, the per-service Access and permissions page (API + three clients), browser/stream/build work registration; N06 remainder (moving the account key, admin root, recovery and keyfile flows out of browser JS needs an owner decision: it removes the webapp's ability to sign; `apps/web/tests/webappKeyInventory.test.ts` ratchets the list; companion QR handoff key; CSP and postMessage review); N07 remainder (an authenticated-time source and checkpoint distribution in access sync, then switching the proxy's externalFresh gate on; lead term used by chat)
5. SEC-AUTH-002 central capability matrix + delegated companion build/deploy
6. SEC-MIG-002 remainder (production snapshot/restore wired to `snapshotData`/`restoreData`, creator-signed release manifest, canary/delay rollout, firewall rule for the migration bridge); SEC-BROWSER-002 remainder (switch BrowserManager and apiHandlers onto `browser/policy`: CDP Fetch interception, auto-attach with paused targets, phone prompts; the browser stays off until then); SEC-ADAPTER-002 remainder (publish the signed index from `.com`, the vetting pipeline, diff UI, switching `communityAdapters.lookupEnabled` on)
7. N09 restore, N11 identity pins/forks, N12 build/credential boundary
8. keyd, opaque TLS/ACME, native pin fail-closed
9. chat API (N08), N13 resources/rollout, N14 security sliver
