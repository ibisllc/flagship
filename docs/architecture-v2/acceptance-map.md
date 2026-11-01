# Acceptance scenarios → live gym checks (plan H6)

Status: 2026-11-01, `release/0.3`. Maps every acceptance scenario of journal Appendix H ("Required acceptance
scenarios", 1-11), Appendix I §8 (malicious-app tests) and Appendix I §9 (recovery and revocation, 1-10) to the live
gym group and check that runs it through the real harness, issuance service and relay. Groups live in
`tools/live-e2e/groups/release03/`; run one with `npx tsx tools/live-e2e/shared-run.ts --groups <name>`.
Check names are quoted by their prefix as they appear in the run's `<group>.json`.

New in H6: groups `relay-authority`, `relay-instances`, `phone-endpoint`; new checks in `issuance`, `serving`,
`phone-route`; simulators `tools/live-e2e/lib/boxSim.ts` (a box whose key the harness holds, on the real relay) and
the endpoint mode of `tools/live-e2e/lib/phoneSim.ts`. Unit tests: `tools/live-e2e/tests/h6Sims.test.ts`,
`tools/live-e2e/tests/boxSimRelay.test.ts` (the simulated box against the TS hub in process).

## Where the groups run

| Group | Phase | Box | Why there |
|---|---|---|---|
| `phone-route` | 4 | A1 (address only) | holds account A's bare name |
| `phone-endpoint` | 4.2, own phase | A1 (address only) | also holds A's bare name, so never beside `phone-route` |
| `serving` | 4.5 | A1 | stops A1's apps for a while; leaves A1 on no time limit |
| `app-isolation` | 9.5, alone | A1 | deploys an attacker app |
| `adversarial` | 10, alone | A1, B1 | forged orders |
| `issuance` | 10.5, alone | A1 | registers and revokes a throwaway server |
| `relay-authority` | 10.6, alone | A1 (address; its control name is briefly claimed by the simulated box) | registers and revokes two throwaway servers; ~20 min |
| `relay-instances` | 10.65, alone | A1 (address only) | skips unless `GYM_RELAY_INSTANCES` names ≥ 2 machines |
| `rust-core` | 10.7, alone | A1 | — |

None of the new groups revokes a fleet box: every revocation is of a throwaway server registered by the group.

## Appendix H, required acceptance scenarios

| # | Scenario | Group → check | What it proves | What it cannot |
|---|---|---|---|---|
| 1 | A claims B's canonical and box-local names | `app-isolation` → "H5-1 …" | a second install under B's slug is refused; an install whose manifest names B's subdomain does not get B's box-local or account-wide name; both still answer as themselves | a canonical name contested from a SECOND box (the gym runs apps on A1 only); `relay-authority` "H6/I-9" covers a whole box claiming a sibling's control name |
| 2 | A edits its `flagship.json` to B and restarts | `app-isolation` → "H5-2 …"; `rust-core` (adoption across daemon restarts) | identity and routes unchanged after the app's restart; Rust reconciler re-adopts by installation record | a box reboot between the edit and the check |
| 3 | forged Host, forwarded headers, ids, caller metadata | `app-isolation` → "H5-3 …"; `adversarial` → AT-LIVE-12, AT-LIVE-16; `rust-core` → "forged identity headers …" | SNI decides the app; forged headers stripped on the TS and Rust proxies; members-only app not opened | — |
| 4 | direct access to management, signing, keyd, issuance, relay claim | `app-isolation` → "H5-4 …"; `adversarial` → AT-LIVE-13 | no control socket, secret file, host port, box control API or metadata address reachable from inside an app | an app reaching `.com`'s issuance API over the internet is possible but useless (every order needs the box key's signature: `issuance` shows a box's own key cannot get the bare name either) |
| 5 | wildcard holder asks for the bare name, mixed orders, arbitrary DNS challenges | `issuance` → "scenario 5: …" (4 checks), "the old DNS-01 writer is closed (410)", "scenario 5: no device can publish or delete …" (new) | refused before the CA hears of it, with the admin's account wildcard grant in hand; no device-written TXT | — |
| 6 | the box claims the bare user's route | `phone-route` → "scenario 6: …"; `relay-authority` → "H6/I-9: …" (new); `issuance` → "I-9: …" (new) | a box entitled (by the account IRK) to the bare name gets no route on the real relay; the box's key and the IRK cannot claim on /phone-tunnel. The relay routes by SNI only, so a valid certificate the box might hold cannot change this | — |
| 7 | two admin phones acquire and hand over | `phone-route` → "scenario 7: …" (2 checks); `relay-instances` → "H3/H7: …" (new, multi-machine) | vacancy-only handover (owner 2026-11-01): refused `route-held` while held, release → standby claims, old holder cannot retake; new visitors follow the holder | forced foreground takeover is not the design any more; old-connection pinning across a handover is unit-tested (`apps/web/tests/phoneRoute.test.ts` "7: …") |
| 8 | disconnection, suspension, lease expiry, replay, revocation never route to a box; across relay instances | `phone-route` → "scenario 8: …" (disconnect, replay (new), revocation); `relay-instances` → "H3/H7: …" | the bare name closes, never reaches a box | suspension (tunnel silence past 45 s) and lease non-confirmation live: unit-tested only ("8: a lease that is no longer confirmed …"); multi-machine needs `GYM_RELAY_INSTANCES` |
| 9 | serving lease expires while the TLS certificate is valid; long-lived connections | `serving` → "when the last lease ends … a WebSocket held open across the end is cut, the app's certificate is still in date …" (extended); `relay-authority` → "I-1: …" (new) | real box: new requests stop and an open WebSocket is cut within the deadline while the app certificate has > 1 day left; simulated box: a held app stream is cut ≤ 10 s after `notAfter` (5 s deadline + probe), a held control stream and the tunnel stay | — |
| 10 | renewal within policy; revoked credentials, widened scope, expired grants, previous identity | `serving` (admin and delegated lease accepted, undelegated refused); `relay-authority` → "H10: …" (4 checks, new), "I-5 / H10 previous identity: …" (new) | delegated renewal works; refused: lease past the grace (admin and delegated), IRK-signed, another box, clock 10 min ahead, already ended, policy signed by a device key, renewal key of a removed device (and the relay drops its lease), earlier registration generation, old box key after the name moved | — |
| 11 | sibling web app: cookie injection, CSRF, cross-origin reads, WebSocket against the phone endpoint | `phone-endpoint` (7 checks, new) | through the real relay to a simulated phone running the apps' endpoint policy (`phoneEndpointCheck`): owner session works with a host-only `__Host-` cookie; sibling POST/preflight/upgrade refused with the cookie attached, with or without the token; planted cookies never authenticate; session fixation impossible; wrong Host refused; no CORS header ever | the iOS/Android endpoint code itself (unit tests + shared vectors); a real browser's cookie jar (the harness sends what a browser would send) |

## Appendix I §8, malicious-app tests

| Test | Group → check | Note |
|---|---|---|
| A edits its runtime `flagship.json` to B's name, restarts | `app-isolation` → "H5-2" | |
| A forges Host/forwarded headers, caller metadata, routing requests, namespace advertisements | `app-isolation` → "H5-3", "H5-4"; `relay-authority` → "H6/I-9" | an app has no relay channel at all (H5-4); a whole box, stronger than an app, cannot advertise foreign names |
| A requests the control route or the bare phone route | `app-isolation` → "H5-1" (another app's names); `relay-authority` → "H6/I-9" | an app manifest naming the box's control name or the bare name as its alias is not tried live (the allocator's reserved names are unit-tested) |
| A reaches management credentials, keyd, certificate APIs, relay signing | `app-isolation` → "H5-4"; `adversarial` → AT-LIVE-13 | |
| A attempts cross-origin management against the control and phone endpoints | `phone-endpoint` (phone); `adversarial` → AT-LIVE-09, -10, -14 (sessions, Remote scope, upgrade tokens on the box) | a sibling-origin CSRF against the box's control API from a browser is not a live check |

## Appendix I §9, recovery and revocation

| # | Scenario | Group → check | What it cannot |
|---|---|---|---|
| 1 | lease expires, certificates and tunnel valid: app routes stop, app streams close ≤ 5 s, control continues | `serving` (real box, WebSocket); `relay-authority` → "I-1" | |
| 2 | after expiry the exact control certificate is issued; wildcards, extra SANs, another box, phone name refused | `relay-authority` → "I-2" (refusals), "I-2 … is issued (one real order)" | the real order spends one certificate of the gym's Let's Encrypt budget per run (a fresh name) |
| 3 | explicit revocation ends control and app access incl. long-lived streams on every relay instance within 65 s; push and dropped push | `relay-authority` → "I-3" (one machine, pushed); `relay-instances` → "H8/I-3" (box on machine 2, reconnect refused on every machine); `lifecycle` (real box, `.com` side) | dropped pushes / a partitioned machine: skipped (needs a fault switch on the gym relay; unit-tested in `servingFeedClient.test.ts`, `servingGate.test.ts`) |
| 4 | a revoked box keeps its valid certificate: no new route, no reconnect, no issuance | `relay-authority` → "I-4"; `issuance` → "cleanup: revoke …" | |
| 5 | replay status assertions, leases, claims, renewal credentials; reused hostname with a new key | `relay-authority` → "I-4" (HELLO replay), "I-5 …" (new key or owner un-revoke), "I-5 / H10 previous identity", "I-8" (old lease and old policy replayed), "H10 …"; `phone-route` → "scenario 8: replay …" | status assertions no longer exist (owner 2026-10-31: pushed revocation, H8); the feed's signed-entry checks are unit-tested |
| 6 | revocation races issuance and reconnect; late certificates enter the CA-revocation queue | `relay-authority` → "I-6" | the CA-revocation queue is not observable from outside (no route reads it); the check fails if a certificate is DELIVERED after the revocation |
| 7 | phone away past the grace: recovery continues; stop central status: both classes fail closed | first half: `serving`, `relay-authority` → "I-1" (control answers after the lapse) | second half skipped: needs a fault switch that cuts the gym relay's feed (unit-tested: `servingGate.test.ts` "refuses new tunnels after 60 s … closes every tunnel after 10 min", `tunnelHubServing.test.ts` "answers try-again") |
| 8 | policy reductions, indefinite, clock rollback, restart, failover, multi-relay cache expiry | `relay-authority` → "I-8 …" (2 checks), "H10 …" (clock 10 min ahead); `relay-instances` → "I-8 …" | relay restart and failover between machines mid-lease are not run live |
| 9 | wildcard holder: bare-user issuance via DNS or mixed names, then a phone route | `issuance` → "scenario 5 …", "I-9 …"; `relay-authority` → "H6/I-9" | |
| 10 | effective CAA; issuance from an unapproved ACME account refused in a controlled test zone | `issuance` → "I-10 …" (reads the CAA: every record pinned to an account and DNS-01, this service's account listed; skips until the owner's CAA step is done) | the unapproved-account rejection needs a controlled test zone with its own CAA (never the production zone or its limits): not built |

## What the release manager sets to run the skipped ones

- **Multi-instance** (`relay-instances`; H scenario 8 "across instances", I-3 "every relay instance", I-8 "multi-relay"):
  `flyctl scale count 2 -a flagship-services-gym`, then
  `GYM_RELAY_INSTANCES="$(flyctl machines list -a flagship-services-gym --json | jq -r '[.[].id] | join(",")')"`
  in the runner's environment (Fly machine ids; the group pins tunnels with `fly-force-instance-id`). Scale back after
  if the gym should stay on one machine.
- **Serving authority** (every new group): the gym `.com` serves `/api/serving/revocation-key`
  (`SERVING_REVOCATION_SEED`), the gym relay has `FLAGSHIP_SERVING_REVOCATION_PUB` and `SERVICES_CONTROL_SECRET`; the
  phone route is on (not `FLAGSHIP_PHONE_ROUTE=off`).
- **Issuance** (`issuance`, `relay-authority` I-2/I-6): `ISSUANCE_ACME_ACCOUNT_KEY` on the gym Worker.
- **CAA** (`issuance` I-10): the apex CAA step in `docs/runbooks/final-deploy.md` "Certificate issuance".
- **Still not runnable live** (need a gym-only fault switch nobody has built): a relay machine missing the revocation
  push, and the relay losing contact with `.com`'s feed. Both are unit-tested; adding them means a gym-only relay
  setting that drops the feed connection, refused in production.
