# co-invite-native (paused 2026-10-16)

Goal: port co-manager invites to iOS + Android (then: per-IDE MCP configs on both).

## Landed on main
- 4182ce862 iOS: let a co-manager invite people from a shared server's app (+ Swift vectors, owner-side display, 3 mock gym scenarios, parity ios present)

## Saved, not landed: wip/co-invite-native-2026-10-16 (rebased on origin/main ~17:30)
1. 30cd31db7 Android co-invites (twin of iOS; Kotlin vectors; owner side; smoke world gets Cabin at Can view; 3 gym tests; parity android present)
2. 4fe43b944 iOS Connect your IDE: per-IDE configs (picker, where, Copy command, user-settings warning, .withoutEscapingSlashes; unit + gym test; parity ios present)
3. b09613837 Android Connect your IDE: same (unit + gym test; parity android present)
4. 259b16354 Docs: AGENTS.md + service-access-gating.md say iOS/Android are done
None of 1-3 has been compiled yet (no Gradle run got the android lock; the iOS IDE commit was never built).
parity-check: no co-manager / ide-configs reds; npx tsc -b + tools/gym vitest green before the pause.

## Remaining (in order)
1. S  Android: `./gradlew :app:compileDebugKotlin :wear:compileDebugKotlin :app:compileDebugAndroidTestKotlin`, fix any errors
      (new: core/ShareCoInvites.kt, ui/screens/CoInviteSection.kt, viewmodels/CoInviteViewModel.kt, MockServerShares.kt, BuildModeScreens.kt, MockBuildClient.kt)
2. S  Android unit tests: CoManagerInviteVectorsTest, CoManagerInviteFlowTest, MockServerSharesTest (Cabin added), BuildMcpIdeConfigTest, ServiceAccess*, SharedServerScreenComposeTest
3. M  Android mock gym on emulator (ANDROID_SERIAL=emulator-5554 only, never the real phone): GymOctoberTest#coManager*, #sharedServerCoManagerView (count now 4), GymTotalTest#buildMcpIdeConfigs
4. S  iOS IDE: xcodebuild test FlagshipMobile-Package -only-testing BuildMcpIdeConfigTests; GymTotalDetailTests/test_buildMcpIdeConfigs on the simulator
5. S  Land commits 1, 4 (after 1-3 green), then 2 and 3, with land-main.sh
6. S  If manual-tests.md lists the IDE-config check, tick it

## Blockers / owner decisions
- None. Lock contention was the only holdup.

## Gym coverage
- Added: ios-oct-share-co-manager-{invites,demoted,view-only} (passing), android-oct-share-co-manager-{invites,demoted,view-only} (not run),
  ios-total-build-mcp-ide-configs, android-total-build-mcp-ide-configs (not run).
- Missing: live-gym check of a co-manager invite redeemed on a real shared box (tools/live-e2e "share" group).
