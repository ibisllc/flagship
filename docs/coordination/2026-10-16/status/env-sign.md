# env-sign: paused 2026-10-16

**Goal:** close the `/env/unset` replay gap with a signed `flagship/service-env-change/v1` that names exactly one variable and carries a single-use nonce, on all three clients. Also: openAccount's fallback no longer wraps the key under a random passphrase.

**Landed on main (earlier batches of this agent):** c440c8143, 315a36360, 8821df2f1, 03a34a591, 06387f46c, 660b21c75, 08d2ec0a9, d32ea2ac8, 6d735520d, 0d31cdea7, 7882fe813. None of them are part of this goal.

**Saved but not landed:** `wip/env-sign-2026-10-16` (on top of main 7882fe813)
- 76090c721: the openAccount fallback asks for the passphrase or refuses; never a random one. Vitest added. Green.
- c300e940a, protocol + box + webapp + tools. All green: tsc, vitest for apps/web, server-daemon, protocol and tools/gym, and the web gym env/inference specs.
  - New `packages/protocol/src/serviceEnvChange.ts` (`flagship/service-env-change/v1`) and its vectors.
  - Box `ServicePlatform.changeEnv`: checks the route's app and op, the value hash, freshness and the server. Nonces are spent once in `<dataDir>/data/app-env-used-nonces.json`.
  - The screens `/env/set|unset` routes and the signature-only `/api/services/:id/env` route take the new form. The old form is removed.
  - Webapp `lib/serviceEnvChange.js`, used by `service-env.js` and `vibe-code.js`.
  - live-e2e core.ts and vps-e2e updated (not run).
- 1d1e1df6b + 282ff2a79, iOS + Android ports (WIP):
  - iOS: `swift test` shared vectors green; FlagshipMobileTests (EnvSigner, MockScreensClient, ActivityViewModel) green. The UI gym `GymOctoberTests/test_serviceEnvSetsAndRemovesOneVariable` failed once on clearing the text field. I fixed it to use delete keys, but have not re-run it.
  - Android: never compiled. That covers ScreensModels.ServiceEnvChange, the mock box checks, ServiceEnvScreen/VibeCodeChatScreen/MainActivity, ServiceEnvChangeVectorsTest, MockScreensClientTest and the GymOctoberTest twin.

**Remaining work, in order:**
1. (S) Android: compile and run unit tests under `android-build.lock`. Run `:app:compileDebugKotlin :app:compileDebugAndroidTestKotlin :wear:compileDebugKotlin`, then `:app:testDebugUnitTest` for ServiceEnvChangeVectorsTest, MockScreensClientTest and ActivityViewModelTest. Fix compile errors.
2. (S) iOS: re-run the UI gym test under `native-build.lock` (`scratchpad/fu-ios-build.sh ui`).
3. (M) Android: run the emulator gym `GymOctoberTest#serviceEnvSetsAndRemovesOneVariable`.
4. (S) Squash the WIP commits into one "iOS/Android: sign service-env-change" commit.
5. (S) Bump the webapp shell (next above origin/main's) and pin it in the tests.
6. (S) Land everything together with `land-main.sh`; check: `npx tsc -b && npx vitest run apps/web packages/server-daemon packages/protocol tools/gym`.
   - Box and clients must land together: native builds that sign the old form get a 400 from a box running the new code.
7. (S) Note in AGENTS.md: the box change needs an endorsed release, and the apps need store builds.

**Blockers / owner decisions:**
- New phone builds and new boxes must ship together. Pre-release, so breaking old boxes is acceptable.
- Variable names are now restricted to `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. An AI-requested name with a dash would now be refused.

**Gym coverage:**
- Added:
  - web gym-members env scenario (signed change, name refusal, unset of one name) and the inference env card.
  - Live gym core check: set, set, unset, then a replay refused (not run).
  - iOS + Android mock gym twins (not yet green).
- Missing: both native mock-gym runs, and the live-gym run itself.
