# Task 3: voi.ci calls Android + retail image (cloud session). PARTIAL: (c) vitest pending

## (a) release/0.4 @ `5ffcb2e29f5971bf0b34e212272d0e5ad8d8b0cf`, Android
`./gradlew --continue :app:compileDebugKotlin :app:assembleDebug :app:testDebugUnitTest :wear:assembleDebug` (JDK 17, SDK 36)

- `:app:compileDebugKotlin`: **PASS, no compile errors** (the new calls/, VoiciCallPush.kt, ConnectionService, VoiciCallActivity and manifest all compile)
- `:app:assembleDebug`: **PASS** (`app-debug.apk`)
- `:wear:assembleDebug`: **PASS** (`wear-debug.apk`)
- `:app:testDebugUnitTest`: 431 classes, 2975 tests, 2 failures on the first run, **both green on rerun → no real failures**:
  - `MaintainersConformanceTest > allConformanceVectors_replayToManifestVerdict`: **ENV**. The test reads `node_modules/@ibisllc/maintainers/conformance/manifest.json`, and my fresh worktree had no `npm ci` yet. Passes after `npm ci` (2/2). Worth knowing: Android unit tests need the root `node_modules`.
  - `ModelMenuComposeTest > stagedAttachmentsWithNotice` (`AppNotIdleException` at `ModelMenuComposeTest.kt:94`): **FLAKY**. Same as report 01; passes alone (8/8).

No fixes needed, so I didn't create `0.4/calls-android-cloudfix`.

## (b) 0.4/retail-image @ `502e27a399dd3ea855df4a122e7ee1965a1cd07d`, `tools/retail-vm/run.sh`
**NOT RUN: there is no KVM.** `/dev/kvm` doesn't exist in this cloud container (a gVisor-style sandbox with no nested virtualization), and `run.sh` exits 2 on that check. Stopped as instructed.

**btvirt:** Ubuntu 24.04's `bluez-test-tools` (5.72-0ubuntu5.8, a Debian-derived package) ships `/usr/bin/btvirt` (plus `man1/btvirt.1.gz`), from `dpkg -c` of the downloaded .deb. I could **not** check Debian trixie's own package directly because the sandbox proxy blocks `deb.debian.org`. It's very likely the same, since Ubuntu takes the Debian bluez packaging, but it's unverified for Debian 13.

## (c) 0.4/retail-image: vitest + Android
`npm ci` + `npx tsc -b`: PASS. Full vitest run and Android unit tests are still running; results to follow in this file.
