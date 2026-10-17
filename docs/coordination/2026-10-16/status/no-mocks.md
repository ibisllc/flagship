# no-mocks (paused 2026-10-16)

**Goal:** GA builds ship no mock data and no developer mode: iOS (app, watch, widgets) and the webapp.

## Landed on main
- f9553c09b Webapp: ship no developer tools at GA (webapp helper). Removed `?debug=1`, Settings DEVELOPER, the "Send order (debug)" panel; new vitest apps/web/tests/webappShipsNoDevTools.test.ts; shell v124. The web gym already had its mocks in the harness (gymKit.ts page.route).

## Saved, not landed: `wip/no-mocks-2026-10-16` (d1bcde914, 6 commits on top of main 7ca3dbfe3)
- a1b30c1d4 iOS: every Mock* client, MockOrderSigners, DemoFixtures sample pods, GymSeams/GymOrderCanonical/GymProbe, Gym/* seams, the Access control fixture, ServerShareDemo fixtures and every -smoke-* reader are `#if DEBUG`. Developer mode deleted (DeveloperSettings, DeveloperScreen, Welcome + About 3-taps, MOCK badge, Settings Developer group, SettingsRoute.developer). New: GymLaunch (Debug: usesMocks from -smoke-mode/-smoke-onboarding, -apex-host), DemoAccount (real demo-account plumbing, no sample data), DefaultClients (live defaults in Release), UnavailablePairingRelayClient.
- 9d092da68 + 74112dedb + 8001c295f: scripts/ios-release-clean.mjs (source check; `--build` / `--app` run `strings` on every Mach-O) and scripts/ios-release-clean.test.ts (vitest, CI). Also DEBUG-gated ShareCoInvitesMockBox, which landed on main meanwhile.
- 05786365e AGENTS.md GA close-out item 3 status. d1bcde914 actor-isolation fix.
- Green: `npx tsc -b`, `npx vitest run apps/web scripts` (228 files), source check clean, `swift build -c release` of apps/mobile/shared.
- NOT yet green: the iOS Release xcodebuild. Run 1 and 2 failed only on actor isolation of the passkey default (fixed in d1bcde914, unverified). Debug simulator build and gym not run yet.

## Remaining (in order)
1. S: under native-build.lock, `node scripts/ios-release-clean.mjs --build --derived-data <scratch>`; fix any Release compile errors; record the binary-scan output (expect every Mach-O "clean").
2. S/M: Debug build-for-testing (scratchpad/nomock/gym-run.sh) and fix Debug or unit-test compile errors (FlagshipMobileTests, deleted DeveloperSettingsTests).
3. M: run the mock gym on the simulator: GymSmokeTests, OnboardingSmokeTests, GymSweepSettingsTests, GymSweepShareTests (`gym-run.sh FlagshipAppUITests/<Class>`).
4. S: rebase on main (other agents edit ServerShareViewModel, WelcomeScreen, SettingsTab), rerun the source check, land with land-main.sh ("npx tsc -b && npx vitest run apps/web scripts").
5. S (optional): wire `ios-release-clean.mjs --build` into `npm run ready -- --native`.

## Decisions for the owner
- iOS Add a device / Join an account used the in-process mock relay in shipped builds, so it could never pair two devices. Release now fails at once with "Adding a device by scanning a code isn't available yet." until a /qr-pipe transport exists. Is that acceptable for GA, or should the entry be hidden?
- Release builds no longer honour `-apex-host`; the live gym must use Debug builds (it does today).

## Gym coverage
- Added: webapp "Settings has no developer tools, even with ?debug=1"; vitests for webapp and iOS sources.
- Missing: an iOS gym check that Settings/About/Welcome show no Developer entry; the Android half is another agent's.
