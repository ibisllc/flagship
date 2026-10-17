# share-accept (paused 2026-10-16)
Goal: only an ADMIN device of the joining account can accept a co-manage share; the shared box enforces it; .com learns nothing new.

Design: #12 `flagship/server-share-accept-admin/v1` (serverDomain|shareId|memberPubHex|acceptedAt|keyKind|keyPubHex) signed by the joiner's admin root (IRK if it pins none), plus `.com`'s CA-signed `flagship/account-key-attestation/v1` (keyKind|keyPubHex|issuedAt|expiresAt, names no account, 14 d), sealed inside the acceptance. The box checks both against its maintainer CA chain before the first grant. Demo accounts: `.com` signs #12 with the derived demo root. Docs: share-a-server.md §2, §4, §5.1, §6, §9, §10.7; service-access-gating.md "Adding a server".

## Landed on main (all through 152c854c2)
- d8461bf2d Protocol: #12 + AccountKeyAttestation, vectors test-vectors/server-share-accept-admin, generator script
- b9d054d53 Box: first grant needs the admin proof; refusals accept-not-admin / -signature / -stale / -unverifiable (503), with sentences
- 7228a80ad .com: GET /api/users/:u/account-key-attestation, POST /api/dev/sample-user/:u/share-accept (demo signer)
- ad3ca5e72 Webapp: accept signs #12 behind one fresh unlock; non-admin sentence; owner shows box sentence; gym specs
- b4e5b5fbb Tests: co-manager invites with admin proof
- ff6211c25 Live gym `share` group: sends proof; new checks (no proof, forged, replayed, demo signer)
- a5c3d6da9 Docs, parity entry `share-accept-admin`
- c5d04de97 Webapp shell v130
- 152c854c2 AGENTS status
Checks: tsc -b + vitest (protocol, daemon shares, control-plane, apps/web, apps/com, tools/gym) green; webapp gym specs gym-share + gym-sharing 25/25 green.

## Saved, not landed
- wip/share-accept-2026-10-16 (194afcb6d): the Android port: ServerShare.kt #12/attestation/proof, ServerShareClient accept/confirm, KeystoreShareKeys, MainActivity account wiring, HomeTab sentence, MockServerShares (Studio link + proof checks), vectors test, flow tests, MockServerSharesTest, 2 gym tests + android.ts registry, parity android=present. NOT compiled or tested (lock held by another agent, disk 2.4 GB).
- wip/share-accept-ios-2026-10-16: the iOS port (helper). Not built yet: it never got native-build.lock. Still to do: build and fix, run the UI gym, land. Details in status/share-accept-ios.md.

## Remaining (in order)
1. S: Android: `./gradlew :app:compileDebugKotlin :wear:compileDebugKotlin` and fix any compile errors (ServerShareClient.kt, MockServerShares.kt, ServerShareViewModel.kt, MainActivity.kt).
2. S: Android unit tests: `:app:testDebugUnitTest --tests '*ServerShare*' --tests '*MockServerShares*'`.
3. M: Android gym: GymOctoberTest shareLinkOnANonAdminDeviceShowsTheSentence / shareLinkOnAnAdminDeviceSignsTheAcceptance on emulator-5554 (needs the deep-link launch param in GymBase).
4. S: land Android (rebase; parity android=present).
5. M/L: iOS port (helper's branch): ServerShare.swift, flows, UI sentence, vectors test, UITests, parity ios.
6. Coordinator: deploy .com, endorse a box release, gym-refresh, then run the live gym `share` group.

## Blockers / owner decisions
- The box learns the joiner's admin root PUBLIC key (never the name), a long-lived id; documented as a residual (§2). Owner may want to confirm.
- Box needs a live CA endorsement lease to accept (prod lease expires 2026-11-05); otherwise accepts answer 503 accept-unverifiable.
- The gym .com CA must match the gym boxes' pinned chain for live checks.

## Gym coverage
Added: webapp mock (admin accepts with fresh unlock, non-admin sentence, demo signer); live share group checks (written, not run). Android: 2 mock scenarios written, not run. Missing: iOS mock scenarios; Android owner-refusal is a JVM test only.
