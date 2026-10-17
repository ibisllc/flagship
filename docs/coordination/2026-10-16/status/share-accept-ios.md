# share-accept-ios (paused 2026-10-16)

Goal: port "only an admin device accepts a co-manage share" (#12 + attestation, docs/share-a-server.md §5.1) to iOS.

## Landed on main
- none (protocol/box/.com/webapp/docs landed earlier by the parent, 152c854c2)

## Saved, not landed
- wip/share-accept-ios-2026-10-16 (24b163967, 4fc7737b0). NOT BUILT: never got native-build.lock (held by debug-access agent); disk was 2.4 GB at start.
  - shared/FlagshipCore/ServerShare.swift: AccountKeyKind, ServerShareAcceptAdmin (#12), AccountKeyAttestation (Codable, shape-checked), ShareAcceptAdminProof, payload keeps optional `admin`
  - ServerShareClient.swift: accountKeyAttestation(), demoShareAccept(), boxGrant(acceptAdmin:), ServerShareHTTPError.acceptRefusal
  - ServerShareFlows.swift: ShareAcceptAdminKeys, member flow `admin:` + adminSigner (attestation → admin root / IRK / demo signer), .notAdminDevice sentence, owner confirm forwards acceptAdmin and throws ShareAcceptRefusal with the box sentence
  - ShareAcceptMockWorld.swift (new): mock .com + box with the real checks, for smoke routes accept-admin / owner-refused
  - FlagshipUI: ServerShareServices.acceptAdminKeys (one BiometricGate context opens admin root + caches UMK), acceptFlow, mockClient; ShareAcceptModel.canAccept; ShareAcceptScreen shows "Only an admin device of your account can accept a co-manage invitation." (share-accept-admin-only) instead of Accept; HomeTab/AddServerAdminOnlyScreen use that sentence for share links; ServerShareCopy maps accept-* refusals; demo routes accept-admin, owner-refused
  - Tests: ServerShareAcceptAdminVectorTests (shared vectors), ServerShareFlowTests (+6 tests, fake backend checks acceptAdmin), GymOctoberTests (+3), tools/gym/src/suites/ios.ts (+3), parity ios=present (parity report clean for ios)

## Remaining (ordered)
1. M: with lock + ≥5 GB disk run `bash scratchpad/sa/ios-build.sh unit` (swift test shared vectors; FlagshipMobile-Package ServerShareFlowTests/CoManagerInviteFlowTests/AddServerGateTests); fix compile errors (likely spots: jsonData concatenation in ShareAcceptancePayload, Sendable captures in adminSigner closures, `if case .acceptShare = route` in HomeTab ViewBuilder).
2. M: `bash scratchpad/sa/ios-build.sh ui` (3 new GymOctoberTests + 2 existing share tests); check owner-refused household key matches Keystore.deriveHouseholdKey in smoke mode.
3. S: squash WIP commits into a proper commit, land with land-main.sh "share-accept iOS: ..." "npx tsc -b && node scripts/parity-check.mjs --report >/dev/null"; delete .dd-ios / .swiftpm-shared.

## Blockers / owner decisions
- none; only the native-build lock and disk space.

## Gym coverage
- Added (unbuilt): ios-oct-share-accept-admin, ios-oct-share-accept-non-admin, ios-oct-share-owner-refused.
- Android port still missing entirely (parity android=missing).
